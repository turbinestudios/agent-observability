import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { SessionDetail } from '@agent-observability/core/src/telemetry/models';
import {
  buildSessionRetrospective,
  type SessionRetrospective,
} from '@agent-observability/core/src/analysis/retrospective';

/**
 * The single place this app builds a session's retrospective — the analog of
 * `./turnDeviations.ts` for deviations, and for the same reason: both the
 * background analyzer (which persists the counts behind the list's verdict
 * chip) and the detail renderer (which shows the narrative card) go through
 * here, so the chip and the card can never disagree about a session.
 *
 * A source that implements `getSessionRetrospective` (Claude) enriches the
 * shared turn analysis with transcript-only signals — interruptions,
 * compactions, plan mode. Any other source gets the degraded-but-honest
 * `buildSessionRetrospective(detail)`: transcript-only findings simply stay
 * absent rather than wrong.
 *
 * Everything returned is LOCAL-ONLY content-derived data; only the numeric
 * `counts` projection may be persisted (see `indexDb.putAnalysis`).
 */
export function retrospectiveFor(
  source: SessionDataSource,
  sessionId: string,
  detail: SessionDetail,
): SessionRetrospective {
  const viaSource = source.getSessionRetrospective?.(sessionId);
  if (viaSource !== undefined && viaSource.ok) {
    return viaSource.value;
  }
  return buildSessionRetrospective(detail);
}
