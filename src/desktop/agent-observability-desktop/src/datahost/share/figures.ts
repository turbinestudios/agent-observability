import { sessionKey } from '../../shared/rpc';
import { SHARED_SOURCE_ID } from '@agent-observability/core/src/share/sharedSessionModels';

/**
 * What every aggregate leaves out: the sessions the user hid, AND every
 * imported shared session. Someone else's session may be opened and
 * compared, but it is never counted as this user's work, so the overview,
 * insights, hotspots, retrospective trends, evidence, workspace, inbox, AI
 * Helper corpus and the team shard all read through this rather than through
 * the hidden store. Only the Sessions list itself uses the hidden store.
 */
export interface FigureExclusions {
  all(): string[];
  isHidden(source: string, sessionId: string): boolean;
}

export function figureExclusions(
  hidden: { all(): string[]; isHidden(source: string, sessionId: string): boolean },
  sharedIds: () => Iterable<string>,
): FigureExclusions {
  return {
    all: () => [...hidden.all(), ...[...sharedIds()].map((id) => sessionKey(SHARED_SOURCE_ID, id))],
    isHidden: (source, sessionId) => source === SHARED_SOURCE_ID || hidden.isHidden(source, sessionId),
  };
}
