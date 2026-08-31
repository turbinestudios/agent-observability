import type { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type { AnalysisStatus } from '../../shared/rpc';
import type { AnalysisTarget, IndexDb } from '../indexer/indexDb';
import { analyzeSession } from './sessionAnalyzer';

/**
 * The background pass that reads sessions the index alone cannot describe.
 *
 * Listing a session is a directory walk; saying whether it went wrong, or which
 * instruction files it pulled in, means PARSING it. That cost is why the
 * indexers do not do this work: a Claude transcript costs the same again to
 * re-read, and the Copilot indexer never materializes per-span rows at all.
 *
 * So it happens here instead — after the index settles, a few sessions at a
 * time, yielding to the event loop between batches. The data host is a single
 * synchronous thread, so yielding is the whole point: without it a first run
 * would lock the window for as long as the sweep takes. Results are persisted,
 * so the cost is paid once per changed session rather than once per launch.
 */

/** Sessions read per tick. Small enough that a batch never holds the thread long. */
const ANALYSIS_BATCH = 5;

export interface AnalysisQueueDeps {
  db: IndexDb;
  sources: { get(id: string): SessionDataSource | undefined };
  detector: LocalDeviationDetector;
  /** Resolved per session, since accepting a missing file changes the analysis. */
  acceptedMissing: () => AcceptedMissingConfig;
  /** Progress for the views that show how complete the ranking is. */
  onProgress: (status: AnalysisStatus) => void;
  /** Sessions whose stored analysis just changed, so their list rows can update. */
  onAnalyzed: (targets: readonly AnalysisTarget[]) => void;
  /** Seams, so a test can drive the queue to completion synchronously. */
  schedule?: (run: () => void) => void;
  batch?: number;
  now?: () => number;
}

export class AnalysisQueue {
  private running = false;
  /** A restart was asked for mid-pass; drain first, then go round again. */
  private rerunQueued = false;
  private readonly schedule: (run: () => void) => void;
  private readonly batch: number;
  private readonly now: () => number;

  constructor(private readonly deps: AnalysisQueueDeps) {
    this.schedule = deps.schedule ?? ((run) => void setTimeout(run, 0));
    this.batch = deps.batch ?? ANALYSIS_BATCH;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Bring the analysis up to date. Cheap and safe to call on every index pass. */
  start(): void {
    if (this.running) {
      this.rerunQueued = true;
      return;
    }
    this.running = true;
    this.deps.onProgress(this.status());
    this.schedule(() => this.tick());
  }

  status(): AnalysisStatus {
    const counts = this.deps.db.analysisCounts();
    return { analyzed: counts.analyzed, total: counts.total, running: this.running };
  }

  /**
   * One batch. Anything that throws while reading a single session is contained
   * here: one corrupt transcript must not stop the sweep, and the session is
   * still recorded so the queue cannot spin on it forever.
   */
  private tick(): void {
    const targets = this.deps.db.staleAnalysis(this.batch);
    if (targets.length === 0) {
      this.running = false;
      this.deps.onProgress(this.status());
      if (this.rerunQueued) {
        this.rerunQueued = false;
        this.start();
      }
      return;
    }

    const acceptedMissing = this.deps.acceptedMissing();
    for (const target of targets) {
      const source = this.deps.sources.get(target.source);
      let analysis;
      try {
        analysis =
          source === undefined
            ? undefined
            : analyzeSession(source, target.sessionId, { detector: this.deps.detector, acceptedMissing });
      } catch {
        analysis = undefined;
      }
      // A session that cannot be read is recorded as "nothing found", pinned to
      // the row version we tried: it drops out of the queue until its transcript
      // changes, instead of being retried on every pass forever.
      this.deps.db.putAnalysis(
        target.source,
        target.sessionId,
        analysis ?? { deviationCount: 0, errorCount: 0, findings: [], contextFiles: [] },
        target.indexedAtMs,
        this.now(),
      );
    }

    this.deps.onAnalyzed(targets);
    this.deps.onProgress(this.status());
    this.schedule(() => this.tick());
  }
}
