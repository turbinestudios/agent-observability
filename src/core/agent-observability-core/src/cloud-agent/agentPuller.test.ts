import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from '../telemetry/telemetryService';
import type { SpanRows } from '../otel/otlpToRows';
import { AgentSink } from './agentSink';
import type { AgentBatchReader, AgentConfig, RawOtlpBatchRef } from './agentTypes';
import { AgentPuller, type IngestWriter } from './agentPuller';

const DAY = 86_400_000;

class FakeConfig implements AgentConfig {
  enabled = true;
  endpoint: string | undefined = 'https://relay.example/base';
  idleMs = 300_000;
  activeMs = 60_000;
  retentionMs = 180 * DAY;
  max = 100;
  isCopilotAgentEnabled(): boolean {
    return this.enabled;
  }
  getCopilotAgentEndpoint(): string | undefined {
    return this.endpoint;
  }
  getCopilotAgentIdlePollMs(): number {
    return this.idleMs;
  }
  getCopilotAgentActivePollMs(): number {
    return this.activeMs;
  }
  getCopilotAgentRetentionMs(): number {
    return this.retentionMs;
  }
  getCopilotAgentMaxSessions(): number {
    return this.max;
  }
}

/** A reader whose list + per-id download responses are scripted. */
class FakeReader implements AgentBatchReader {
  listCalls = 0;
  downloaded: string[] = [];
  list: Result<RawOtlpBatchRef[]> = { ok: true, value: [] };
  bodies = new Map<string, Result<string>>();
  listBatches(_sinceMs: number, _max: number): Promise<Result<RawOtlpBatchRef[]>> {
    this.listCalls++;
    return Promise.resolve(this.list);
  }
  downloadBatch(ref: RawOtlpBatchRef): Promise<Result<string>> {
    this.downloaded.push(ref.id);
    return Promise.resolve(
      this.bodies.get(ref.id) ?? { ok: false, reason: 'error', message: `no body for ${ref.id}` },
    );
  }
}

/** Records span writes without touching the WASM SQLite driver. */
class FakeWriter implements IngestWriter {
  writes: SpanRows[] = [];
  pruned: Array<[number, number]> = [];
  closed = 0;
  writeSpans(rows: SpanRows): number {
    this.writes.push(rows);
    return rows.spans.length;
  }
  prune(maxAgeMs: number, nowMs: number): number {
    this.pruned.push([maxAgeMs, nowMs]);
    return 0;
  }
  close(): void {
    this.closed++;
  }
}

/** A lease whose leadership is a settable boolean. */
class FakeLease {
  constructor(public held: boolean) {}
  get isHeld(): boolean {
    return this.held;
  }
  tryAcquire(): boolean {
    return this.held;
  }
  heartbeat(): void {}
  release(): void {
    this.held = false;
  }
}

function rows(n: number): SpanRows {
  return {
    spans: Array.from({ length: n }, (_, i) => ({ span_id: `s${i}` }) as never),
    attributes: [],
  };
}

function ref(id: string, createdAtMs: number, service = 'error-remediation'): RawOtlpBatchRef {
  return { id, service, createdAtMs };
}

