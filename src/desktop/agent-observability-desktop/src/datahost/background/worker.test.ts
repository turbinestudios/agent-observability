import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import Database from 'better-sqlite3';
import { IndexDb, SCHEMA_VERSION } from '../indexer/indexDb';
import type { SessionRow } from '../../shared/rpc';
import type { BackgroundInput, BackgroundMessage } from './protocol';
import { ProcessingWorker } from './processingWorker';

let root: string;
let indexPath: string;
let db: IndexDb;
let backgroundCode: string;
let holdingCode: string;
const workers: Worker[] = [];

const row: SessionRow = {
  source: 'claude', sessionId: 'synthetic', repository: 'unknown', title: 'Saved session',
  startedAtMs: 1, endedAtMs: 2, durationMs: 1, interactionCount: 1,
  llmCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0,
  model: 'synthetic', agentModes: [], indexedAtMs: 1,
};

beforeAll(() => {
  const options = {
    bundle: true, platform: 'node' as const, format: 'cjs' as const, write: false,
    external: ['better-sqlite3', 'node-sqlite3-wasm'],
  };
  backgroundCode = buildSync({ ...options, entryPoints: [path.join(__dirname, 'worker.ts')] }).outputFiles![0].text;
  holdingCode = buildSync({
    ...options,
    stdin: {
      resolveDir: __dirname, loader: 'ts', contents: `
        import { parentPort, workerData } from 'node:worker_threads';
        import { IndexDb } from '../indexer/indexDb';
        import Database from 'better-sqlite3';
        const index = new IndexDb(workerData.indexPath, { initialize: false });
        index.upsertSessions([workerData.row]);
        const writer = new Database(workerData.indexPath);
        writer.exec('BEGIN IMMEDIATE');
        writer.prepare('UPDATE sessions SET title = ?').run('Uncommitted');
        parentPort!.postMessage('holding');
        // Deterministic synchronization, not an elapsed-time performance test:
        // hold a real write transaction until the broker has queried its WAL.
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        writer.exec('COMMIT'); writer.close(); index.close();
        parentPort!.postMessage('done'); parentPort!.close();
      `,
    },
  }).outputFiles![0].text;
}, 30_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-background-'));
  indexPath = path.join(root, 'index.db');
  db = new IndexDb(indexPath);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function start(code: string, workerData: unknown): Worker {
  const worker = new Worker(code, { eval: true, workerData });
  workers.push(worker);
  return worker;
}

function exited(worker: Worker): Promise<number> {
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
}

function holding(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message) => {
      if (message === 'holding') { resolve(); }
      else { reject(new Error('Unexpected worker message')); }
    });
  });
}

describe('independent worker and broker connections', () => {
  it('answers list/search/dashboard queries while the worker is blocked with a write transaction', async () => {
    const gate = new SharedArrayBuffer(4);
    const worker = start(holdingCode, { indexPath, row, gate });
    const exit = exited(worker);
    await holding(worker);
    // The writer is still blocked on Atomics.wait; none of these queries
    // depends on it finishing. WAL exposes only the earlier committed row.
    expect(db.listSessions({})[0].title).toBe('Saved session');
    expect(db.listSessions({ query: 'Saved' })).toHaveLength(1);
    expect(db.overview('all', []).totals.sessions).toBe(1);
    expect(db.getRow('claude', 'synthetic')?.title).toBe('Saved session');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    expect(await exit).toBe(0);
    expect(db.getRow('claude', 'synthetic')?.title).toBe('Uncommitted');
  }, 30_000);

  it('termination releases an in-flight writer before rebuild or deletion', async () => {
    const worker = start(holdingCode, { indexPath, row, gate: new SharedArrayBuffer(4) });
    await holding(worker);
    await worker.terminate();
    // If a native connection survived termination these writes would lock,
    // or a late commit could recreate the deleted data.
    db.removeSession('claude', 'synthetic');
    db.clear();
    db.upsertSessions([{ ...row, title: 'After rebuild' }]);
    expect(db.getRow('claude', 'synthetic')?.title).toBe('After rebuild');
  }, 30_000);

  it('does not interrupt lease-holding maintenance before its safe-stop signal', async () => {
    const gate = new SharedArrayBuffer(8);
    const marker = path.join(root, 'maintenance.lock');
    const worker = new ProcessingWorker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      fs.writeFileSync(workerData.marker, 'held');
      parentPort.postMessage('holding');
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      fs.unlinkSync(workerData.marker);
      parentPort.postMessage({type:'ready'});
      Atomics.wait(new Int32Array(workerData.gate), 1, 0);
    `, { eval: true, workerData: { marker, gate } });
    workers.push(worker);
    await holding(worker);
    let stopped = false;
    const stopping = worker.terminate().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await stopping;
    expect(stopped).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  it('runs the actual background entry to completion and reports disabled-source removals', async () => {
    db.upsertSessions([row]);
    const input: BackgroundInput = {
      indexPath, copilotNotes: [],
      // Every source off: with any left on, the real worker would index the
      // sessions of whichever machine runs this test.
      settings: { 'claudeCode.enabled': false, 'localTelemetry.enabled': false, 'copilotCli.enabled': false },
    };
    const worker = start(backgroundCode, input);
    const messages: BackgroundMessage[] = [];
    worker.on('message', (message: BackgroundMessage) => messages.push(message));
    expect(await exited(worker)).toBe(0);
    expect(messages).toContainEqual({ type: 'removed', keys: ['claude:synthetic'] });
    expect(messages.at(-1)).toEqual({ type: 'done' });
    expect(messages.some((message) => message.type === 'analysis' && !message.status.running)).toBe(true);
    expect(db.counts()).toEqual({ total: 0, indexed: 0 });
  }, 30_000);

  it('never initializes or migrates an index from a worker connection', () => {
    const absent = path.join(root, 'absent.db');
    expect(() => new IndexDb(absent, { initialize: false })).toThrow();
    expect(fs.existsSync(absent)).toBe(false);
    const other = new Database(indexPath);
    other.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    other.close();
    db.upsertSessions([row]);
    expect(() => new IndexDb(indexPath, { initialize: false })).toThrow('initialized');
    expect(db.getRow('claude', 'synthetic')?.title).toBe('Saved session');
  });
});