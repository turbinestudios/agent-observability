import { describe, it, expect } from 'vitest';
import {
  SyncEngine,
  Clock,
  SyncEngineConfig,
  SyncConsent,
  SyncSecrets,
  SyncTelemetry,
} from './syncEngine';
import { SyncClient, SyncOutcome, SyncStatusReport } from './syncClient';
import { HttpPoster, HttpResponse } from './httpPoster';
import { InMemorySyncStateStore } from './syncState';
import { AggregationRow } from '../aggregate/aggregator';
import { buildBatch } from '../aggregate/aggregator';
import { computeDeveloperId, getIdentityInput } from '../aggregate/pseudonymizer';
import {
  RepoSyncPolicy,
  ALL_REPOSITORIES_POLICY,
  buildRepoSyncPolicy,
} from '../aggregate/repoSyncPolicy';

/**
 * SyncEngine behavior tests with fakes for every collaborator and a deterministic
 * clock + sleeper. These pin the gate, the happy path (build/send/advance/record),
 * retry/backoff on transient outcomes, no-retry on permanent ones, the upToDate
 * watermark short-circuit, 429 Retry-After honoring, and idempotency.
 */

// A fixed salt + identity so the developer id is deterministic regardless of the
// host's git config (getIdentityInput falls through to a literal in CI).
const SALT = 'a'.repeat(64);
const TOOL_VERSION = '1.4.2';

const BIN0 = Date.parse('2026-06-02T08:00:00.000Z'); // [08:00, 08:30)
const NOW = Date.parse('2026-06-02T09:05:00.000Z'); // floors to 09:00

/** A fake clock returning a fixed (or scriptable) epoch ms. */
class FakeClock implements Clock {
  constructor(public t: number) {}
  nowMs(): number {
    return this.t;
  }
}

class FakeConfig implements SyncEngineConfig {
  constructor(
    public dashboardUrl = 'https://dashboard.example.com',
    public syncEnabled = false,
    public repoPolicy: RepoSyncPolicy = ALL_REPOSITORIES_POLICY,
  ) {}
  getDashboardUrl(): string {
    return this.dashboardUrl;
  }
  isSyncEnabled(): boolean {
    return this.syncEnabled;
  }
  getRepoSyncPolicy(): RepoSyncPolicy {
    return this.repoPolicy;
  }
}

class FakeConsent implements SyncConsent {
  constructor(public consented: boolean) {}
  isConsented(): boolean {
    return this.consented;
  }
}

class FakeSecrets implements SyncSecrets {
  constructor(public keyPresent: boolean) {}
  async hasApiKey(): Promise<boolean> {
    return this.keyPresent;
  }
  async getOrCreatePseudonymSalt(): Promise<string> {
    return SALT;
  }
}

class FakeTelemetry implements SyncTelemetry {
  constructor(private readonly rows: AggregationRow[]) {}
  getAggregationRows(): { ok: true; value: AggregationRow[] } {
    return { ok: true, value: this.rows };
  }
}

/**
 * A scripted HttpPoster: each POST pops the next response off the queue (the last
 * one repeats once the queue is drained). Records bodies/headers for assertions.
 */
class ScriptedPoster implements HttpPoster {
  readonly posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  constructor(private readonly responses: HttpResponse[]) {}
  async post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse> {
    this.posts.push({ url, headers, body });
    const next = this.responses.shift();
    if (next === undefined) {
      // Default tail: keep returning success so status reports succeed.
      return { status: 200, body: '{"accepted":true,"batchId":""}' };
    }
    if (this.responses.length === 0) {
      this.responses.push(next); // last one repeats
    }
    return next;
  }
  async get(): Promise<HttpResponse> {
    return { status: 200, body: 'ok' };
  }
}

function aggregateResponse(): HttpResponse {
  return { status: 200, body: JSON.stringify({ accepted: true, batchId: 'srv' }) };
}

