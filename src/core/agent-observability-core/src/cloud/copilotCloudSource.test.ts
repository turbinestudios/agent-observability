import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudSink, freshIndex } from './cloudSink';
import { CopilotCloudSource } from './copilotCloudSource';
import { CloudConfig } from './cloudTypes';

/**
 * `CopilotCloudSource` unit tests over a REAL temp-dir {@link CloudSink} (no
 * `vscode`, no network — the source only reads the sink the poller would have
 * written). Mirrors `../telemetry/repositoryExclusion.test.ts`'s
 * exclusion-across-surfaces structure and reuses the `task-detail.json` /
 * `session-log.sse` fixtures so the derived metrics (turns, tools, tokens,
 * credits) are exercised end-to-end through `sseParser` + `cloudMapper`.
 */

// ---- fixtures + derived constants ----

const taskDetailFixture = readFileSync(path.resolve(__dirname, './fixtures/task-detail.json'), 'utf8');
const sessionLogFixture = readFileSync(path.resolve(__dirname, './fixtures/session-log.sse'), 'utf8');

const TASK_A = 'b540b8ca-1111-2222-3333-444455556666';
const SESSION_A = '0b7c2a4e-5d1f-4e8a-9c63-2f4d8e1a7b90';
const REPO_A = 'https://github.com/example-org/repo-a';
const PROMPT_A = 'Implement the requested feature: add a retry with backoff to the API client.';
/** `usage.credits` from the fixture (raw nano-credits). */
const CREDITS_A = 33570585000;

const TASK_B = 'task-b-00000000';
const SESSION_B = 'sess-b-11111111';
const REPO_B = 'https://github.com/example-org/repo-b';
const CREDITS_B = 1000000000;

/** A second task with NO session log — exercises the metadata-only path. */
const taskBRaw = JSON.stringify({
  id: TASK_B,
  name: 'Fix the flaky retry test',
  state: 'completed',
  session_count: 1,
  created_at: '2026-07-06T09:00:00.000Z',
  updated_at: '2026-07-06T09:00:20.000Z',
  completed_at: '2026-07-06T09:00:20.000Z',
  sessions: [
    {
      id: SESSION_B,
      name: 'Fix the flaky retry test',
      prompt: 'Fix the flaky retry test in the client suite.',
      model: 'sweagent-capi:claude-haiku-4.5',
      state: 'completed',
      created_at: '2026-07-06T09:00:00.000Z',
      updated_at: '2026-07-06T09:00:20.000Z',
      completed_at: '2026-07-06T09:00:20.000Z',
      error: null,
      usage: { credits: CREDITS_B, type: 'ai_credits' },
    },
  ],
});

/** Fixed wall-clock so non-terminal duration math (unused here — both terminal) is stable. */
const NOW = Date.parse('2026-07-07T12:00:00.000Z');
const clock = () => NOW;

// ---- temp-dir lifecycle ----

const createdDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-cloud-'));
  createdDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- config getter-bag ----

function makeConfig(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    isCopilotCloudEnabled: () => true,
    getCopilotCloudAccounts: () => [],
    getCopilotCloudGhCliPath: () => 'gh',
    getCopilotCloudIdlePollMs: () => 60_000,
    getCopilotCloudActivePollMs: () => 10_000,
    getCopilotCloudScope: () => 'my-tasks',
    getCopilotCloudRetentionMs: () => 30 * 24 * 60 * 60 * 1000,
    getCopilotCloudMaxTasks: () => 100,
    getExcludedRepositories: () => new Set<string>(),
    ...overrides,
  };
}

