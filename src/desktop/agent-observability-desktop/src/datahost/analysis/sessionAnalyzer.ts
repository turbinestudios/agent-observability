import type { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type {
  ContextFileCategory,
  ContextFileEntry,
  ContextFileStatus,
} from '@agent-observability/core/src/context/models';
import { detectTurnDeviations } from './turnDeviations';

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

/** What the background pass records per session. */
export interface SessionAnalysis {
  /** Total per-turn workflow deviations across the session. */
  deviationCount: number;
  /** Interactions that failed — the hotspots view's error co-occurrence signal. */
  errorCount: number;
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

  return { deviationCount, errorCount, contextFiles: contextFilesOf(source, sessionId, deps) };
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
