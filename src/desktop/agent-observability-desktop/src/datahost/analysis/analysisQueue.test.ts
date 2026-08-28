import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { AnalysisStatus, SessionRow } from '../../shared/rpc';
import { IndexDb } from '../indexer/indexDb';
import type { AnalysisTarget } from '../indexer/indexDb';
import { AnalysisQueue } from './analysisQueue';

/**
 * The queue's contract is about pacing and persistence, not detection: it must
 * work in small batches, hand the thread back between them, get through the
 * backlog exactly once, and never spin on a session it cannot read.
 *
 * The scheduling seam collects the continuations instead of running them, so a
 * test can step the queue tick by tick and see the batching directly.
 */

let dbPath: string;
let db: IndexDb;

function row(sessionId: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'claude',
    sessionId,
    repository: 'github.com/acme/app',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    durationMs: 1_000,
    interactionCount: 1,
    llmCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    model: 'model-test',
    agentModes: ['agent'],
    indexedAtMs: 5_000,
    ...over,
  };
}

/** A source whose sessions are all unreadable unless `readable` lists them. */
function stubSource(readable: string[] = [], onRead?: (id: string) => void): SessionDataSource {
  return {
    id: 'claude',
    getSessionDetail: (sessionId: string) => {
      onRead?.(sessionId);
      return readable.includes(sessionId)
        ? {
            ok: true as const,
            value: {
              summary: { sessionId, repository: 'github.com/acme/app' },
              turns: [],
            },
          }
        : { ok: false as const, message: 'gone' };
    },
    getSessionInteractions: () => ({ ok: true as const, value: [] }),
  } as unknown as SessionDataSource;
}

function makeQueue(source: SessionDataSource, batch = 2) {
  const pending: (() => void)[] = [];
  const progress: AnalysisStatus[] = [];
  const analyzed: AnalysisTarget[][] = [];
  const queue = new AnalysisQueue({
    db,
    sources: { get: () => source },
    detector: new LocalDeviationDetector({
      getWorkflowConfigs: () => [],
      getMaxSessionMinutes: () => 60,
    }),
    acceptedMissing: () => ({ files: [], sources: [] }),
    onProgress: (status) => progress.push(status),
    onAnalyzed: (targets) => analyzed.push([...targets]),
    schedule: (run) => pending.push(run),
    batch,
    now: () => 9_000,
  });
  /** Run every scheduled continuation until the queue stops scheduling more. */
  const drain = (limit = 50): number => {
    let ticks = 0;
    while (pending.length > 0 && ticks < limit) {
      pending.shift()?.();
      ticks++;
    }
    return ticks;
  };
  return { queue, pending, progress, analyzed, drain };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `ao-queue-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('AnalysisQueue', () => {
  it('hands the thread back between batches instead of sweeping in one go', () => {
    db.upsertSessions([row('a'), row('b'), row('c'), row('d'), row('e')]);
    const { queue, pending, drain } = makeQueue(stubSource(['a', 'b', 'c', 'd', 'e']), 2);

    queue.start();
    // start() only schedules; nothing has been read yet.
    expect(pending).toHaveLength(1);
    expect(db.analysisCounts().analyzed).toBe(0);

    pending.shift()?.();
    expect(db.analysisCounts().analyzed).toBe(2);

    drain();
    expect(db.analysisCounts()).toEqual({ analyzed: 5, total: 5 });
  });

  it('reads each session once and then stops', () => {
    db.upsertSessions([row('a'), row('b')]);
    const reads: string[] = [];
    const { queue, drain } = makeQueue(stubSource(['a', 'b'], (id) => reads.push(id)));

    queue.start();
    drain();
    queue.start();
    drain();

    expect(reads).toEqual(['a', 'b']);
  });

  it('records a session it cannot read, so the queue cannot spin on it', () => {
    db.upsertSessions([row('gone')]);
    const reads: string[] = [];
    const { queue, drain } = makeQueue(stubSource([], (id) => reads.push(id)));

    queue.start();
    const ticks = drain();

    expect(ticks).toBeLessThan(5);
    expect(reads).toEqual(['gone']);
    expect(db.analysisCounts()).toEqual({ analyzed: 1, total: 1 });
  });

  it('picks a session back up when its transcript changes', () => {
    db.upsertSessions([row('a', { indexedAtMs: 5_000 })]);
    const { queue, drain } = makeQueue(stubSource(['a']));
    queue.start();
    drain();

    db.upsertSessions([row('a', { indexedAtMs: 6_000 })]);
    expect(db.analysisCounts().analyzed).toBe(0);

    queue.start();
    drain();
    expect(db.analysisCounts().analyzed).toBe(1);
  });

  it('reports its progress as running, then settles', () => {
    db.upsertSessions([row('a')]);
    const { queue, progress, drain } = makeQueue(stubSource(['a']));

    queue.start();
    expect(progress[0]).toEqual({ analyzed: 0, total: 1, running: true });

    drain();
    expect(progress[progress.length - 1]).toEqual({ analyzed: 1, total: 1, running: false });
  });

  it('announces the rows it analyzed, so their list rows can update in place', () => {
    db.upsertSessions([row('a'), row('b')]);
    const { queue, analyzed, drain } = makeQueue(stubSource(['a', 'b']));

    queue.start();
    drain();

    expect(analyzed.flat().map((t) => t.sessionId)).toEqual(['a', 'b']);
  });

  it('folds a start during a pass into one more sweep rather than two at once', () => {
    db.upsertSessions([row('a')]);
    const { queue, pending, drain } = makeQueue(stubSource(['a']));

    queue.start();
    queue.start();
    // Still one continuation in flight — the second start did not fork a pass.
    expect(pending).toHaveLength(1);

    drain();
    expect(db.analysisCounts().analyzed).toBe(1);
  });
});
