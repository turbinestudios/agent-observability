/**
 * Local context-hotspots reverse index — LOCAL-ONLY.
 *
 * Folds per-(session, file) {@link ContextFileObservation}s (the SAME grain the
 * cloud extractor produces) into a file-keyed view: for each customization file,
 * which local sessions had it in context, how heavy it was, and how often it was
 * applied. This is the reverse of the cloud aggregate — the cloud carries only a
 * `distinctSessionCount` (identities are barred from upload), so this index exists
 * purely on-machine to let a developer go from a Context Hotspot on the dashboard
 * back to the concrete session ids to investigate in the agent debug logs.
 *
 * Pure + headless: no `vscode` / `node:*` imports, so it runs under vitest with
 * plain observation inputs.
 */

import type { ContextInsightCategory } from './contextInsightsModels';
import type { ContextFileObservation } from './contextInsightsExtractor';

/** One local session that had a given customization file in its context. */
export interface ContextHotspotSession {
  /** LOCAL session id — NEVER uploaded; used to open the session detail view. */
  sessionKey: string;
  startTimeMs: number;
  applied: boolean;
  estTokens: number;
  hadError: boolean;
  hadDeviation: boolean;
}

/** One customization file plus the local sessions that used it. */
export interface ContextHotspot {
  /** Repo-relative POSIX path of the customization file. */
  contextFile: string;
  category: ContextInsightCategory;
  repository: string;
  /** Distinct contributing sessions (newest first). */
  sessions: ContextHotspotSession[];
  /** Sessions in which the file was applied (in the context envelope). */
  appliedCount: number;
  /** Largest per-session estimated token weight seen for this file. */
  estTokensMax: number;
}

/** Composite key for a hotspot: a file is unique within its repository. */
function hotspotKey(repository: string, contextFile: string): string {
  return `${repository}\u0000${contextFile}`;
}

/**
 * Build the file→sessions hotspot index from raw observations. Hotspots are
 * sorted by contributing-session count (desc), then estimated weight (desc), then
 * path; each hotspot's sessions are sorted newest-first with duplicates (same
 * session id) folded into one entry.
 */
export function buildContextHotspots(
  observations: readonly ContextFileObservation[],
): ContextHotspot[] {
  const byFile = new Map<string, {
    contextFile: string;
    category: ContextInsightCategory;
    repository: string;
    sessions: Map<string, ContextHotspotSession>;
  }>();

  for (const obs of observations) {
    const key = hotspotKey(obs.repository, obs.contextFile);
    let group = byFile.get(key);
    if (group === undefined) {
      group = {
        contextFile: obs.contextFile,
        category: obs.category,
        repository: obs.repository,
        sessions: new Map<string, ContextHotspotSession>(),
      };
      byFile.set(key, group);
    }
    const existing = group.sessions.get(obs.sessionKey);
    if (existing === undefined) {
      group.sessions.set(obs.sessionKey, {
        sessionKey: obs.sessionKey,
        startTimeMs: obs.startTimeMs,
        applied: obs.applied,
        estTokens: obs.estTokens,
        hadError: obs.hadError,
        hadDeviation: obs.hadDeviation,
      });
    } else {
      // Fold a repeat (session, file): keep applied if either was, and the max weight.
      existing.applied = existing.applied || obs.applied;
      existing.estTokens = Math.max(existing.estTokens, obs.estTokens);
      existing.hadError = existing.hadError || obs.hadError;
      existing.hadDeviation = existing.hadDeviation || obs.hadDeviation;
      existing.startTimeMs = Math.min(existing.startTimeMs, obs.startTimeMs);
    }
  }

  const hotspots: ContextHotspot[] = [];
  for (const group of byFile.values()) {
    const sessions = [...group.sessions.values()].sort((a, b) => b.startTimeMs - a.startTimeMs);
    const appliedCount = sessions.filter((s) => s.applied).length;
    const estTokensMax = sessions.reduce((max, s) => Math.max(max, s.estTokens), 0);
    hotspots.push({
      contextFile: group.contextFile,
      category: group.category,
      repository: group.repository,
      sessions,
      appliedCount,
      estTokensMax,
    });
  }

  hotspots.sort((a, b) => {
    if (b.sessions.length !== a.sessions.length) {
      return b.sessions.length - a.sessions.length;
    }
    if (b.estTokensMax !== a.estTokensMax) {
      return b.estTokensMax - a.estTokensMax;
    }
    return a.contextFile.localeCompare(b.contextFile);
  });

  return hotspots;
}

/** Whether more than one distinct repository is represented in the hotspots. */
export function hasMultipleRepositories(hotspots: readonly ContextHotspot[]): boolean {
  const repos = new Set<string>();
  for (const h of hotspots) {
    repos.add(h.repository);
    if (repos.size > 1) {
      return true;
    }
  }
  return false;
}
