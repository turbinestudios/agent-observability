import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request } from 'node:http';
import { LiveOtlpService } from './liveOtlpService';
import { TelemetryDatabase } from '../telemetry/database';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const SESSION = 'live-sess';

const body = Buffer.from(
  JSON.stringify({
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

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('LiveOtlpService', () => {
  it('ingests a posted trace into its DB and fires a (debounced) onIngest', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    let ingestCount = 0;
    const service = new LiveOtlpService({
      ingestDbPath: dbPath,
      port: 0,
      debounceMs: 20,
      onIngest: () => {
        ingestCount += 1;
      },
    });
    const port = await service.start();
    try {
      await post(port, '/v1/traces', body);
      await delay(80); // let the debounce window elapse
      expect(ingestCount).toBe(1);
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
});
