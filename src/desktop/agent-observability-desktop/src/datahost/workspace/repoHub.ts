import { evaluateAdvice, type RetrospectiveCounts, type RetrospectiveSignalId, type SessionVerdict } from '@agent-observability/core/src/analysis/retrospective';
import type {
  AnalysisStatus,
  ContextPlanSummary,
  LiveSessionRow,
  OverviewWindow,
  RepoHubData,
  RepositoryCards,
  RepositoryDigestInput,
  SessionRow,
} from '../../shared/rpc';
import { windowStartMs } from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import { promptSafePath } from '../improve/contextPlan';
import { inventoryForRepository, type InventorySeams } from './contextInventory';

/**
 * The repository hub: everything the app knows about one repository, in one
 * call, plus the input for its locally built digest.
 *
 * Reads only the index and the JSON stores: nothing here parses a transcript.
 * The digest's tool section comes from the per-tool rows the analysis pass
 * persists (proposal 7), so it covers every analyzed session in the window.
 */

/** Recent sessions listed on the hub. */
export const HUB_RECENT_LIMIT = 8;
/** Tools the digest lists. */
export const DIGEST_TOOL_LIMIT = 10;
/** Themes the hub and the digest rank. */
export const HUB_THEME_LIMIT = 8;

export interface RepoHubDeps {
  db: IndexDb;
  hiddenKeys: () => string[];
  /** Layers renames, tags and notes onto index rows (the datahost's `decorate`). */
  decorate: (rows: SessionRow[]) => SessionRow[];
  liveRows: () => LiveSessionRow[];
  plans: (repository: string) => ContextPlanSummary[];
  analysisStatus: () => AnalysisStatus;
  now?: () => number;
  inventorySeams?: InventorySeams;
}

/** The two equal-length windows the hub compares: this one and the one before. */
function windows(window: OverviewWindow, now: number): { cutoff: number; previousCutoff: number; windowDays: number } {
  if (window === 'all') {
    return { cutoff: 0, previousCutoff: 0, windowDays: 0 };
  }
  const cutoff = windowStartMs(window, now);
  return { cutoff, previousCutoff: windowStartMs(window * 2, now), windowDays: window };
}

export function buildRepositoryCards(
  window: OverviewWindow,
  db: IndexDb,
  hiddenKeys: readonly string[],
  live: readonly LiveSessionRow[],
): RepositoryCards {
  const { cards, unknownSessions } = db.repositoryCards(window, hiddenKeys);
  const liveByRepo = new Map<string, { live: number; waiting: number }>();
  for (const row of live) {
    if (row.status === 'finished') {
      continue;
    }
    const entry = liveByRepo.get(row.repository) ?? { live: 0, waiting: 0 };
    entry.live += 1;
    if (row.status === 'waiting') {
      entry.waiting += 1;
    }
    liveByRepo.set(row.repository, entry);
  }
  return {
    cards: cards.map((card) => ({
      ...card,
      live: liveByRepo.get(card.repository)?.live ?? 0,
      waiting: liveByRepo.get(card.repository)?.waiting ?? 0,
    })),
    unknownSessions,
    window,
  };
}

export function buildRepoHub(repository: string, window: OverviewWindow, deps: RepoHubDeps): RepoHubData {
  const now = deps.now?.() ?? Date.now();
  const hidden = deps.hiddenKeys();
  const { cutoff, previousCutoff, windowDays } = windows(window, now);
  const hasPrevious = window !== 'all';

  const totals = deps.db.repoTotals(repository, cutoff, undefined, hidden);
  const previous = hasPrevious
    ? deps.db.repoTotals(repository, previousCutoff, cutoff, hidden)
    : { sessions: 0, costMicros: 0 };
  const verdicts = deps.db.repoVerdicts(repository, cutoff, undefined, hidden);
  const previousVerdicts = hasPrevious
    ? deps.db.repoVerdicts(repository, previousCutoff, cutoff, hidden)
    : { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 };
  const themes = deps.db.repoThemes(repository, cutoff, undefined, hidden, HUB_THEME_LIMIT);
  const previousThemes = hasPrevious
    ? new Map(deps.db.repoThemes(repository, previousCutoff, cutoff, hidden, 50).map((t) => [t.signalId, t.sessions]))
    : new Map<string, number>();

  return {
    repository,
    window,
    windowDays,
    totals,
    previousTotals: { sessions: previous.sessions, costMicros: previous.costMicros },
    verdicts,
    previousVerdicts,
    themes: themes.map((theme) => ({ ...theme, previousSessions: previousThemes.get(theme.signalId) ?? 0 })),
    models: deps.db.repoModels(repository, cutoff, hidden),
    recent: deps.decorate(
      deps.db.listSessions(
        { repository, limit: HUB_RECENT_LIMIT, ...(cutoff > 0 ? { endedAfterMs: cutoff } : {}) },
        hidden,
      ),
    ),
    live: deps.liveRows().filter((row) => row.repository === repository),
    contextUsage: deps.db.hotspots({ repository, ...(cutoff > 0 ? { endedAfterMs: cutoff } : {}) }, hidden),
    inventory: inventoryForRepository(repository, deps.db, hidden, deps.inventorySeams),
    plans: deps.plans(repository),
    status: deps.analysisStatus(),
  };
}

/**
 * The digest input. Every path is made repo-relative (or reduced to its file
 * name) BEFORE it leaves the datahost, and no branch name is carried, so the
 * renderer can turn this into Markdown the user may paste anywhere.
 */