describe('AgentPuller', () => {
  let dir: string;
  let sink: AgentSink;
  let config: FakeConfig;
  let reader: FakeReader;
  let writer: FakeWriter;
  let ingested: number;
  let errors: unknown[];

  function makePuller(held = true): AgentPuller {
    return new AgentPuller({
      config,
      reader,
      sink,
      onIngest: () => {
        ingested++;
      },
      onError: (e) => {
        errors.push(e);
      },
      now: () => 10 * DAY,
      leaseFactory: () => new FakeLease(held) as never,
      storeFactory: () => writer,
      decode: (body) => rows(JSON.parse(body).n as number),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-puller-'));
    sink = new AgentSink(dir);
    config = new FakeConfig();
    reader = new FakeReader();
    writer = new FakeWriter();
    ingested = 0;
    errors = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests new batches, archives raw, advances the watermark and fires onIngest', async () => {
    reader.list = { ok: true, value: [ref('b1', 100), ref('b2', 200)] };
    reader.bodies.set('b1', { ok: true, value: '{"n":2}' });
    reader.bodies.set('b2', { ok: true, value: '{"n":3}' });

    const out = await makePuller(true).pollOnce();

    expect(out).toEqual({ polled: true, changed: true, pulled: 2, outcome: 'ok' });
    expect(writer.writes.map((r) => r.spans.length)).toEqual([2, 3]);
    expect(writer.closed).toBe(1);
    expect(ingested).toBe(1);
    const index = sink.readIndex();
    expect(Object.keys(index.batches).sort()).toEqual(['b1', 'b2']);
    expect(index.watermarkMs).toBe(200);
    expect(index.puller.firstPullCompleted).toBe(true);
    expect(index.puller.lastOutcome).toBe('ok');
    expect(sink.readBatchRaw('error-remediation', 'b1')).toBe('{"n":2}');
  });

  it('dedupes already-ingested batches on a second poll (no re-ingest, no onIngest)', async () => {
    reader.list = { ok: true, value: [ref('b1', 100)] };
    reader.bodies.set('b1', { ok: true, value: '{"n":1}' });
    const puller = makePuller(true);

    await puller.pollOnce();
    reader.downloaded = [];
    const out = await puller.pollOnce();

    expect(out).toEqual({ polled: true, changed: false, pulled: 0, outcome: 'ok' });
    expect(reader.downloaded).toEqual([]); // not re-downloaded
    expect(ingested).toBe(1); // only the first poll fired it
  });

  it('does not pull when this window is not the leaseholder', async () => {
    reader.list = { ok: true, value: [ref('b1', 100)] };
    const out = await makePuller(false).pollOnce();

    expect(out.polled).toBe(false);
    expect(reader.listCalls).toBe(0); // followers make ZERO requests
  });

  it('does not pull when disabled', async () => {
    config.enabled = false;
    const out = await makePuller(true).pollOnce();
    expect(out.polled).toBe(false);
    expect(reader.listCalls).toBe(0);
  });

  it('does not pull when no endpoint is configured', async () => {
    config.endpoint = undefined;
    const out = await makePuller(true).pollOnce();
    expect(out.polled).toBe(false);
    expect(reader.listCalls).toBe(0);
  });

  it('records a list failure in the puller status and routes it to onError', async () => {
    reader.list = { ok: false, reason: 'rateLimited', message: 'slow down' };
    const out = await makePuller(true).pollOnce();

    expect(out).toEqual({ polled: true, changed: false, pulled: 0, outcome: 'rateLimited' });
    expect(errors).toHaveLength(1);
    const puller = sink.readIndex().puller;
    expect(puller.lastOutcome).toBe('rateLimited');
    expect(puller.lastErrorMessage).toBe('slow down');
    expect(puller.firstPullCompleted).toBe(true);
  });

  it('holds the watermark below a batch that failed to download', async () => {
    reader.list = { ok: true, value: [ref('bad', 100), ref('good', 200)] };
    reader.bodies.set('bad', { ok: false, reason: 'network', message: 'boom' });
    reader.bodies.set('good', { ok: true, value: '{"n":1}' });

    const out = await makePuller(true).pollOnce();

    expect(out).toMatchObject({ polled: true, changed: true, pulled: 1 });
    const index = sink.readIndex();
    expect(Object.keys(index.batches)).toEqual(['good']);
    expect(index.watermarkMs).toBe(99); // min(200, 100 - 1) — 'bad' re-surfaces next poll
    expect(errors).toHaveLength(1);
  });

  it('uses the active cadence after a productive poll and the idle cadence otherwise', async () => {
    reader.list = { ok: true, value: [ref('b1', 100)] };
    reader.bodies.set('b1', { ok: true, value: '{"n":1}' });
    const puller = makePuller(true);

    await puller.pollOnce();
    expect(puller.currentCadenceMs()).toBe(config.activeMs);

    reader.list = { ok: true, value: [] };
    await puller.pollOnce();
    expect(puller.currentCadenceMs()).toBe(config.idleMs);
  });

  it('prunes spans and raw to retention every poll', async () => {
    reader.list = { ok: true, value: [] };
    await makePuller(true).pollOnce();
    expect(writer.pruned).toEqual([[config.retentionMs, 10 * DAY]]);
  });
});
