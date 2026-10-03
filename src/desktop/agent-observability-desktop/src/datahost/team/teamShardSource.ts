import * as path from 'node:path';
import type { AggregationRow } from '@agent-observability/core/src/aggregate/aggregator';
import type { ContextFileObservation } from '@agent-observability/core/src/aggregate/contextInsightsExtractor';
import type { ContextInsightCategory } from '@agent-observability/core/src/aggregate/contextInsightsModels';
import { isSafeContextFilePath } from '@agent-observability/core/src/aggregate/customizationFilter';
import { isRepositoryIncluded, type RepoSyncPolicy } from '@agent-observability/core/src/aggregate/repoSyncPolicy';
import type { OutcomeInput } from '@agent-observability/core/src/team/teamShardBuilder';
import type { OutcomeCostMode, OutcomeVerdict } from '@agent-observability/core/src/team/teamShardModels';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { IndexDb } from '../indexer/indexDb';
import { resolveRepoRoot, type RepoRootSeams } from '../improve/repoRoot';

/**
 * What goes INTO the team shard, gathered from this machine: aggregation rows
 * from the same source methods the extension's sync uses, context-file
 * observations derived from the index, and per-session outcomes from the
 * retrospective projection. Each collector applies the same three filters —
 * hidden sessions out, repository policy, closed-set labels only — so the
 * three parts of the shard always describe the same set of sessions.
 */

export interface ShardSourceDeps {
  db: IndexDb;
  sources: { enabled(): readonly SessionDataSource[]; get(id: string): SessionDataSource | undefined };
  hidden: { all(): string[]; isHidden(source: string, sessionId: string): boolean };
  policy: RepoSyncPolicy;
  repoRootSeams?: RepoRootSeams;
}

const CATEGORIES: ReadonlySet<string> = new Set<ContextInsightCategory>(['instruction', 'skill', 'agent', 'hook', 'prompt']);

/** Aggregation rows from every enabled source, hidden sessions and excluded repositories removed. */
export function collectAggregationRows(deps: ShardSourceDeps, sinceMs: number, untilMs: number): AggregationRow[] {
  const rows: AggregationRow[] = [];
  for (const source of deps.sources.enabled()) {
    let result;
    try {
      result = source.getAggregationRows(sinceMs, untilMs);
    } catch {
      continue;
    }
    if (!result.ok) {
      continue;
    }
    for (const row of result.value) {
      if (deps.hidden.isHidden(source.id, row.sessionKey)) {
        continue;
      }
      if (!isRepositoryIncluded(row.repository, deps.policy)) {
        continue;
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Context-file observations from the index's `context_files` rows. The index
 * stores ABSOLUTE paths; each is made repo-relative under its repository's
 * re-verified checkout root and must then pass the same allowlist pattern the
 * extension enforces, or it is dropped. Anything outside a checkout (a
 * user-level `~/.claude/CLAUDE.md`) never leaves the machine.
 */
export function collectContextObservations(deps: ShardSourceDeps, sinceMs: number, untilMs: number): ContextFileObservation[] {
  const rows = deps.db.contextFileObservationRows(sinceMs, untilMs, deps.hidden.all());
  const roots = new Map<string, string | undefined>();
  const rootFor = (repository: string): string | undefined => {
    if (!roots.has(repository)) {
      const resolved = resolveRepoRoot(repository, deps.db, deps.repoRootSeams);
      roots.set(repository, 'root' in resolved ? resolved.root : undefined);
    }
    return roots.get(repository);
  };

  const observations: ContextFileObservation[] = [];
  for (const row of rows) {
    if (!isRepositoryIncluded(row.repository, deps.policy) || row.repository === 'unknown') {
      continue;
    }
    if (!CATEGORIES.has(row.category) || row.status === 'read') {
      continue;
    }
    const root = rootFor(row.repository);
    if (root === undefined) {
      continue;
    }
    const relative = repoRelativePosix(row.file, root);
    if (relative === undefined || !isSafeContextFilePath(relative)) {
      continue;
    }
    const applied = row.status === 'applied';
    observations.push({
      startTimeMs: row.startedAtMs,
      sessionKey: row.sessionId,
      repository: row.repository,
      contextFile: relative,
      category: row.category as ContextInsightCategory,
      applied,
      estTokens: applied ? row.estTokens : 0,
      ...(applied ? {} : { skipReason: 'other' as const }),
      hadError: row.errorCount > 0,
      hadDeviation: row.deviationCount > 0,
    });
  }
  return observations;
}

/** Per-session outcomes: verdict (or unjudged), cost and the source's billing basis. */
export function collectOutcomes(deps: ShardSourceDeps, sinceMs: number, untilMs: number): OutcomeInput[] {
  const rows = deps.db.outcomeInputs(sinceMs, untilMs, deps.hidden.all());
  const outcomes: OutcomeInput[] = [];
  for (const row of rows) {
    if (!isRepositoryIncluded(row.repository, deps.policy)) {
      continue;
    }
    const costMode = (deps.sources.get(row.source)?.costMode ?? 'usd') as OutcomeCostMode;
    outcomes.push({
      endedAtMs: row.endedAtMs,
      repository: row.repository,
      source: row.source,
      verdict: toOutcomeVerdict(row.verdict),
      costMicros: row.costMicros ?? undefined,
      costMode,
    });
  }
  return outcomes;
}

function toOutcomeVerdict(raw: string | null | undefined): OutcomeVerdict | undefined {
  switch (raw) {
    case 'smooth':
    case 'bumpy':
    case 'struggled':
    case 'abandoned':
      return raw;
    default:
      return undefined;
  }
}

/**
 * Repo-relative POSIX path of an absolute file under `root`, or `undefined`
 * when the file lies outside it. Strict on purpose: the improvement plan's
 * `promptSafePath` falls back to a bare file name for display, but a shard
 * must drop what it cannot place inside the checkout.
 */
export function repoRelativePosix(file: string, root: string): string | undefined {
  if (!path.isAbsolute(file)) {
    return undefined;
  }
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}
