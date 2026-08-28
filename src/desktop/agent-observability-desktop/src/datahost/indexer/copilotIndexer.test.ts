import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SettingsReader } from '@agent-observability/core/src/config/configuration';
import type { PathEnvironment } from '@agent-observability/core/src/telemetry/paths';
import { CopilotIndexer } from './copilotIndexer';
import { IndexDb } from './indexDb';

/**
 * The Copilot indexer against a synthetic database in Copilot's own schema.
 *
 * The behavior that matters most is what it leaves OUT. Copilot's spans table
 * groups plenty of things that are not sessions — tool-call ids, and the
 * conversation ids minted by chat helpers — and listing them buries the real
 * work. On one real machine that was 435 rows for 47 sessions.
 */

let root: string;
let sourceDb: string;
let indexPath: string;
let db: IndexDb;

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_HELPER = '99999999-8888-4777-8666-555555555555';

function settings(values: Record<string, unknown>): SettingsReader {
  return {
    get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function makeConfig(over: Record<string, unknown> = {}): Configuration {
  return new Configuration(
    settings({
      sqlitePath: sourceDb,
      'localTelemetry.enabled': true,
      // Point the archive somewhere absent so the fixture is what gets read.
      'copilotArchive.path': path.join(root, 'no-archive.db'),
      ...over,
    }),
  );
}

interface SpanInput {
  span_id: string;
  conversation_id?: string | null;
  chat_session_id?: string | null;
  operation_name: string;
  response_model?: string | null;
  agent_name?: string | null;
  start_time_ms?: number;
  end_time_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
}

/** Build a database matching the shape the indexer queries. */
function writeSourceDb(
  spans: SpanInput[],
  attributes: [string, string, string][] = [],
  dbPath = sourceDb,
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const source = new Database(dbPath);
  source.exec(`
    CREATE TABLE spans (
      span_id TEXT PRIMARY KEY,
      conversation_id TEXT,
      chat_session_id TEXT,
      operation_name TEXT,
      response_model TEXT,
      request_model TEXT,
      agent_name TEXT,
      start_time_ms INTEGER,
      end_time_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER
    );
    CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);
  `);
  const insert = source.prepare(`
    INSERT INTO spans (span_id, conversation_id, chat_session_id, operation_name, response_model,
                       agent_name, start_time_ms, end_time_ms, input_tokens, output_tokens, cached_tokens)
    VALUES (@span_id, @conversation_id, @chat_session_id, @operation_name, @response_model,
            @agent_name, @start_time_ms, @end_time_ms, @input_tokens, @output_tokens, @cached_tokens)
  `);
  for (const span of spans) {
    insert.run({
      conversation_id: null,
      chat_session_id: null,
      response_model: 'gpt-4o',
      agent_name: 'copilot',
      start_time_ms: 1_000,
      end_time_ms: 2_000,
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 1,
      ...span,
    });
  }
  const attr = source.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)');
  for (const [spanId, key, value] of attributes) {
    attr.run(spanId, key, value);
  }
  source.close();
}

/** `<userData>/User/workspaceStorage`, where VS Code keeps per-workspace state. */
let workspaceStorage: string;

/**
 * A workspace store: the folder it points at, and the chat sessions held there.
 * Only filenames matter — the repository comes from the folder's git remote.
 */
function writeWorkspaceStore(hash: string, folder: string, sessionIds: string[]): void {
  const hashDir = path.join(workspaceStorage, hash);
  fs.mkdirSync(path.join(hashDir, 'chatSessions'), { recursive: true });
  fs.writeFileSync(
    path.join(hashDir, 'workspace.json'),
    JSON.stringify({ folder: `file:///${folder.replace(/^\/+/, '')}` }),
  );
  for (const id of sessionIds) {
    fs.writeFileSync(path.join(hashDir, 'chatSessions', `${id}.json`), '{}');
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copilot-'));
  // The native layout, so the workspaceStorage sibling is derivable from the
  // database path the way it is on a real machine.
  const userDir = path.join(root, 'User');
  const globalStorage = path.join(userDir, 'globalStorage', 'github.copilot-chat');
  fs.mkdirSync(globalStorage, { recursive: true });
  workspaceStorage = path.join(userDir, 'workspaceStorage');
  fs.mkdirSync(workspaceStorage, { recursive: true });

  sourceDb = path.join(globalStorage, 'agent-traces.db');
  indexPath = path.join(root, 'index.db');
  db = new IndexDb(indexPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function run(
  config = makeConfig(),
  gitRemote?: { resolve(p: string): string },
  environment?: PathEnvironment,
) {
  return new CopilotIndexer({ db, config, gitRemote, environment }).run();
}

/**
 * A platform where auto-detection finds the stable and Insiders databases
 * under the temp root, so multi-database behavior tests without touching the
 * real machine. Linux layout purely because it derives from one env var.
 */
function fakePlatform(): { environment: PathEnvironment; stable: string; insiders: string } {
  const relative = path.join('User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
  return {
    stable: path.join(root, 'Code', relative),
    insiders: path.join(root, 'Code - Insiders', relative),
    environment: {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: root },
      homedir: () => root,
      statKind: (candidate) => {
        try {
          return fs.statSync(candidate).isFile() ? 'file' : 'absent';
        } catch {
          return 'absent';
        }
      },
    },
  };
}

describe('what counts as a session', () => {
  it('indexes a chat session keyed by a UUID', () => {
    writeSourceDb([
      { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' },
      { span_id: 's2', chat_session_id: UUID_A, operation_name: 'execute_tool' },
    ]);

    const result = run();
    expect(result.hydrated).toBe(1);

    const [row] = db.listSessions({ source: 'copilot' });
    expect(row.sessionId).toBe(UUID_A);
    expect(row.interactionCount).toBe(2);
    expect(row.llmCalls).toBe(1);
    expect(row.toolCalls).toBe(1);
  });

  it('excludes tool-call ids that appear in chat_session_id', () => {
    writeSourceDb([
      { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' },
      { span_id: 's2', chat_session_id: 'toolu_01MtZjSgV8fWBuVz42xMJgAd', operation_name: 'chat' },
    ]);

    run();
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual([UUID_A]);
  });

  it('includes an autonomous run keyed only by conversation id', () => {
    writeSourceDb([
      { span_id: 's1', conversation_id: UUID_B, operation_name: 'invoke_agent' },
      { span_id: 's2', conversation_id: UUID_B, operation_name: 'execute_tool' },
    ]);

    run();
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual([UUID_B]);
  });

  it('excludes chat-helper traffic that never invokes an agent', () => {
    // Commit-message and title generators look like conversations but only
    // ever produce chat spans. They are the bulk of the noise.
    writeSourceDb([
      { span_id: 's1', conversation_id: UUID_B, operation_name: 'invoke_agent' },
      { span_id: 's2', conversation_id: UUID_HELPER, operation_name: 'chat' },
    ]);

    run();
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual([UUID_B]);
  });

  it('excludes a session whose only chat spans are inline suggestions', () => {
    writeSourceDb([
      { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat', response_model: 'copilot-suggestions' },
      { span_id: 's2', chat_session_id: UUID_B, operation_name: 'chat', response_model: 'gpt-4o' },
    ]);

    run();
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual([UUID_B]);
  });
});

describe('session content', () => {
  it('sums tokens across chat spans only', () => {
    writeSourceDb([
      { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat', input_tokens: 100, output_tokens: 50, cached_tokens: 20 },
      { span_id: 's2', chat_session_id: UUID_A, operation_name: 'execute_tool', input_tokens: 999, output_tokens: 999 },
    ]);

    run();
    const [row] = db.listSessions({ source: 'copilot' });
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.cachedTokens).toBe(20);
  });

  it('spans the session from its first start to its last end', () => {
    writeSourceDb([
      { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat', start_time_ms: 5_000, end_time_ms: 6_000 },
      { span_id: 's2', chat_session_id: UUID_A, operation_name: 'chat', start_time_ms: 1_000, end_time_ms: 9_000 },
    ]);

    run();
    const [row] = db.listSessions({ source: 'copilot' });
    expect(row.startedAtMs).toBe(1_000);
    expect(row.endedAtMs).toBe(9_000);
    expect(row.durationMs).toBe(8_000);
  });

  it('resolves the repository from span attributes', () => {
    writeSourceDb(
      [{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }],
      [['s1', 'copilot_chat.repo.remote_url', 'git@github.com:acme/app.git']],
    );

    run();
    // Sanitizing normalizes an ssh remote to its https form and drops `.git`.
    expect(db.listSessions({ source: 'copilot' })[0].repository).toBe('https://github.com/acme/app');
  });

  it('prefers the most recent remote when a session was re-pointed', () => {
    writeSourceDb(
      [
        { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat', start_time_ms: 1_000 },
        { span_id: 's2', chat_session_id: UUID_A, operation_name: 'chat', start_time_ms: 9_000 },
      ],
      [
        ['s1', 'copilot_chat.repo.remote_url', 'https://github.com/acme/old.git'],
        ['s2', 'copilot_chat.repo.remote_url', 'https://github.com/acme/new.git'],
      ],
    );

    run();
    expect(db.listSessions({ source: 'copilot' })[0].repository).toBe('https://github.com/acme/new');
  });

  it('falls back to unknown when nothing knows the repository', () => {
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    run();
    expect(db.listSessions({ source: 'copilot' })[0].repository).toBe('unknown');
  });

  it('derives cost from the billed AIU on chat spans — 2 AIU is $0.02', () => {
    writeSourceDb(
      [
        { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' },
        { span_id: 's2', chat_session_id: UUID_A, operation_name: 'chat' },
      ],
      [
        ['s1', 'copilot_chat.copilot_usage_nano_aiu', '1500000000'],
        ['s2', 'copilot_chat.copilot_usage_nano_aiu', '500000000'],
      ],
    );

    run();
    // 2 AIU × $0.01/AIU = $0.02 = 20,000 micro-USD.
    expect(db.listSessions({ source: 'copilot' })[0].costMicros).toBe(20_000);
  });

  it('leaves a session with no AIU attribute unpriced — n/a, not free', () => {
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    run();
    expect(db.listSessions({ source: 'copilot' })[0].costMicros).toBeUndefined();
  });

  it('ignores AIU recorded on non-chat spans', () => {
    writeSourceDb(
      [
        { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' },
        { span_id: 's2', chat_session_id: UUID_A, operation_name: 'execute_tool' },
      ],
      [
        ['s1', 'copilot_chat.copilot_usage_nano_aiu', '1000000000'],
        ['s2', 'copilot_chat.copilot_usage_nano_aiu', '9000000000'],
      ],
    );

    run();
    // Only the chat span's 1 AIU counts: $0.01 = 10,000 micro-USD.
    expect(db.listSessions({ source: 'copilot' })[0].costMicros).toBe(10_000);
  });

  it('keeps a recorded zero as a genuine $0.00, distinct from untracked', () => {
    writeSourceDb(
      [{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }],
      [['s1', 'copilot_chat.copilot_usage_nano_aiu', '0']],
    );
    run();
    expect(db.listSessions({ source: 'copilot' })[0].costMicros).toBe(0);
  });

  it('resolves from the workspace store when the spans carry no attribute', () => {
    // Copilot records the repository on a span only sometimes. Without this
    // fallback a whole organisation's sessions read as "unknown" even though
    // the workspace they ran in names the folder plainly.
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    writeWorkspaceStore('hash-1', '/work/portal', [UUID_A]);

    run(makeConfig(), { resolve: (p) => (p.endsWith('portal') ? 'https://github.com/acme/portal' : 'unknown') });

    expect(db.listSessions({ source: 'copilot' })[0].repository).toBe('https://github.com/acme/portal');
  });

  it('prefers the span attribute over the workspace store', () => {
    // The session's own recorded remote is the more specific answer: a
    // workspace folder can be re-pointed or hold sessions from elsewhere.
    writeSourceDb(
      [{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }],
      [['s1', 'copilot_chat.repo.remote_url', 'https://github.com/acme/from-span.git']],
    );
    writeWorkspaceStore('hash-1', '/work/portal', [UUID_A]);

    run(makeConfig(), { resolve: () => 'https://github.com/acme/from-workspace' });

    expect(db.listSessions({ source: 'copilot' })[0].repository).toBe('https://github.com/acme/from-span');
  });

  it('survives a workspace store it cannot read', () => {
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    writeWorkspaceStore('hash-1', '/work/portal', [UUID_A]);

    // A folder on a stopped WSL distro throws rather than returning nothing.
    expect(() =>
      run(makeConfig(), {
        resolve: () => {
          throw new Error('UNC path unavailable');
        },
      }),
    ).not.toThrow();
    expect(db.listSessions({ source: 'copilot' })).toHaveLength(1);
  });

  it('hides sessions in an excluded repository', () => {
    writeSourceDb(
      [{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }],
      [['s1', 'copilot_chat.repo.remote_url', 'https://github.com/acme/secret.git']],
    );

    run(makeConfig({ excludedRepositories: ['https://github.com/acme/secret'] }));
    expect(db.listSessions({ source: 'copilot' })).toEqual([]);
  });
});

describe('resilience', () => {
  it('reports rather than throws when no database exists', () => {
    const result = run(makeConfig({ sqlitePath: path.join(root, 'absent.db') }));
    expect(result.hydrated).toBe(0);
    expect(result.skipped).toBeDefined();
  });

  it('reports rather than throws when the file is not a Copilot database', () => {
    const other = new Database(sourceDb);
    other.exec('CREATE TABLE unrelated (a INTEGER)');
    other.close();

    const result = run();
    expect(result.hydrated).toBe(0);
    expect(result.skipped).toContain('spans');
  });

  it('does nothing when the Copilot source is disabled', () => {
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    const result = run(makeConfig({ 'localTelemetry.enabled': false }));
    expect(result).toMatchObject({ discovered: 0, hydrated: 0 });
    expect(db.listSessions({ source: 'copilot' })).toEqual([]);
  });

  it('never writes to the database it reads', () => {
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    const before = fs.statSync(sourceDb).mtimeMs;

    run();

    expect(fs.statSync(sourceDb).mtimeMs).toBe(before);
    // A write would leave a journal or WAL behind next to it.
    expect(fs.existsSync(`${sourceDb}-journal`)).toBe(false);
  });

  it('drops sessions that disappeared from the source', () => {
    writeSourceDb([
      { span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' },
      { span_id: 's2', chat_session_id: UUID_B, operation_name: 'chat' },
    ]);
    run();
    expect(db.listSessions({ source: 'copilot' })).toHaveLength(2);

    fs.rmSync(sourceDb);
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }]);
    run();

    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual([UUID_A]);
  });
});

describe('multiple VS Code installs', () => {
  it('merges sessions from every database found, not just the first', () => {
    // A machine with stable and Insiders side by side: sessions live in both,
    // and reading only the first database would silently drop half of them.
    const { environment, stable, insiders } = fakePlatform();
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }], [], stable);
    writeSourceDb([{ span_id: 's2', chat_session_id: UUID_B, operation_name: 'chat' }], [], insiders);

    const result = run(makeConfig({ sqlitePath: undefined }), undefined, environment);

    expect(result.hydrated).toBe(2);
    expect(result.sourcePath).toContain(stable);
    expect(result.sourcePath).toContain(insiders);
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId).sort()).toEqual(
      [UUID_A, UUID_B].sort(),
    );
  });

  it('an unreadable first database does not hide the second', () => {
    const { environment, stable, insiders } = fakePlatform();
    fs.mkdirSync(path.dirname(stable), { recursive: true });
    fs.writeFileSync(stable, 'this is not a sqlite database');
    writeSourceDb([{ span_id: 's1', chat_session_id: UUID_A, operation_name: 'chat' }], [], insiders);

    const result = run(makeConfig({ sqlitePath: undefined }), undefined, environment);

    expect(result.hydrated).toBe(1);
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual([UUID_A]);
  });

  it('says so when a database was found but holds no sessions yet', () => {
    // Found-but-empty is a different first-run situation from not-found, and
    // silence here left new users unable to tell whether the wiring worked.
    writeSourceDb([]);

    const result = run();

    expect(result.hydrated).toBe(0);
    expect(result.skipped).toContain('no agent sessions yet');
  });
});
