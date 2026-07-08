import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudAgentPoller } from './cloudAgentPoller';
import { CloudSink } from './cloudSink';
import type { CloudApiClient, CloudApiResult, ConditionalTaskDetail } from './cloudApiClient';
import type { GhAuth, AuthResult } from './ghAuth';
import type { WriterLease, WriterLeaseClock } from '../otel/writerLease';
import {
  CloudAccountAuth,
  CloudConfig,
  RawCloudTask,
  RawCloudTaskDetail,
} from './cloudTypes';

// A poll runs the poller against fakes for auth/client and a real temp-dir sink.
// Timers are never started (we call pollOnce() directly); the lease is created
// lazily, so an injected leaseFactory controls leader election deterministically.

const AUTH: CloudAccountAuth = {
  login: 'octocat',
  token: 'gho_test',
  capiBase: 'https://api.enterprise.githubcopilot.com',
  userId: 12345,
  source: 'gh',
};

function config(overrides: Partial<Record<keyof CloudConfig, unknown>> = {}): CloudConfig {
  return {
    isCopilotCloudEnabled: () => true,
    getCopilotCloudAccounts: () => ['octocat'],
    getCopilotCloudGhCliPath: () => 'gh',
    getCopilotCloudIdlePollMs: () => 300_000,
    getCopilotCloudActivePollMs: () => 60_000,
    getCopilotCloudScope: () => 'my-tasks',
    getCopilotCloudRetentionMs: () => 180 * 24 * 60 * 60 * 1000,
    getCopilotCloudMaxTasks: () => 100,
    ...overrides,
  } as CloudConfig;
}

function task(state = 'completed'): RawCloudTask {
  return { id: 'task-1', name: 'Add retry', state, updated_at: '2026-07-07T10:01:32.000Z' };
}

function detail(state = 'completed', sessionState = 'completed'): RawCloudTaskDetail {
  return {
    id: 'task-1',
    name: 'Add retry',
    state,
    repository: 999,
    updated_at: '2026-07-07T10:01:32.000Z',
    sessions: [
      {
        id: 'sess-1',
        name: 'Add retry',
        prompt: 'do it',
        model: 'sweagent-capi:claude-sonnet-4.6',
        state: sessionState,
        created_at: '2026-07-07T10:00:00.000Z',
        updated_at: '2026-07-07T10:01:32.000Z',
        completed_at: sessionState === 'completed' ? '2026-07-07T10:01:32.000Z' : undefined,
        usage: { credits: 33570585000, type: 'ai_credits' },
      },
    ],
  };
}

interface FakeClient {
  listMyTasks: ReturnType<typeof vi.fn>;
  getTaskDetail: ReturnType<typeof vi.fn>;
  resolveRepo: ReturnType<typeof vi.fn>;
  fetchSessionLog: ReturnType<typeof vi.fn>;
  seedRepoCache: ReturnType<typeof vi.fn>;
  knownRepos: ReturnType<typeof vi.fn>;
}

function fakeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    listMyTasks: vi.fn(async (): Promise<CloudApiResult<RawCloudTask[]>> => ({ ok: true, value: [task()] })),
    getTaskDetail: vi.fn(
      async (): Promise<CloudApiResult<ConditionalTaskDetail>> => ({
        ok: true,
        value: { notModified: false, detail: detail(), etag: 'etag-1' },
      }),
    ),
    resolveRepo: vi.fn(async () => ({ ok: true, value: { id: 999, owner: 'org', name: 'repo' } })),
    fetchSessionLog: vi.fn(async (): Promise<CloudApiResult<string>> => ({ ok: true, value: 'data: {"role":"user","content":"hi"}\n' })),
    seedRepoCache: vi.fn(),
    knownRepos: vi.fn(() => []),
    ...over,
  };
}

function fakeAuth(result: AuthResult = { ok: true, auth: AUTH }): GhAuth {
  return { resolveAccount: vi.fn(async () => result) } as unknown as GhAuth;
}

/** A lease whose tryAcquire returns a fixed value (leader vs reader). */
function leaseFactoryReturning(held: boolean): (l: string, s: number, c: WriterLeaseClock) => WriterLease {
  return () => ({ tryAcquire: () => held, release: () => undefined, heartbeat: () => undefined, isHeld: held } as unknown as WriterLease);
}

