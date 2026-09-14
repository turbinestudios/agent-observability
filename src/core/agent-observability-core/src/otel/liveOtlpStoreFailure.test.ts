import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LiveOtlpService } from './liveOtlpService';
import { IngestHotJournalError } from './ingestStore';

/**
 * A receiver that cannot open its store must not claim to be listening.
 *
 * The outage this guards: `new IngestStore(...)` threw inside `tryBecomeReceiver`,
 * which is called as `void tryBecomeReceiver()`. The rejection was swallowed, the
 * HTTP receiver stayed bound, Copilot connected and exported happily — and every
 * batch hit `store === undefined` in `onSpans` and was dropped without a word.
 * Telemetry silently stopped for five days while everything looked healthy.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(10);
  }
}

/** SQLite's hot-journal magic — the condition that wedged the real store. */
const HOT = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

let tmp: string | undefined;
let service: LiveOtlpService | undefined;

afterEach(() => {
  service?.stop();
  service = undefined;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('LiveOtlpService when the ingest store cannot open', () => {
  it('surfaces the failure through onStartError instead of swallowing it', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-fail-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    writeFileSync(`${dbPath}-journal`, Buffer.concat([HOT, Buffer.alloc(512)]));

    let startError: unknown;
    let listeningPort = 0;
    service = new LiveOtlpService({
      ingestDbPath: dbPath,
      port: 0,
      signal: () => {},
      onListening: (p) => {
        listeningPort = p;
      },
      onStartError: (err) => {
        startError = err;
      },
    });
    service.start();

    await waitFor(() => startError !== undefined);
    expect(startError).toBeInstanceOf(IngestHotJournalError);
    // and it must NOT have announced itself as a healthy listener
    expect(listeningPort).toBe(0);
  });

  it('reports listening normally when the store opens cleanly', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-live-ok-'));
    const dbPath = path.join(tmp, 'agent-traces.db');

    let startError: unknown;
    let listeningPort = 0;
    service = new LiveOtlpService({
      ingestDbPath: dbPath,
      port: 0,
      signal: () => {},
      onListening: (p) => {
        listeningPort = p;
      },
      onStartError: (err) => {
        startError = err;
      },
    });
    service.start();

    await waitFor(() => listeningPort !== 0);
    expect(startError).toBeUndefined();
    expect(listeningPort).toBeGreaterThan(0);
  });
});