function row(overrides: Partial<AggregationRow> = {}): AggregationRow {
  return {
    startTimeMs: BIN0 + 60_000,
    sessionKey: 's1',
    repository: 'https://github.com/example-org/sample-repo',
    model: 'gpt-4.1',
    agentMode: 'agent',
    operation: 'chat',
    durationMs: 300,
    statusCode: 1,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

interface Built {
  engine: SyncEngine;
  poster: ScriptedPoster;
  state: InMemorySyncStateStore;
  client: SyncClient;
  statusReports: SyncStatusReport[];
  sleeps: number[];
}

function buildEngine(opts: {
  consented?: boolean;
  hasKey?: boolean;
  rows?: AggregationRow[];
  responses?: HttpResponse[];
  watermarkMs?: number;
  clock?: number;
  dashboardUrl?: string;
  repoPolicy?: RepoSyncPolicy;
}): Built {
  const poster = new ScriptedPoster(opts.responses ?? [aggregateResponse()]);
  const config = new FakeConfig(
    opts.dashboardUrl ?? 'https://dashboard.example.com',
    false,
    opts.repoPolicy ?? ALL_REPOSITORIES_POLICY,
  );
  const consent = new FakeConsent(opts.consented ?? true);
  const secrets = new FakeSecrets(opts.hasKey ?? true);
  const telemetry = new FakeTelemetry(opts.rows ?? [row()]);
  const client = new SyncClient(poster, () => config.getDashboardUrl(), async () => 'aoa_k_secret');
  const state = new InMemorySyncStateStore(opts.watermarkMs);
  const clock = new FakeClock(opts.clock ?? NOW);

  const statusReports: SyncStatusReport[] = [];
  // Spy on reportStatus to confirm it is fired on success (best-effort).
  const origReport = client.reportStatus.bind(client);
  client.reportStatus = async (report: SyncStatusReport): Promise<boolean> => {
    statusReports.push(report);
    return origReport(report);
  };

  const sleeps: number[] = [];
  const engine = new SyncEngine(config, consent, secrets, telemetry, client, state, clock, {
    toolVersion: TOOL_VERSION,
    maxAttempts: 4,
    baseBackoffMs: 100,
    maxBackoffMs: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // deterministic jitter
  });

  return { engine, poster, state, client, statusReports, sleeps };
}

describe('SyncEngine gate', () => {
  it('(a) blocks and sends nothing when not consented', async () => {
    const { engine, poster, state } = buildEngine({ consented: false });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('blocked');
    expect(poster.posts).toHaveLength(0);
    expect(state.getWatermarkMs()).toBeUndefined();
    expect(state.getHistory()[0].outcome).toBe('blocked');
  });

  it('(a) blocks and sends nothing when no API key', async () => {
    const { engine, poster } = buildEngine({ hasKey: false });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('blocked');
    expect(poster.posts).toHaveLength(0);
  });
});

describe('SyncEngine happy path', () => {
  it('(b) builds + posts the batch, advances the watermark, records a success run', async () => {
    const { engine, poster, state, statusReports } = buildEngine({ rows: [row(), row({ sessionKey: 's2' })] });
    const result = await engine.runSync({ manual: true });

    expect(result.status).toBe('success');
    // Exactly one POST to the aggregate endpoint (a best-effort status report POST
    // to /api/ingest/status may also occur — assert specifically on aggregate).
    const aggregatePosts = poster.posts.filter((p) => p.url.includes('/api/ingest/aggregate'));
    expect(aggregatePosts).toHaveLength(1);

    // The posted body matches what buildBatch produces for the same inputs.
    const end = Date.parse('2026-06-02T09:00:00.000Z');
    const devId = computeDeveloperId(SALT, expectedIdentityInput());
    const expected = buildBatch({
      rows: [row(), row({ sessionKey: 's2' })],
      pseudonymousDeveloperId: devId,
      toolVersion: TOOL_VERSION,
      windowStartMs: BIN0,
      windowEndMs: end,
      generatedAtMs: NOW,
    });
    const sent = JSON.parse(aggregatePosts[0].body);
    expect(sent.batchId).toBe(expected.batchId);
    expect(sent.buckets.map((b: { rowKey: string }) => b.rowKey)).toEqual(
      expected.buckets.map((b) => b.rowKey),
    );

    // Watermark advanced to the floored end; success recorded; status reported.
    expect(state.getWatermarkMs()).toBe(end);
    expect(state.getHistory()[0].outcome).toBe('success');
    expect(statusReports).toHaveLength(1);
    expect(statusReports[0].lastOutcome).toBe('success');
  });
});

describe('SyncEngine repository scope', () => {
  const REPO_A = 'https://github.com/example-org/sample-repo'; // the default row repo
  const REPO_B = 'https://github.com/example-org/other-repo';

  it('uploads only the included repositories under an include policy', async () => {
    const { engine, poster } = buildEngine({
      rows: [
        row({ sessionKey: 'a', repository: REPO_A }),
        row({ sessionKey: 'b', repository: REPO_B }),
      ],
      repoPolicy: buildRepoSyncPolicy('include', [REPO_A]),
    });

    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('success');

    const aggregatePosts = poster.posts.filter((p) => p.url.includes('/api/ingest/aggregate'));
    expect(aggregatePosts).toHaveLength(1);
    const sent = JSON.parse(aggregatePosts[0].body);
    const repos = new Set(sent.buckets.map((b: { repository: string }) => b.repository));
    expect([...repos]).toEqual([REPO_A]);
  });

  it('drops the excluded repositories under an exclude policy', async () => {
    const { engine, poster } = buildEngine({
      rows: [
        row({ sessionKey: 'a', repository: REPO_A }),
        row({ sessionKey: 'b', repository: REPO_B }),
      ],
      repoPolicy: buildRepoSyncPolicy('exclude', [REPO_A]),
    });

    await engine.runSync({ manual: true });
    const sent = JSON.parse(
      poster.posts.find((p) => p.url.includes('/api/ingest/aggregate'))!.body,
    );
    const repos = new Set(sent.buckets.map((b: { repository: string }) => b.repository));
    expect([...repos]).toEqual([REPO_B]);
  });

  it('uploads everything under an "all" policy', async () => {
    const { engine, poster } = buildEngine({
      rows: [
        row({ sessionKey: 'a', repository: REPO_A }),
        row({ sessionKey: 'b', repository: REPO_B }),
      ],
    });
    await engine.runSync({ manual: true });
    const sent = JSON.parse(
      poster.posts.find((p) => p.url.includes('/api/ingest/aggregate'))!.body,
    );
    const repos = new Set(sent.buckets.map((b: { repository: string }) => b.repository));
    expect(repos).toEqual(new Set([REPO_A, REPO_B]));
  });
});

describe('SyncEngine retry/backoff', () => {
  it('(c) retries on 5xx then succeeds', async () => {
    const { engine, poster, state, sleeps } = buildEngine({
      responses: [{ status: 500, body: '' }, aggregateResponse()],
    });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('success');
    expect(poster.posts.length).toBeGreaterThanOrEqual(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // backed off once
    expect(state.getWatermarkMs()).toBe(Date.parse('2026-06-02T09:00:00.000Z'));
  });

  it('(c) retries on a network failure then succeeds', async () => {
    // A network outcome is produced when the poster throws; alternate throw->ok.
    const poster = new ThrowOncePoster(aggregateResponse());
    const config = new FakeConfig();
    const client = new SyncClient(poster, () => config.getDashboardUrl(), async () => 'aoa_k_s');
    const state = new InMemorySyncStateStore();
    const sleeps: number[] = [];
    const engine = new SyncEngine(
      config,
      new FakeConsent(true),
      new FakeSecrets(true),
      new FakeTelemetry([row()]),
      client,
      state,
      new FakeClock(NOW),
      { toolVersion: TOOL_VERSION, baseBackoffMs: 50, sleep: async (ms) => void sleeps.push(ms), random: () => 0.1 },
    );
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('success');
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it('(f) honors 429 Retry-After as the backoff delay', async () => {
    const { engine, sleeps } = buildEngine({
      responses: [
        { status: 429, body: '', header: (n) => (n.toLowerCase() === 'retry-after' ? '7' : undefined) },
        aggregateResponse(),
      ],
    });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('success');
    // 7s Retry-After is clamped to maxBackoffMs (1000) in this build's config.
    expect(sleeps[0]).toBe(1000);
  });

  it('gives up after maxAttempts on a persistent 5xx and leaves the watermark unchanged', async () => {
    const { engine, poster, state } = buildEngine({ responses: [{ status: 500, body: '' }] });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('failed');
    expect(poster.posts).toHaveLength(4); // maxAttempts
    expect(state.getWatermarkMs()).toBeUndefined();
    expect(state.getHistory()[0].outcome).toBe('serverError');
  });
});

describe('SyncEngine permanent failures', () => {
  it('(d) does NOT retry on 401 and records a permanent failure without advancing watermark', async () => {
    const { engine, poster, state } = buildEngine({ responses: [{ status: 401, body: '' }] });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.outcome.kind).toBe('unauthorized');
    }
    expect(poster.posts).toHaveLength(1); // exactly one attempt, no retry
    expect(state.getWatermarkMs()).toBeUndefined();
    expect(state.getHistory()[0].outcome).toBe('unauthorized');
  });

  it('(d) does NOT retry on 400 and records a rejected failure without advancing watermark', async () => {
    const { engine, poster, state } = buildEngine({
      responses: [{ status: 400, body: JSON.stringify({ error: 'bad batch' }) }],
    });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.outcome.kind).toBe('rejected');
    }
    expect(poster.posts).toHaveLength(1);
    expect(state.getWatermarkMs()).toBeUndefined();
    expect(state.getHistory()[0].outcome).toBe('rejected');
  });

  it('reports failed without a network attempt when no dashboard URL is configured', async () => {
    const { engine, poster, state } = buildEngine({ dashboardUrl: '' });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.outcome.kind).toBe('misconfigured');
    }
    expect(poster.posts).toHaveLength(0);
    expect(state.getWatermarkMs()).toBeUndefined();
  });
});

