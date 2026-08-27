import { describe, it, expect } from 'vitest';
import {
  LocatedDivergence,
  divergenceKey,
  selectNewDivergences,
  settledTurnIndices,
} from './divergenceNotices';
import { DeviationType } from './models';

function located(
  sessionKey: string,
  turnStartMs: number,
  workflowName: string,
  type = DeviationType.MissingSteps,
  sourceId = 'copilot',
): LocatedDivergence {
  return {
    sourceId,
    sessionKey,
    turnStartMs,
    deviation: {
      repository: 'https://github.com/org/repo',
      workflowName,
      type,
      description: 'd',
      detectedAt: 0,
    },
  };
}

describe('settledTurnIndices', () => {
  const starts = [1000, 2000, 3000];

  it('treats a turn as settled once the next turn started >= settleMs ago', () => {
    // now = 2500, settle = 100. Turn 0 ends at 2000 (>=100 ago) → settled.
    // Turn 1 ends at 3000 (in the future) → not settled. Turn 2 ends at sessionEnd.
    expect(settledTurnIndices(starts, 4000, 2500, 100)).toEqual([0]);
  });

  it('settles the LAST turn against the session end + settle window', () => {
    // now = 5000, sessionEnd = 3500, settle = 1000 → last turn (ends 3500) settled.
    expect(settledTurnIndices(starts, 3500, 5000, 1000)).toEqual([0, 1, 2]);
  });

  it('does not settle the last turn while it is still within the settle window', () => {
    // now = 4100, sessionEnd = 3500, settle = 1000. Turn 0 ends 2000 (settled),
    // turn 1 ends 3000 (settled), last turn ends 3500 → 4100-3500=600 < 1000 → NOT settled.
    expect(settledTurnIndices(starts, 3500, 4100, 1000)).toEqual([0, 1]);
  });
});

describe('selectNewDivergences', () => {
  it('returns only divergences not already seen and grows the seen-set', () => {
    const seen = new Set([divergenceKey(located('s', 1000, 'wf'))]);
    const current = [
      located('s', 1000, 'wf'), // already seen
      located('s', 2000, 'wf'), // new
    ];
    const { toNotify, nextSeen } = selectNewDivergences(current, seen);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0].turnStartMs).toBe(2000);
    expect(nextSeen.size).toBe(2);
  });

  it('distinguishes divergences by type within the same turn', () => {
    const current = [
      located('s', 1000, 'wf', DeviationType.MissingSteps),
      located('s', 1000, 'wf', DeviationType.SequenceDeviation),
    ];
    const { toNotify } = selectNewDivergences(current, new Set());
    expect(toNotify).toHaveLength(2);
  });

  it('is idempotent — a second pass with the updated seen-set notifies nothing', () => {
    const current = [located('s', 1000, 'wf')];
    const first = selectNewDivergences(current, new Set());
    const second = selectNewDivergences(current, first.nextSeen);
    expect(first.toNotify).toHaveLength(1);
    expect(second.toNotify).toHaveLength(0);
  });

  it('treats the same session+turn+workflow in DIFFERENT sources as distinct', () => {
    // A Claude sessionId and a Copilot sessionKey can be the same string; the
    // source id must keep them from colliding in the seen-set.
    const current = [
      located('shared-id', 1000, 'wf', DeviationType.MissingSteps, 'copilot'),
      located('shared-id', 1000, 'wf', DeviationType.MissingSteps, 'claude'),
    ];
    const { toNotify } = selectNewDivergences(current, new Set());
    expect(toNotify).toHaveLength(2);
  });
});

describe('divergenceKey', () => {
  it('namespaces by source so an identical location in another source does not collide', () => {
    const copilot = located('shared-id', 1000, 'wf');
    const claude = located('shared-id', 1000, 'wf', DeviationType.MissingSteps, 'claude');
    expect(divergenceKey(copilot)).not.toBe(divergenceKey(claude));
  });
});