let tmp: string;
let sink: CloudSink;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cloudpoll-'));
  sink = new CloudSink(tmp);
});

function makePoller(opts: { client?: FakeClient; auth?: GhAuth; cfg?: CloudConfig; held?: boolean; onIngest?: () => void }) {
  const client = opts.client ?? fakeClient();
  const poller = new CloudAgentPoller({
    config: opts.cfg ?? config(),
    auth: opts.auth ?? fakeAuth(),
    client: client as unknown as CloudApiClient,
    sink,
    onIngest: opts.onIngest ?? (() => undefined),
    now: () => 1_720_000_100_000,
    leaseFactory: leaseFactoryReturning(opts.held ?? true),
  });
  return { poller, client };
}

describe('CloudAgentPoller.pollOnce', () => {
  it('polls as leader: writes the index, raw task, and session log, and fires onIngest', async () => {
    let ingests = 0;
    const { poller, client } = makePoller({ onIngest: () => (ingests += 1) });
    const outcome = await poller.pollOnce();

    expect(outcome.polled).toBe(true);
    expect(client.listMyTasks).toHaveBeenCalledTimes(1);
    const index = sink.readIndex();
    expect(index.tasks['task-1']).toBeDefined();
    expect(index.tasks['task-1'].repository).toBe('https://github.com/org/repo');
    expect(index.tasks['task-1'].sessionIds).toEqual(['sess-1']);
    expect(sink.readTaskRaw('task-1')).toBeDefined();
    expect(sink.hasSessionLog('sess-1')).toBe(true);
    expect(index.poller.firstPollCompleted).toBe(true);
    expect(index.poller.accounts[0]).toMatchObject({ login: 'octocat', lastOutcome: 'ok' });
    expect(ingests).toBe(1);
  });

  it('fetches a terminal session log only once (immutable once terminal)', async () => {
    const { poller, client } = makePoller({});
    await poller.pollOnce();
    expect(client.fetchSessionLog).toHaveBeenCalledTimes(1);
    client.fetchSessionLog.mockClear();
    await poller.pollOnce();
    expect(client.fetchSessionLog).toHaveBeenCalledTimes(0);
  });

  it('marks a non-terminal task and selects the active poll cadence', async () => {
    const client = fakeClient({
      listMyTasks: vi.fn(async () => ({ ok: true, value: [task('in_progress')] })),
      getTaskDetail: vi.fn(async () => ({
        ok: true,
        value: { notModified: false, detail: detail('in_progress', 'in_progress'), etag: 'etag-1' },
      })),
    });
    const { poller } = makePoller({ client });
    const outcome = await poller.pollOnce();
    expect(outcome.anyNonTerminal).toBe(true);
    expect(poller.currentCadenceMs()).toBe(60_000);
  });

  it('does not poll when it loses the lease (reader window)', async () => {
    const { poller, client } = makePoller({ held: false });
    const outcome = await poller.pollOnce();
    expect(outcome.polled).toBe(false);
    expect(client.listMyTasks).not.toHaveBeenCalled();
    expect(Object.keys(sink.readIndex().tasks)).toHaveLength(0);
  });

  it('records a per-account failure without calling the API for that account', async () => {
    const client = fakeClient();
    const { poller } = makePoller({
      client,
      auth: fakeAuth({ ok: false, reason: 'unauthenticated', message: 'octocat: not signed in' }),
    });
    const outcome = await poller.pollOnce();
    expect(outcome.polled).toBe(true);
    expect(client.listMyTasks).not.toHaveBeenCalled();
    expect(outcome.accounts[0]).toMatchObject({ login: 'octocat', lastOutcome: 'unauthenticated' });
    expect(sink.readIndex().poller.firstPollCompleted).toBe(true);
  });

  it('backs off after a rate limit', async () => {
    const client = fakeClient({
      listMyTasks: vi.fn(async () => ({ ok: false, reason: 'rateLimited', message: 'slow down' })),
    });
    const { poller } = makePoller({ client });
    const outcome = await poller.pollOnce();
    expect(outcome.rateLimited).toBe(true);
    // Backoff is at least the idle cadence.
    expect(poller.currentCadenceMs()).toBeGreaterThanOrEqual(300_000);
  });

  it('does nothing when the feature is disabled', async () => {
    const { poller, client } = makePoller({ cfg: config({ isCopilotCloudEnabled: () => false }) });
    const outcome = await poller.pollOnce();
    expect(outcome.polled).toBe(false);
    expect(client.listMyTasks).not.toHaveBeenCalled();
  });

  it('skips a terminal, unchanged task on the next poll (no detail GET)', async () => {
    const { poller, client } = makePoller({});
    await poller.pollOnce();
    expect(client.getTaskDetail).toHaveBeenCalledTimes(1);
    // Second poll: the list view shows the task terminal + unchanged and every
    // session log is already on disk, so the poller skips the detail GET entirely.
    await poller.pollOnce();
    expect(client.getTaskDetail).toHaveBeenCalledTimes(1);
    // The task is retained in the index across the skip.
    expect(sink.readIndex().tasks['task-1']).toBeDefined();
  });

  it('reuses the cached detail on a 304 and replays the stored ETag', async () => {
    const client = fakeClient({
      listMyTasks: vi.fn(async () => ({ ok: true, value: [task('in_progress')] })),
      getTaskDetail: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: { notModified: false, detail: detail('in_progress', 'in_progress'), etag: 'etag-1' },
        })
        .mockResolvedValueOnce({ ok: true, value: { notModified: true, etag: 'etag-1' } }),
    });
    const { poller } = makePoller({ client });
    await poller.pollOnce();
    await poller.pollOnce();

    // First GET was unconditional; the second replayed the ETag captured from the 200.
    expect(client.getTaskDetail.mock.calls[0][2]).toBeUndefined();
    expect(client.getTaskDetail.mock.calls[1][2]).toBe('etag-1');
    // The 304 reused the cached raw copy — the task survives and stays non-terminal.
    const entry = sink.readIndex().tasks['task-1'];
    expect(entry).toBeDefined();
    expect(entry.terminal).toBe(false);
    // Non-terminal → the session log is still polled on the 304 pass.
    expect(client.fetchSessionLog).toHaveBeenCalledTimes(2);
  });

  it('honours the rate-limit Retry-After hint for backoff', async () => {
    const client = fakeClient({
      listMyTasks: vi.fn(async () => ({ ok: false, reason: 'rateLimited', message: 'slow down', retryAfterMs: 600_000 })),
    });
    const { poller } = makePoller({ client });
    const outcome = await poller.pollOnce();
    expect(outcome.rateLimited).toBe(true);
    expect(outcome.rateLimitRetryMs).toBe(600_000);
    // Backoff follows GitHub's hint (it exceeds both the idle base and the default).
    expect(poller.currentCadenceMs()).toBe(600_000);
  });

  it('clamps an excessive rate-limit hint to the max backoff', async () => {
    const client = fakeClient({
      listMyTasks: vi.fn(async () => ({ ok: false, reason: 'rateLimited', message: 'slow down', retryAfterMs: 10 * 60 * 60_000 })),
    });
    const { poller } = makePoller({ client });
    await poller.pollOnce();
    expect(poller.currentCadenceMs()).toBe(60 * 60_000);
  });

  it('announces leader ownership once when it holds the lease', async () => {
    const events: string[] = [];
    const poller = new CloudAgentPoller({
      config: config(),
      auth: fakeAuth(),
      client: fakeClient() as unknown as CloudApiClient,
      sink,
      onIngest: () => undefined,
      onBecomeLeader: () => events.push('leader'),
      onBecomeReader: () => events.push('reader'),
      now: () => 1_720_000_100_000,
      leaseFactory: leaseFactoryReturning(true),
    });
    await poller.pollOnce();
    await poller.pollOnce();
    // Fires once on the transition into leadership, not on every poll.
    expect(events).toEqual(['leader']);
  });

  it('announces reader ownership when another window holds the lease', async () => {
    const events: string[] = [];
    const poller = new CloudAgentPoller({
      config: config(),
      auth: fakeAuth(),
      client: fakeClient() as unknown as CloudApiClient,
      sink,
      onIngest: () => undefined,
      onBecomeLeader: () => events.push('leader'),
      onBecomeReader: () => events.push('reader'),
      now: () => 1_720_000_100_000,
      leaseFactory: leaseFactoryReturning(false),
    });
    await poller.pollOnce();
    expect(events).toEqual(['reader']);
  });
});