describe('SyncEngine windowing', () => {
  it('(e) returns upToDate (no post) when the watermark is at/after the floored end', async () => {
    const end = Date.parse('2026-06-02T09:00:00.000Z');
    const { engine, poster, state } = buildEngine({ watermarkMs: end });
    const result = await engine.runSync({ manual: true });
    expect(result.status).toBe('upToDate');
    expect(poster.posts).toHaveLength(0);
    expect(state.getHistory()[0].outcome).toBe('upToDate');
  });

  it('floors the window end to the current 30-min boundary (excludes the open bin)', async () => {
    const { engine, poster } = buildEngine({ rows: [row()] });
    await engine.runSync({ manual: true });
    const sent = JSON.parse(poster.posts[0].body);
    // NOW is 09:05 -> floored end is 09:00 (the 09:00-09:30 bin is still open).
    expect(sent.window.end).toBe('2026-06-02T09:00:00.000Z');
  });
});

describe('SyncEngine idempotency', () => {
  it('(g) two runs over the same data produce an identical batchId; the watermark prevents needless re-send', async () => {
    // First run sends and advances the watermark.
    const first = buildEngine({ rows: [row(), row({ sessionKey: 's2' })] });
    const r1 = await first.engine.runSync({ manual: true });
    expect(r1.status).toBe('success');
    const batchId1 = JSON.parse(first.poster.posts[0].body).batchId as string;

    // A fresh engine over the SAME data + window but no prior watermark must mint
    // the SAME batchId (deterministic build => safe re-send).
    const second = buildEngine({ rows: [row(), row({ sessionKey: 's2' })] });
    const r2 = await second.engine.runSync({ manual: true });
    expect(r2.status).toBe('success');
    const batchId2 = JSON.parse(second.poster.posts[0].body).batchId as string;
    expect(batchId2).toBe(batchId1);

    // Re-running the FIRST engine (watermark now set) sends nothing more.
    const postsBefore = first.poster.posts.length;
    const r3 = await first.engine.runSync({ manual: true });
    expect(r3.status).toBe('upToDate');
    expect(first.poster.posts.length).toBe(postsBefore);
  });
});

/**
 * The identity input the engine resolves in this headless test. The engine calls
 * getIdentityInput(workspaceCwd=undefined, machineId=undefined), so we mirror that
 * exactly to reconstruct the expected developer id deterministically.
 */
function expectedIdentityInput(): string {
  return getIdentityInput().input;
}

/** Poster that throws on the first POST (a network failure) then returns a response. */
class ThrowOncePoster implements HttpPoster {
  private thrown = false;
  constructor(private readonly ok: HttpResponse) {}
  async post(): Promise<HttpResponse> {
    if (!this.thrown) {
      this.thrown = true;
      throw new Error('socket hang up');
    }
    return this.ok;
  }
  async get(): Promise<HttpResponse> {
    return { status: 200, body: 'ok' };
  }
}

// Touch the SyncOutcome type so the import is used (assertions reference kinds).
const _outcomeTypeCheck: SyncOutcome = { kind: 'misconfigured' };
void _outcomeTypeCheck;
