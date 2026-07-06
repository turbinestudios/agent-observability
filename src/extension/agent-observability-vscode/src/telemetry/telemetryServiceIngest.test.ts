import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { PathEnvironment } from './paths';
import { IngestStore } from '../otel/ingestStore';
import { flattenSpans } from '../otel/otlpParse';
import { otlpSpansToRows } from '../otel/otlpToRows';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const SESSION = 'ingest-sess';

const envelope = {
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat',
              spanId: 'c1',
              traceId: 't1',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.agent.name', value: sv('copilot') },
                { key: 'gen_ai.conversation.id', value: sv(SESSION) },
                { key: 'gen_ai.usage.input_tokens', value: iv(42) },
                { key: 'copilot_chat.user_request', value: sv('hi') },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** A config + environment that find NO Copilot DB, so only the ingest source can apply. */
const config: ServiceConfig = {
  isLocalTelemetryEnabled: () => true,
  getCodeFileExtensions: () => [],
  getDocFileExtensions: () => [],
  getSqlitePathOverride: () => undefined,
};
const noCopilotEnv: PathEnvironment = {
  platform: 'win32',
  env: {},
  homedir: () => '',
  statKind: () => 'absent',
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('TelemetryService with a live-OTLP ingest source', () => {
  it('reads the extension-owned ingest DB as the sole source', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-svc-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    store.close();

    const service = new TelemetryService(config, noCopilotEnv);

    // Without an ingest source, no Copilot DB exists → a typed failure (not a throw).
    expect(service.getSessionInteractions(SESSION).ok).toBe(false);

    // Point it at our ingest DB → it becomes the sole source and reads our spans.
    service.setIngestDbPath(dbPath);
    const result = service.getSessionInteractions(SESSION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].operation).toBe('chat');
      expect(result.value[0].inputTokens).toBe(42);
    }
    service.dispose();
  });
});

