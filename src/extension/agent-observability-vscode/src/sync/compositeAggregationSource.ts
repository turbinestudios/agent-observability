import { AggregationRow } from '../aggregate/aggregator';
import { SessionDataSource } from '../sources/sessionSource';
import type { SyncTelemetry } from './syncEngine';

/**
 * Feeds the {@link SyncEngine} the UNION of every enabled source's aggregation
 * rows, so the opt-in cloud batch covers both Copilot and Claude Code activity
 * (the user opted Claude into org sync). Each source already emits the SAME
 * privacy-safe {@link AggregationRow} shape — distinguished by `model` (e.g.
 * `claude-*`) and `repository` — so the rows commingle without a schema change
 * and never double-count (sessions are disjoint per source).
 *
 * A source whose read fails is skipped rather than failing the whole sync; only
 * when EVERY enabled source fails is a failure surfaced (so a transient Claude
 * read error can't block a Copilot upload, and vice-versa).
 */
export class CompositeAggregationSource implements SyncTelemetry {
  constructor(private readonly enabledSources: () => readonly SessionDataSource[]) {}

  getAggregationRows(
    sinceMs?: number,
    untilMs?: number,
  ): { ok: true; value: AggregationRow[] } | { ok: false; reason: string; message: string } {
    const rows: AggregationRow[] = [];
    let anyOk = false;
    let firstFailure: { ok: false; reason: string; message: string } | undefined;
    for (const source of this.enabledSources()) {
      const result = source.getAggregationRows(sinceMs, untilMs);
      if (result.ok) {
        anyOk = true;
        rows.push(...result.value);
      } else if (firstFailure === undefined) {
        firstFailure = result;
      }
    }
    if (!anyOk && firstFailure !== undefined) {
      return firstFailure;
    }
    return { ok: true, value: rows };
  }
}