/** Seed a sink with task A (fixture, incl. SSE log) + task B (inline, no log). */
function seedFullSink(dir: string): CloudSink {
  const sink = new CloudSink(dir);
  sink.writeTaskRaw(TASK_A, taskDetailFixture);
  sink.writeSessionLog(SESSION_A, sessionLogFixture);
  sink.writeTaskRaw(TASK_B, taskBRaw);

  const index = freshIndex();
  index.watermarkMs = Date.parse('2026-07-07T10:01:32.000Z');
  index.poller.firstPollCompleted = true;
  index.poller.lastPollAtMs = Date.parse('2026-07-07T11:00:00.000Z');
  index.poller.accounts = [{ login: 'octocat', lastOutcome: 'ok', authSource: 'gh' }];
  index.tasks = {
    [TASK_A]: {
      taskId: TASK_A,
      account: 'octocat',
      repository: REPO_A,
      state: 'completed',
      sessionIds: [SESSION_A],
      updatedAtMs: Date.parse('2026-07-07T10:01:32.000Z'),
      terminal: true,
    },
    [TASK_B]: {
      taskId: TASK_B,
      account: 'octocat',
      repository: REPO_B,
      state: 'completed',
      sessionIds: [SESSION_B],
      updatedAtMs: Date.parse('2026-07-06T09:00:20.000Z'),
      terminal: true,
    },
  };
  sink.writeIndex(index);
  return sink;
}

// ---------------------------------------------------------------------------

describe('CopilotCloudSource (seeded, enabled)', () => {
  let source: CopilotCloudSource;

  beforeAll(() => {
    source = new CopilotCloudSource(makeConfig(), seedFullSink(mkTemp()), clock);
  });

  it('listSessions surfaces both seeded sessions as copilot-cloud, newest first', () => {
    const r = source.listSessions();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((s) => s.sessionId)).toEqual([SESSION_A, SESSION_B]);
      expect(r.value.every((s) => s.source === 'copilot-cloud')).toBe(true);
      // Session A's derived counters come from the fixture SSE (5 turns, 2 tools).
      const a = r.value.find((s) => s.sessionId === SESSION_A)!;
      expect(a.repository).toBe(REPO_A);
      expect(a.llmCalls).toBe(5);
      expect(a.toolCalls).toBe(2);
      expect(a.interactionCount).toBe(7);
      expect(a.model).toBe('claude-sonnet-4.6');
    }
  });

  it('listRepositories groups the seeded sessions by repository', () => {
    const r = source.listRepositories();
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Sorted by last activity desc: repo-a (07-07) before repo-b (07-06).
      expect(r.value.map((x) => x.repository)).toEqual([REPO_A, REPO_B]);
      const a = r.value.find((x) => x.repository === REPO_A)!;
      expect(a.sessionCount).toBe(1);
      expect(a.interactionCount).toBe(7);
      expect(a.models).toEqual(['claude-sonnet-4.6']);
    }
  });

  it('getOverview aggregates interactions, repositories and models across sessions', () => {
    const r = source.getOverview();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalSessions).toBe(2);
      expect(r.value.totalRepositories).toBe(2);
      expect(r.value.totalModels).toBe(2);
      expect(r.value.totalInteractions).toBe(7);
      // Token buckets are populated only from the fixture session's `usage` chunk.
      expect(r.value.inputTokens).toBe(700);
      expect(r.value.outputTokens).toBe(200);
      expect(r.value.cachedTokens).toBe(300);
    }
  });

  it('getSessionDetail returns the tool timeline and creditsNano', () => {
    const r = source.getSessionDetail(SESSION_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.value;
      expect(d.summary.source).toBe('copilot-cloud');
      expect(d.treeStats.creditsNano).toBe(CREDITS_A);
      expect(d.treeStats.aiuNano).toBe(0);
      expect(d.treeStats.toolCalls).toBe(2);
      expect(d.treeStats.modelTurns).toBe(5);
      expect(d.turns).toHaveLength(1);
      // Timeline carries every invocation (setup + real tools), chronologically.
      const events = d.turns[0].events;
      expect(events.map((e) => e.toolName)).toEqual(['run_setup', 'view', 'edit', 'run_setup']);
      const edit = events.find((e) => e.toolName === 'edit')!;
      expect(edit.operation).toBe('execute_tool');
      expect(edit.success).toBe(false); // the role:tool result flagged is_error
    }
  });

  it('getSessionInteractions returns a chat interaction plus one per non-setup tool', () => {
    const r = source.getSessionInteractions(SESSION_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(3); // 1 chat + view + edit (setups excluded)
      expect(r.value[0].operation).toBe('chat');
      expect(r.value.slice(1).map((i) => i.operation)).toEqual(['execute_tool', 'execute_tool']);
      expect(r.value.slice(1).map((i) => i.toolName)).toEqual(['view', 'edit']);
      const edit = r.value.find((i) => i.toolName === 'edit')!;
      expect(edit.success).toBe(false);
      expect(r.value.every((i) => i.repository === REPO_A)).toBe(true);
    }
  });

  it('getSessionContent(copilot_chat.user_request) returns the prompt map', () => {
    const r = source.getSessionContent(SESSION_A, 'copilot_chat.user_request');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.size).toBe(1);
      expect(r.value.get(SESSION_A)).toBe(PROMPT_A);
    }
  });

  it('getSessionContent(other attribute) returns an empty map', () => {
    const r = source.getSessionContent(SESSION_A, 'gen_ai.output.messages');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.size).toBe(0);
    }
  });

  it('getAggregationRows returns [] (cloud sessions are local-only through Phase 3)', () => {
    expect(source.getAggregationRows()).toEqual({ ok: true, value: [] });
  });
});

