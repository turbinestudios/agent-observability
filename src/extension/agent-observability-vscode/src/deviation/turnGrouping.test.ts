import { describe, it, expect } from 'vitest';
import { groupInteractionsByTurn } from './turnGrouping';
import { Interaction } from '../telemetry/models';

function at(timestampMs: number, agentName = 'copilot'): Interaction {
  return {
    timestampMs,
    sessionId: 's',
    traceId: 't',
    operation: 'chat',
    agentName,
    agentMode: 'agent',
    model: 'm',
    durationMs: 1,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: 'https://github.com/org/repo',
  };
}

describe('groupInteractionsByTurn', () => {
  it('buckets each interaction into the last turn whose start <= its timestamp', () => {
    const starts = [1000, 2000, 3000];
    const interactions = [
      at(1000, 'anchor1'),
      at(1500, 'tool'),
      at(2000, 'anchor2'),
      at(2500, 'tool'),
      at(3000, 'anchor3'),
      at(3200, 'tool'),
    ];
    const buckets = groupInteractionsByTurn(interactions, starts);
    expect(buckets.map((b) => b.length)).toEqual([2, 2, 2]);
    expect(buckets[0].map((i) => i.agentName)).toEqual(['anchor1', 'tool']);
    expect(buckets[2].map((i) => i.agentName)).toEqual(['anchor3', 'tool']);
  });

  it('assigns interactions earlier than the first turn to turn 0', () => {
    const buckets = groupInteractionsByTurn([at(500), at(1200)], [1000, 2000]);
    expect(buckets[0].map((i) => i.timestampMs)).toEqual([500, 1200]);
    expect(buckets[1]).toEqual([]);
  });

  it('returns one (possibly empty) bucket per turn, preserving alignment', () => {
    const buckets = groupInteractionsByTurn([at(5000)], [1000, 2000, 3000]);
    expect(buckets).toHaveLength(3);
    expect(buckets[2]).toHaveLength(1); // 5000 >= 3000 → last turn
    expect(buckets[0]).toEqual([]);
    expect(buckets[1]).toEqual([]);
  });

  it('returns [] when there are no turns', () => {
    expect(groupInteractionsByTurn([at(1)], [])).toEqual([]);
  });

  it('does not require the interactions to be pre-sorted', () => {
    const buckets = groupInteractionsByTurn([at(3200), at(1000), at(2500)], [1000, 2000, 3000]);
    expect(buckets.map((b) => b.length)).toEqual([1, 1, 1]);
  });
});