/** A one-chat-span session envelope for the given session id. */
function envelopeFor(session: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `c-${session}`,
                traceId: `tr-${session}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'gen_ai.conversation.id', value: sv(session) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('TelemetryService with a durable archive source', () => {
  it('reads the archive as the sole source when set and present, else falls back', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arc-'));
    const archivePath = path.join(tmp, 'agent-traces.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('arch-sess'))));
    store.close();

    const service = new TelemetryService(config, noCopilotEnv);
    // No archive set + no Copilot DB → typed failure.
    expect(service.getSessionInteractions('arch-sess').ok).toBe(false);

    service.setArchiveDbPath(archivePath);
    expect(service.getSessionInteractions('arch-sess').ok).toBe(true);
    service.dispose();
  });

  it('prefers the live-ingest DB over the archive when both are set', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arc-'));
    const archivePath = path.join(tmp, 'archive.db');
    const ingestPath = path.join(tmp, 'ingest.db');

    const arc = new IngestStore(archivePath);
    arc.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('arch-only'))));
    arc.close();
    const ing = new IngestStore(ingestPath);
    ing.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('live-only'))));
    ing.close();

    const service = new TelemetryService(config, noCopilotEnv);
    service.setArchiveDbPath(archivePath);
    service.setIngestDbPath(ingestPath);

    // Live-ingest is the SOLE source → its session has interactions; the
    // archive-only session is invisible (a source is open, so the lookup
    // succeeds with an empty result rather than failing).
    const live = service.getSessionInteractions('live-only');
    expect(live.ok && live.value.length > 0).toBe(true);
    const arch = service.getSessionInteractions('arch-only');
    expect(arch.ok && arch.value.length === 0).toBe(true);
    service.dispose();
  });
});

const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444';

/**
 * A one-chat-span envelope shaped like a HUMAN-INITIATED Copilot session: a
 * UUID `chat_session_id`, a `copilot_chat.user_request` span, and a real chat
 * model — the shape `listSessions` requires a session to have.
 */
function titledEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `c-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'gen_ai.conversation.id', value: sv(uuid) },
                  { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
                  { key: 'gen_ai.response.model', value: sv('gpt-x') },
                  { key: 'copilot_chat.user_request', value: sv('hello there') },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Write a minimal `state.vscdb` with the chat-session index row. */
function writeStateDb(wsDir: string, entries: Record<string, string>): void {
  const built: Record<string, unknown> = {};
  for (const [key, title] of Object.entries(entries)) {
    built[key] = { sessionId: key, title, isEmpty: false };
  }
  mkdirSync(wsDir, { recursive: true });
  const db = new Database(path.join(wsDir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [
    'chat.ChatSessionStore.index',
    JSON.stringify({ version: 1, entries: built }),
  ]);
  db.close();
}

/** The session summary listed for `id`, or undefined. */
function listedSession(service: TelemetryService, id: string) {
  const result = service.listSessions();
  expect(result.ok).toBe(true);
  return result.ok ? result.value.find((s) => s.sessionId === id) : undefined;
}

describe('session titles when the archive is the read source', () => {
  it('resolves titles from the NATIVE workspaceStorage even though the archive has no sibling store', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-title-'));
    // The native candidate layout — only the TITLE stores exist; the native
    // telemetry DB itself is gone (rotated out), which must not matter.
    const appData = path.join(tmp, 'Roaming');
    writeStateDb(path.join(appData, 'Code', 'User', 'workspaceStorage', 'hashA'), {
      [UUID_A]: 'Fix the login flow',
    });
    const archivePath = path.join(tmp, 'archive.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(titledEnvelopeFor(UUID_A))));
    store.close();

    const env: PathEnvironment = {
      platform: 'win32',
      env: { APPDATA: appData },
      homedir: () => '',
      statKind: () => 'absent', // no native DB anywhere → archive stays the sole source
    };
    const service = new TelemetryService(config, env);
    service.setArchiveDbPath(archivePath);

    const session = listedSession(service, UUID_A);
    expect(session?.title).toBe('Fix the login flow');
    expect(session?.titleDerived).toBe(false);
    service.dispose();
  });

  it('falls back to titles ARCHIVED in the session_titles sidecar when no native store remains', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-title-'));
    const archivePath = path.join(tmp, 'archive.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(titledEnvelopeFor(UUID_A))));
    store.writeSessionTitles(new Map([[UUID_A, { title: 'Archived name', derived: false }]]), 1);
    store.close();

    const service = new TelemetryService(config, noCopilotEnv); // no candidates at all
    service.setArchiveDbPath(archivePath);

    const session = listedSession(service, UUID_A);
    expect(session?.title).toBe('Archived name');
    expect(session?.titleDerived).toBe(false);
    service.dispose();
  });

  it('a live native title (e.g. a rename) overrides the archived one', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-title-'));
    const appData = path.join(tmp, 'Roaming');
    writeStateDb(path.join(appData, 'Code', 'User', 'workspaceStorage', 'hashA'), {
      [UUID_A]: 'Renamed by the user',
    });
    const archivePath = path.join(tmp, 'archive.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(titledEnvelopeFor(UUID_A))));
    store.writeSessionTitles(new Map([[UUID_A, { title: 'Stale archived name', derived: false }]]), 1);
    store.close();

    const env: PathEnvironment = {
      platform: 'win32',
      env: { APPDATA: appData },
      homedir: () => '',
      statKind: () => 'absent',
    };
    const service = new TelemetryService(config, env);
    service.setArchiveDbPath(archivePath);

    expect(listedSession(service, UUID_A)?.title).toBe('Renamed by the user');
    service.dispose();
  });
});

const UUID_TOOL = 'a1111111-1111-2222-3333-444444444444';
const UUID_SUGG = 'b1111111-1111-2222-3333-444444444444';
const UUID_FALLBACK = 'c1111111-1111-2222-3333-444444444444';
const UUID_SYNTH = 'd1111111-1111-2222-3333-444444444444';
const WS_REPO = 'https://github.com/org/workspace-repo';

/**
 * A session whose ONLY span is a tool call — a UUID `chat_session_id`, no
 * `conversation.id`, no `user_request`, no repo. This is the shape the FIRST
 * span of a fresh chat typically has, arriving seconds before the first
 * `user_request`. The relaxed gate must surface it.
 */
function toolOnlyEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'execute_tool',
                spanId: `x-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('execute_tool') },
                  { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A session whose only chat span is an inline SUGGESTION — must stay excluded. */
function suggestionOnlyEnvelopeFor(uuid: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `s-${uuid}`,
                traceId: `tr-${uuid}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'copilot_chat.chat_session_id', value: sv(uuid) },
                  { key: 'gen_ai.response.model', value: sv('copilot-suggestions') },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Build a service backed solely by an ingest DB holding the given envelope. */
function serviceForIngest(env: object): TelemetryService {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-gate-'));
  const dbPath = path.join(tmp, 'agent-traces.db');
  const store = new IngestStore(dbPath);
  store.writeSpans(otlpSpansToRows(flattenSpans(env)));
  store.close();
  const service = new TelemetryService(config, noCopilotEnv);
  service.setIngestDbPath(dbPath);
  return service;
}

describe('relaxed session gate + workspace-scoped context', () => {
  it('surfaces a started session that has a span but NO user_request', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_TOOL));
    const session = listedSession(service, UUID_TOOL);
    expect(session).toBeDefined();
    expect(session?.toolCalls).toBe(1);
    expect(session?.llmCalls).toBe(0);
    service.dispose();
  });

  it('still excludes a suggestion-only session under the relaxed gate', () => {
    const service = serviceForIngest(suggestionOnlyEnvelopeFor(UUID_SUGG));
    expect(listedSession(service, UUID_SUGG)).toBeUndefined();
    service.dispose();
  });

  it('groups a repo-less started session under the workspace repo via the scoped fallback', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_FALLBACK));

    // Before any context is supplied, the session has no discoverable repo.
    expect(listedSession(service, UUID_FALLBACK)?.repository).toBe('unknown');

    service.setWorkspaceSessionContext({
      repository: WS_REPO,
      sessionIds: new Set([UUID_FALLBACK]),
      recent: [],
    });

    expect(listedSession(service, UUID_FALLBACK)?.repository).toBe(WS_REPO);

    // The workspace repo is now a filterable node, and the session lands under it.
    const repos = service.listRepositories();
    expect(repos.ok && repos.value.some((r) => r.repository === WS_REPO)).toBe(true);
    const scoped = service.listSessions(WS_REPO);
    expect(scoped.ok && scoped.value.some((s) => s.sessionId === UUID_FALLBACK)).toBe(true);
    service.dispose();
  });

  it('synthesizes a spanless store session, and a real telemetry row is not duplicated', () => {
    const service = serviceForIngest(toolOnlyEnvelopeFor(UUID_FALLBACK));
    service.setWorkspaceSessionContext({
      repository: WS_REPO,
      sessionIds: new Set([UUID_FALLBACK, UUID_SYNTH]),
      recent: [
        { sessionId: UUID_SYNTH, startedAtMs: 1_700_000_500_000, title: 'Draft chat', titleDerived: true },
        { sessionId: UUID_FALLBACK, startedAtMs: 1_700_000_400_000, title: 'Has telemetry', titleDerived: true },
      ],
    });

    // The spanless store session appears as a zero-metric placeholder with its
    // store title, grouped under the workspace repo.
    const synth = listedSession(service, UUID_SYNTH);
    expect(synth).toBeDefined();
    expect(synth?.repository).toBe(WS_REPO);
    expect(synth?.interactionCount).toBe(0);
    expect(synth?.toolCalls).toBe(0);
    expect(synth?.title).toBe('Draft chat');

    // The session that DOES have telemetry keeps its real row (toolCalls === 1)
    // and is not duplicated by a synthetic placeholder.
    const result = service.listSessions();
    const fallbackRows = result.ok ? result.value.filter((s) => s.sessionId === UUID_FALLBACK) : [];
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0].toolCalls).toBe(1);
    service.dispose();
  });
});
