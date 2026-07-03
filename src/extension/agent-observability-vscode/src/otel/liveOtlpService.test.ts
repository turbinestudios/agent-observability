import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LiveOtlpService } from './liveOtlpService';
import { TelemetryDatabase } from '../telemetry/database';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const SESSION = 'live-sess';

// Fresh timestamps: every (re)opened store prunes spans older than its retention
// window, so a span stamped in the past would vanish on a reader's promotion.
const traceBody = (spanId: string, startMs = Date.now()) =>
  Buffer.from(
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  name: 'chat',
                  spanId,
                  traceId: 't1',
                  startTimeUnixNano: `${startMs}000000`,
                  endTimeUnixNano: `${startMs + 1000}000000`,
                  status: { code: 1 },
                  attributes: [
                    { key: 'gen_ai.operation.name', value: sv('chat') },
                    { key: 'gen_ai.conversation.id', value: sv(SESSION) },
                    { key: 'gen_ai.usage.input_tokens', value: iv(5) },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );

const body = traceBody('c1');

function post(port: number, path_: string, payload: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: path_, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it holds (or fail after `timeoutMs`). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(10);
  }
}

/** Everything observable about one simulated "window"'s service. */
function makeWindow(ingestDbPath: string, port: number) {
  const state = {
    signals: 0,
    listeningPort: 0,
    reading: false,
    startError: undefined as unknown,
    errors: [] as unknown[],
    service: undefined as LiveOtlpService | undefined,
  };
  state.service = new LiveOtlpService({
    ingestDbPath,
    port,
    signal: () => {
      state.signals += 1;
    },
    onListening: (p) => {
      state.listeningPort = p;
    },
    onReading: () => {
      state.reading = true;
    },
    onStartError: (err) => {
      state.startError = err;
    },
    onError: (err) => {
      state.errors.push(err);
    },
  });
  return state as typeof state & { service: LiveOtlpService };
}

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('LiveOtlpService', () => {
  it('ingests a posted trace into its DB and signals on the batch', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    let signalCount = 0;
    let boundPort = 0;
    const service = new LiveOtlpService({
      ingestDbPath: dbPath,
      port: 0,
      signal: () => {
        signalCount += 1;
      },
      onListening: (p) => {
        boundPort = p;
      },
    });
    await service.start();
    try {
      expect(boundPort).toBeGreaterThan(0);
      await post(boundPort, '/v1/traces', body);
      await delay(40); // let the request handler write + signal
      expect(signalCount).toBe(1);
    } finally {
      service.stop();
    }

    // The span was persisted in the extension's own DB.
    const db = TelemetryDatabase.open(dbPath);
    try {
      const interactions = db.getSessionInteractions(SESSION);
      expect(interactions).toHaveLength(1);
      expect(interactions[0].inputTokens).toBe(5);
    } finally {
      db.close();
    }
  });

  it('elects one receiver per port; the loser reads along and takes over on close', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    const a = makeWindow(dbPath, 0);
    await a.service.start();
    expect(a.listeningPort).toBeGreaterThan(0);
    const port = a.listeningPort;

    // Second "window" on the same (now taken) port → reader, not an error.
    const b = makeWindow(dbPath, port);
    await b.service.start();
    try {
      await waitFor(() => b.reading);
      expect(b.listeningPort).toBe(0);
      expect(b.startError).toBeUndefined();
      const catchUp = b.signals; // hello fires one catch-up signal
      expect(catchUp).toBeGreaterThanOrEqual(1);

      // Persist-then-notify: one POST to the receiver signals BOTH windows.
      await post(port, '/v1/traces', body);
      await waitFor(() => a.signals >= 1 && b.signals > catchUp);

      // Receiver window closes → the reader wins the port and is promoted.
      a.service.stop();
      await waitFor(() => b.listeningPort === port, 5000);

      // The promoted receiver ingests into the same shared DB.
      await post(port, '/v1/traces', traceBody('c2'));
      await delay(40);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      a.service.stop();
      b.service.stop();
    }

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.getSessionInteractions(SESSION)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('reports a conflict (and never reads) when a foreign process owns the port', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-'));
    const foreign = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
    const port = (foreign.address() as AddressInfo).port;

    const w = makeWindow(path.join(tmp, 'agent-traces.db'), port);
    await w.service.start();
    try {
      await waitFor(() => w.startError !== undefined);
      expect(String(w.startError)).toContain('not an Agent Observability receiver');
      expect(w.reading).toBe(false);
      expect(w.listeningPort).toBe(0);
    } finally {
      w.service.stop();
      foreign.close();
      foreign.closeAllConnections();
    }
  });

  it('reports a conflict when the receiver on the port writes a different ingest DB', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-'));
    const a = makeWindow(path.join(tmp, 'profile-a.db'), 0);
    await a.service.start();
    const b = makeWindow(path.join(tmp, 'profile-b.db'), a.listeningPort);
    await b.service.start();
    try {
      await waitFor(() => b.startError !== undefined);
      expect(String(b.startError)).toContain('different ingest DB');
      expect(b.reading).toBe(false);
    } finally {
      a.service.stop();
      b.service.stop();
    }
  });
});