export function buildRepoDigestInput(
  repository: string,
  window: OverviewWindow,
  deps: RepoHubDeps,
): RepositoryDigestInput {
  const now = deps.now?.() ?? Date.now();
  const hidden = deps.hiddenKeys();
  const { cutoff, previousCutoff, windowDays } = windows(window, now);
  const hasPrevious = window !== 'all';
  const totals = deps.db.repoTotals(repository, cutoff, undefined, hidden);
  const previous = hasPrevious ? deps.db.repoTotals(repository, previousCutoff, cutoff, hidden) : undefined;
  const verdicts = deps.db.repoVerdicts(repository, cutoff, undefined, hidden);
  const previousVerdicts = hasPrevious
    ? deps.db.repoVerdicts(repository, previousCutoff, cutoff, hidden)
    : { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 };
  const themes = deps.db.repoThemes(repository, cutoff, undefined, hidden, HUB_THEME_LIMIT);
  const previousThemes = hasPrevious
    ? new Map(deps.db.repoThemes(repository, previousCutoff, cutoff, hidden, 50).map((t) => [t.signalId, t.sessions]))
    : new Map<string, number>();
  const cards = deps.db.repositoryCards(window, hidden).cards.find((c) => c.repository === repository);

  const inventory = inventoryForRepository(repository, deps.db, hidden, deps.inventorySeams);
  const root = 'root' in inventory ? inventory.root : undefined;
  const hotspots = deps.db.hotspots({ repository, ...(cutoff > 0 ? { endedAfterMs: cutoff } : {}) }, hidden);

  return {
    repository,
    windowDays,
    generatedAtMs: now,
    sessions: {
      total: totals.sessions,
      previousTotal: previous?.sessions ?? 0,
      bySource: cards?.bySource ?? [],
      verdicts,
      previousVerdicts,
    },
    // Labels are the renderer's (it owns the theme wording); the id doubles as
    // the fallback so the datahost never grows a second copy of that table.
    themes: themes.map((theme) => ({
      signalId: theme.signalId,
      label: theme.signalId,
      sessions: theme.sessions,
      previousSessions: previousThemes.get(theme.signalId) ?? 0,
      occurrences: theme.occurrences,
    })),
    tips: rankTips(deps.db.repoSessionFindings(repository, cutoff, hidden)),
    hotspots: hotspots.slice(0, 10).map((row) => ({
      path: root !== undefined ? promptSafePath(row.file, root) : safeName(row.file),
      category: row.category,
      sessionCount: row.sessionCount,
      appliedCount: row.appliedCount,
      skippedCount: row.skippedCount,
      estTokensMax: row.estTokensMax,
    })),
    models: deps.db.repoModels(repository, cutoff, hidden).map((m) => ({
      model: m.model,
      sessions: m.sessions,
      costMicros: m.costMicros,
    })),
    ...digestTools(deps.db, repository, cutoff, hidden),
    tokens: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedTokens: totals.cachedTokens,
      costMicros: totals.costMicros,
      costSessions: totals.costSessions,
    },
    contextFiles:
      'files' in inventory
        ? inventory.files.map((file) => ({
            relPath: file.relPath,
            kind: file.kind,
            agent: file.agent,
            estTokens: file.estTokens,
            seenInSessions: file.usage?.sessionCount ?? 0,
            skippedCount: file.usage?.skippedCount ?? 0,
          }))
        : [],
  };
}

/**
 * Which static tips fire most often across this repository's judged sessions.
 * Evaluated with core's own advice table per session, then counted by tip id,
 * so the digest says "this advice applied to N sessions" rather than quoting
 * any one session.
 */
function rankTips(
  rows: ReturnType<IndexDb['repoSessionFindings']>,
): RepositoryDigestInput['tips'] {
  const byId = new Map<string, { text: string; sessions: number }>();
  for (const row of rows) {
    const counts: RetrospectiveCounts = {
      verdict: row.verdict as SessionVerdict,
      outcome: row.outcome as RetrospectiveCounts['outcome'],
      correctionTurns: row.correctionTurns,
      repeatedPromptTurns: row.repeatedPromptTurns,
      interruptions: row.interruptions,
      errorStreaks: row.errorStreaks,
      maxErrorStreak: row.maxErrorStreak,
      longTailTurns: row.longTailTurns,
      compactions: row.compactions,
      churnRatioPct: row.churnRatioPct,
      planModeUsed: row.planModeUsed,
      ...(row.firstPromptRating !== undefined
        ? { firstPromptRating: row.firstPromptRating as RetrospectiveCounts['firstPromptRating'] }
        : {}),
      tipCount: row.tipCount,
    };
    const present = new Set(row.signalIds as RetrospectiveSignalId[]);
    for (const tip of evaluateAdvice(present, counts)) {
      const entry = byId.get(tip.id);
      if (entry === undefined) {
        byId.set(tip.id, { text: tip.text, sessions: 1 });
      } else {
        entry.sessions += 1;
      }
    }
  }
  return [...byId.entries()]
    .map(([id, entry]) => ({ id, text: entry.text, sessions: entry.sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id));
}

/** Per-tool call and failure counts over every analyzed session in the window. */
function digestTools(
  db: IndexDb,
  repository: string,
  cutoff: number,
  hidden: readonly string[],
): Pick<RepositoryDigestInput, 'tools'> {
  const rows = db.toolRanking({ repository, ...(cutoff > 0 ? { endedAfterMs: cutoff } : {}) }, hidden, DIGEST_TOOL_LIMIT);
  if (rows.length === 0) {
    return {};
  }
  return { tools: rows.map((row) => ({ name: row.tool, calls: row.calls, failures: row.failures })) };
}

/** The file name alone — for a hotspot whose checkout root is unknown. */
function safeName(file: string): string {
  const segments = file.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.length === 0 ? file : segments[segments.length - 1];
}
