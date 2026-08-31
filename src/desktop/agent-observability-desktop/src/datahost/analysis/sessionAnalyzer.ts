import type { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type {
  ContextFileCategory,
  ContextFileEntry,
  ContextFileStatus,
} from '@agent-observability/core/src/context/models';
import type {
  RetrospectiveCounts,
  RetrospectiveFinding,
  RetrospectiveSignalId,
} from '@agent-observability/core/src/analysis/retrospective';
import { detectTurnDeviations } from './turnDeviations';
import { retrospectiveFor } from './sessionRetrospective';

/**
 * Everything one session yields to the two views that need it read rather than
 * listed: the deviation badge and filter, and the Context Hotspots ranking.
 *
 * The two are computed together deliberately. Both need the session PARSED —
 * for Claude that means reading the transcript and walking the `.claude` tree —
 * and doing it once per session instead of once per feature halves the cost of
 * the background pass that drives them.
 *
 * Everything here stays on this machine. Nothing produced by this module reaches
 * the aggregate or sync paths.
 */

/** One customization file as it appeared in one session's context window. */
export interface AnalyzedContextFile {
  /** Short display name, e.g. `CLAUDE.md` or a skill's slug. */
  name: string;
  /** Resolved absolute path when known; the identity used to rank files. */
  filePath?: string;
  category: ContextFileCategory;
  status: ContextFileStatus;
  /** Estimated tokens the file occupied (0 when unknown or skipped). */
  estTokens: number;
}

/**
 * One retrospective signal as the index stores it — id, worst severity, and how
 * often it fired in the session. Ids and enum labels only, never content.
 */
export interface AnalyzedFinding {
  id: RetrospectiveSignalId;
  severity: 'info' | 'friction' | 'blocker';
  count: number;
}

/** What the background pass records per session. */
export interface SessionAnalysis {
  /** Total per-turn workflow deviations across the session. */
  deviationCount: number;
  /** Interactions that failed — the hotspots view's error co-occurrence signal. */
  errorCount: number;
  /**
   * The retrospective's compact projection — verdict, correction and
   * interruption counts, churn — behind the list's verdict chip and the Retro
   * view. `undefined` when the retrospective could not be built, which the
   * index stores as NULL: "not judged" must never read as "smooth".
   */
  retro?: RetrospectiveCounts;
  /**
   * The retrospective's findings folded per signal id — the Dashboard's
   * recurring-themes grain. Empty when the retrospective could not be built.
   */
  findings: AnalyzedFinding[];
  contextFiles: AnalyzedContextFile[];
}

export interface AnalyzerDeps {
  detector: LocalDeviationDetector;
  acceptedMissing: AcceptedMissingConfig;
}

/**
 * Analyze one session. Returns `undefined` only when the session cannot be read
 * at all — a transcript deleted since it was indexed — so the caller can leave
 * the row unanalyzed rather than record a misleading zero.
 *
 * The context breakdown is optional per source and allowed to fail: a session is
 * still worth flagging for deviations without it, which is why a failure here
 * empties `contextFiles` rather than failing the analysis.
 */
export function analyzeSession(
  source: SessionDataSource,
  sessionId: string,
  deps: AnalyzerDeps,
): SessionAnalysis | undefined {
  const detail = source.getSessionDetail(sessionId);
  if (!detail.ok) {
    return undefined;
  }

  const deviationCount = detectTurnDeviations(
    source,
    sessionId,
    detail.value,
    deps.detector,
  ).reduce((sum, turn) => sum + turn.length, 0);

  const interactions = source.getSessionInteractions(sessionId);
  const errorCount = interactions.ok
    ? interactions.value.filter((i) => !i.success).length
    : 0;

  // A retrospective failure must not cost the deviation badge: the two ride
  // the same analysis row but are independent results.
  let retro: RetrospectiveCounts | undefined;
  let findings: AnalyzedFinding[] = [];
  try {
    const retrospective = retrospectiveFor(source, sessionId, detail.value);
    retro = retrospective.counts;
    findings = projectFindings(retrospective.findings);
  } catch {
    retro = undefined;
    findings = [];
  }

  return {
    deviationCount,
    errorCount,
    ...(retro !== undefined ? { retro } : {}),
    findings,
    contextFiles: contextFilesOf(source, sessionId, deps),
  };
}

const SEVERITY_RANK = { blocker: 0, friction: 1, info: 2 } as const;

/**
 * Fold a retrospective's findings to one row per signal id: how often it fired
 * and the worst severity it reached. This is the projection the index stores —
 * descriptions and turn references stay behind, recomputed on demand like the
 * rest of the narrative.
 */
export function projectFindings(findings: readonly RetrospectiveFinding[]): AnalyzedFinding[] {
  const byId = new Map<RetrospectiveSignalId, AnalyzedFinding>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    if (existing === undefined) {
      byId.set(finding.id, { id: finding.id, severity: finding.severity, count: 1 });
    } else {
      existing.count += 1;
      if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = finding.severity;
      }
    }
  }
  return [...byId.values()];
}

/**
 * The session's context files, flattened from core's per-agent analysis.
 *
 * `total` is the deduplicated union across the main thread and every sub-agent,
 * which is exactly the grain the hotspots ranking wants: a file loaded by three
 * sub-agents in one session is one session's worth of evidence, not three.
 */
function contextFilesOf(
  source: SessionDataSource,
  sessionId: string,
  deps: AnalyzerDeps,
): AnalyzedContextFile[] {
  let loaded: ContextFileEntry[];
  try {
    const analysis = source.getContextAnalysis?.(sessionId, deps.acceptedMissing);
    if (analysis === undefined) {
      return [];
    }
    loaded = analysis.total.loadedFiles;
  } catch {
    return [];
  }

  return loaded.map((entry) => ({
    name: entry.name,
    ...(entry.filePath !== undefined ? { filePath: entry.filePath } : {}),
    category: entry.category,
    status: entry.status,
    estTokens: entry.estimatedTokens ?? 0,
  }));
}
