import { LATENCY_BOUNDS_MS } from '../aggregate/models';
import type { Interaction } from '../telemetry/models';

/**
 * Per-tool call statistics for one session, folded from the interactions every
 * source already produces (proposal 7). Counts and durations only: a tool's
 * NAME is the single string kept, and no argument, path or output is read.
 *
 * LOCAL-ONLY, like every analysis projection. It reuses the aggregate batch's
 * latency bounds (imported read-only) so a later local percentile and the
 * shared histogram can never disagree about where a bucket ends, but nothing
 * here is on, or may be added to, the aggregate/sync/team paths.
 *
 * Scope, stated once because the UI repeats it: for Claude Code these are the
 * MAIN-THREAD tool calls. The interactions come from
 * `ClaudeCodeService.getSessionInteractions`, which loads the session without
 * its sub-agent side-chains, so a tool a sub-agent ran is not counted here.
 * Copilot interactions carry every tool span the trace recorded.
 *
 * Two caveats the views must state rather than hide:
 * - A duration is "time to result" — from the call being issued to its result
 *   landing. For Claude Code that includes any wait on a permission prompt.
 * - A Copilot span with an unset status counts as success, so a Copilot
 *   failure rate is a lower bound.
 */

/** Buckets are the eight shared bounds plus one overflow bucket. */
export const TOOL_DURATION_BUCKETS = LATENCY_BOUNDS_MS.length + 1;

export interface ToolStat {
  name: string;
  calls: number;
  failures: number;
  durationMsSum: number;
  durationMsMax: number;
  /** Call counts per duration bucket; length {@link TOOL_DURATION_BUCKETS}. */
  buckets: number[];
}

function emptyBuckets(): number[] {
  return new Array<number>(TOOL_DURATION_BUCKETS).fill(0);
}

/** Index of the bucket a duration falls in: the first bound it does not exceed. */
export function durationBucket(durationMs: number): number {
  const value = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i += 1) {
    if (value <= LATENCY_BOUNDS_MS[i]) {
      return i;
    }
  }
  return LATENCY_BOUNDS_MS.length;
}

/** Fold one session's interactions into per-tool rows, busiest first. */
export function foldToolStats(interactions: readonly Interaction[]): ToolStat[] {
  const byName = new Map<string, ToolStat>();
  for (const interaction of interactions) {
    if (interaction.operation !== 'execute_tool') {
      continue;
    }
    const name = interaction.toolName?.trim();
    if (name === undefined || name.length === 0) {
      continue;
    }
    let stat = byName.get(name);
    if (stat === undefined) {
      stat = { name, calls: 0, failures: 0, durationMsSum: 0, durationMsMax: 0, buckets: emptyBuckets() };
      byName.set(name, stat);
    }
    const duration = Number.isFinite(interaction.durationMs) && interaction.durationMs > 0 ? interaction.durationMs : 0;
    stat.calls += 1;
    if (!interaction.success) {
      stat.failures += 1;
    }
    stat.durationMsSum += duration;
    stat.durationMsMax = Math.max(stat.durationMsMax, duration);
    stat.buckets[durationBucket(duration)] += 1;
  }
  return sortStats([...byName.values()]);
}

/** Add rows for the same tool together (several sessions into one ranking). */
export function mergeToolStats(groups: readonly (readonly ToolStat[])[]): ToolStat[] {
  const byName = new Map<string, ToolStat>();
  for (const group of groups) {
    for (const row of group) {
      const stat = byName.get(row.name);
      if (stat === undefined) {
        byName.set(row.name, { ...row, buckets: normalizeBuckets(row.buckets) });
        continue;
      }
      stat.calls += row.calls;
      stat.failures += row.failures;
      stat.durationMsSum += row.durationMsSum;
      stat.durationMsMax = Math.max(stat.durationMsMax, row.durationMsMax);
      const incoming = normalizeBuckets(row.buckets);
      stat.buckets = stat.buckets.map((count, i) => count + incoming[i]);
    }
  }
  return sortStats([...byName.values()]);
}

/**
 * Approximate percentile from the bucket counts: the upper bound of the bucket
 * holding the p-th call. The overflow bucket has no bound, so it answers with
 * the last bound (callers show it as "over N"). `undefined` when no call was
 * recorded.
 */
export function approxPercentile(buckets: readonly number[], p: number): number | undefined {
  const counts = normalizeBuckets(buckets);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return undefined;
  }
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.max(1, Math.ceil(clamped * total));
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i];
    if (seen >= rank) {
      return LATENCY_BOUNDS_MS[Math.min(i, LATENCY_BOUNDS_MS.length - 1)];
    }
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
}

/** True when the p-th call landed in the unbounded overflow bucket. */
export function percentileOverflows(buckets: readonly number[], p: number): boolean {
  const counts = normalizeBuckets(buckets);
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return false;
  }
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, p)) * total));
  const beforeOverflow = total - counts[counts.length - 1];
  return rank > beforeOverflow;
}

function normalizeBuckets(buckets: readonly number[]): number[] {
  const out = emptyBuckets();
  for (let i = 0; i < out.length; i += 1) {
    const value = buckets[i];
    out[i] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }
  return out;
}

function sortStats(stats: ToolStat[]): ToolStat[] {
  return stats.sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