// ---------------------------------------------------------------------------

describe('CopilotCloudSource repository exclusion', () => {
  let unfiltered: CopilotCloudSource;
  let filtered: CopilotCloudSource;

  beforeAll(() => {
    const sink = seedFullSink(mkTemp());
    unfiltered = new CopilotCloudSource(makeConfig(), sink, clock);
    // Exclude repo-a — the repository that owns ALL the interactions/tokens — so
    // the overview shrinks observably.
    filtered = new CopilotCloudSource(
      makeConfig({ getExcludedRepositories: () => new Set([REPO_A]) }),
      sink,
      clock,
    );
  });

  it('baseline: the unfiltered source reports the excluded-to-be repository', () => {
    const repos = unfiltered.listRepositories();
    expect(repos.ok && repos.value.some((r) => r.repository === REPO_A)).toBe(true);
    const sessions = unfiltered.listSessions();
    expect(sessions.ok && sessions.value.some((s) => s.repository === REPO_A)).toBe(true);
  });

  it('omits the excluded repository from listRepositories', () => {
    const repos = filtered.listRepositories();
    expect(repos.ok).toBe(true);
    if (repos.ok) {
      expect(repos.value.map((r) => r.repository)).toEqual([REPO_B]);
    }
  });

  it('omits the excluded repository from session listings', () => {
    const all = filtered.listSessions();
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.some((s) => s.repository === REPO_A)).toBe(false);
      expect(all.value.map((s) => s.sessionId)).toEqual([SESSION_B]);
    }
    // Asking for the excluded repository directly yields an EMPTY ok result.
    const direct = filtered.listSessions(REPO_A);
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      expect(direct.value).toEqual([]);
    }
  });

  it('shrinks the overview consistently with the unfiltered baseline', () => {
    const full = unfiltered.getOverview();
    const partial = filtered.getOverview();
    expect(full.ok && partial.ok).toBe(true);
    if (full.ok && partial.ok) {
      expect(partial.value.totalRepositories).toBe(full.value.totalRepositories - 1);
      expect(partial.value.totalSessions).toBeLessThan(full.value.totalSessions);
      expect(partial.value.totalInteractions).toBeLessThan(full.value.totalInteractions);
    }
  });
});

// ---------------------------------------------------------------------------

