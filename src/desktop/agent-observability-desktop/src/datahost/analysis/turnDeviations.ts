import { groupInteractionsByTurn } from '@agent-observability/core/src/deviation/turnGrouping';
import type { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { ContentLookup } from '@agent-observability/core/src/deviation/deviationDetector';
import type { WorkflowDeviation } from '@agent-observability/core/src/deviation/models';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { SessionDetail } from '@agent-observability/core/src/telemetry/models';

/**
 * Per-turn workflow deviations for one session — the single place this app
 * decides what "abnormal" means.
 *
 * Both the detail view (which draws a card per deviation) and the background
 * analyzer (which counts them for the list badge) call this, so a session can
 * never be flagged in the list and look clean when opened. The wiring mirrors
 * the extension's `sessionDetailPanel.detectTurnDeviations`.
 *
 * Unlike the extension, detection runs with core's synthesized DEFAULT workflow
 * when the repository has none configured — the desktop app has no workflow
 * editor, so requiring configuration would leave the feature switched off for
 * everyone. Configuring a workflow for a repository replaces that default.
 */
export function detectTurnDeviations(
  source: SessionDataSource,
  sessionId: string,
  detail: SessionDetail,
  detector: LocalDeviationDetector,
): WorkflowDeviation[][] {
  const empty = detail.turns.map(() => [] as WorkflowDeviation[]);
  if (detail.turns.length === 0) {
    return empty;
  }

  const interactions = source.getSessionInteractions(sessionId);
  if (!interactions.ok) {
    // A session whose metadata cannot be read is not a session with no
    // deviations, but an empty array is the only shape the renderer can index.
    return empty;
  }

  const turns = groupInteractionsByTurn(
    interactions.value,
    detail.turns.map((t) => t.timestampMs),
  );
  return detector.detectForTurnsWithDefaults(
    turns,
    detail.summary.repository,
    contentLookupFor(source, sessionId),
  );
}

/**
 * A memoized LOCAL-ONLY content lookup for the detector's content predicates.
 *
 * Each source supplies its own content — Copilot from span attributes, Claude
 * reconstructed from the transcript — and a source that implements none leaves
 * content predicates inert rather than failing. The raw text is read on this
 * machine to compute a boolean and never enters a deviation.
 */
function contentLookupFor(source: SessionDataSource, sessionId: string): ContentLookup {
  const cache = new Map<string, ReadonlyMap<string, string>>();
  return (attribute: string): ReadonlyMap<string, string> => {
    let values = cache.get(attribute);
    if (values === undefined) {
      const result = source.getSessionContent?.(sessionId, attribute);
      values = result?.ok === true ? result.value : new Map<string, string>();
      cache.set(attribute, values);
    }
    return values;
  };
}