describe('CopilotCloudSource disabled', () => {
  let source: CopilotCloudSource;

  beforeAll(() => {
    source = new CopilotCloudSource(
      makeConfig({ isCopilotCloudEnabled: () => false }),
      seedFullSink(mkTemp()),
      clock,
    );
  });

  it('every Result method returns { ok:false, reason:"disabled" } even with data on disk', () => {
    const results = [
      source.getOverview(),
      source.listRepositories(),
      source.listSessions(),
      source.getSessionDetail(SESSION_A),
      source.getSessionInteractions(SESSION_A),
      source.getSessionContent(SESSION_A, 'copilot_chat.user_request'),
      source.getAggregationRows(),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('disabled');
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('CopilotCloudSource poll-failure surfacing', () => {
  /** No tasks + a single unauthenticated account. */
  function emptyFailingSource(): CopilotCloudSource {
    const sink = new CloudSink(mkTemp());
    const index = freshIndex();
    index.poller.firstPollCompleted = true;
    index.poller.accounts = [
      { login: 'user-x', lastOutcome: 'unauthenticated', lastErrorMessage: 'token expired', authSource: 'gh' },
    ];
    index.tasks = {};
    sink.writeIndex(index);
    return new CopilotCloudSource(makeConfig(), sink, clock);
  }

  it('listSessions / listRepositories surface the account failure when there is no data', () => {
    const source = emptyFailingSource();

    const sessions = source.listSessions();
    expect(sessions.ok).toBe(false);
    if (!sessions.ok) {
      expect(sessions.reason).toBe('unauthenticated');
      expect(sessions.message).toBe('token expired');
    }

    const repos = source.listRepositories();
    expect(repos.ok).toBe(false);
    if (!repos.ok) {
      expect(repos.reason).toBe('unauthenticated');
    }
  });

  it('getOverview surfaces the account failure when there is nothing to show', () => {
    const source = emptyFailingSource();
    const overview = source.getOverview();
    expect(overview.ok).toBe(false);
    if (!overview.ok) {
      expect(overview.reason).toBe('unauthenticated');
    }
  });

  it('a failing account never hides another account’s data when a session exists', () => {
    const sink = seedFullSink(mkTemp());
    const index = sink.readIndex();
    index.poller.accounts = [
      { login: 'ok-user', lastOutcome: 'ok', authSource: 'gh' },
      { login: 'bad-user', lastOutcome: 'unauthenticated', authSource: 'gh' },
    ];
    sink.writeIndex(index);
    const source = new CopilotCloudSource(makeConfig(), sink, clock);

    const sessions = source.listSessions();
    expect(sessions.ok).toBe(true);
    if (sessions.ok) {
      expect(sessions.value.length).toBe(2);
    }
    const overview = source.getOverview();
    expect(overview.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('CopilotCloudSource mtime cache', () => {
  let source: CopilotCloudSource;
  let readTaskRawCalls = 0;

  beforeAll(() => {
    const dir = mkTemp();
    const sink = new CloudSink(dir);
    sink.writeTaskRaw(TASK_A, taskDetailFixture);
    sink.writeSessionLog(SESSION_A, sessionLogFixture);
    const index = freshIndex();
    index.poller.firstPollCompleted = true;
    index.poller.accounts = [{ login: 'u', lastOutcome: 'ok', authSource: 'gh' }];
    index.tasks = {
      [TASK_A]: {
        taskId: TASK_A,
        account: 'u',
        repository: REPO_A,
        state: 'completed',
        sessionIds: [SESSION_A],
        updatedAtMs: Date.parse('2026-07-07T10:01:32.000Z'),
        terminal: true,
      },
    };
    sink.writeIndex(index);

    // Count raw-payload reads: they happen only on a cache MISS (loadSummaries →
    // taskDetail), so they are the discriminator between a reuse and a recompute.
    const origRead = sink.readTaskRaw.bind(sink);
    (sink as { readTaskRaw: (id: string) => string | undefined }).readTaskRaw = (id: string) => {
      readTaskRawCalls++;
      return origRead(id);
    };
    source = new CopilotCloudSource(makeConfig(), sink, clock);
  });

  it('reuses the summary cache across calls without an index change, and refresh() drops it', () => {
    source.listSessions();
    const afterFirst = readTaskRawCalls;
    expect(afterFirst).toBeGreaterThan(0);

    // Second call, same index mtime → cache hit → no re-read of the raw payload.
    source.listSessions();
    expect(readTaskRawCalls).toBe(afterFirst);

    // refresh() drops the cache → the next call re-reads the raw payload.
    source.refresh();
    source.listSessions();
    expect(readTaskRawCalls).toBeGreaterThan(afterFirst);
  });
});
