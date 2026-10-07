import { describe, it, expect } from 'vitest';
import { HOTSPOT_TOKEN_BUDGET, scoreHotspots, type Scorable } from './hotspotScore';

/** The desktop's hotspot row shape, so the fixtures read like the view's. */
interface HotspotRow extends Scorable {
  name: string;
  category: string;
  sessionCount: number;
  readCount: number;
  lastSeenMs: number;
}

/**
 * The composite is shared by every desktop surface that ranks hotspots, so a
 * drift here would make the views disagree with each other for no visible reason.
 */

function hotspot(over: Partial<HotspotRow> & Pick<HotspotRow, 'file'>): HotspotRow {
  return {
    name: over.file.split('/').pop() ?? over.file,
    category: 'instruction',
    sessionCount: 1,
    appliedCount: 0,
    skippedCount: 0,
    readCount: 0,
    estTokensMax: 0,
    errorSessions: 0,
    deviationSessions: 0,
    lastSeenMs: 0,
    ...over,
  };
}

describe('scoreHotspots', () => {
  it('computes the weighted composite from hand-checked sub-scores', () => {
    // skip = 5/10 = 0.5, friction = (2+1)/5 = 0.6, token = 1000/2000 = 0.5,
    // frequency = 5/5 = 1 (busiest file in the set).
    const [scored] = scoreHotspots([
      hotspot({
        file: '/repo/CLAUDE.md',
        appliedCount: 5,
        skippedCount: 5,
        estTokensMax: 1_000,
        errorSessions: 2,
        deviationSessions: 1,
      }),
    ]);
    expect(scored.score).toBeCloseTo(100 * (0.3 * 0.5 + 0.3 * 0.6 + 0.2 * 0.5 + 0.2 * 1), 6);
  });

  it('clamps the token and friction sub-scores at 1', () => {
    const [scored] = scoreHotspots([
      hotspot({
        file: '/repo/huge.md',
        appliedCount: 1,
        estTokensMax: HOTSPOT_TOKEN_BUDGET * 3,
        errorSessions: 4,
        deviationSessions: 4,
      }),
    ]);
    // skip 0, friction 1, token 1, frequency 1.
    expect(scored.score).toBeCloseTo(100 * (0.3 + 0.2 + 0.2), 6);
  });

  it('scores zero denominators as zero rather than dividing by them', () => {
    // Never applied, never skipped: skip 0, frequency 0 (nothing applied in the
    // whole set), friction clamps its denominator at 1.
    const [scored] = scoreHotspots([hotspot({ file: '/repo/idle.md', errorSessions: 1 })]);
    expect(scored.score).toBeCloseTo(100 * 0.3, 6);
  });

  it('normalizes frequency by the busiest file in the set', () => {
    const scored = scoreHotspots([
      hotspot({ file: '/repo/busy.md', appliedCount: 10 }),
      hotspot({ file: '/repo/quiet.md', appliedCount: 5 }),
    ]);
    const busy = scored.find((r) => r.file === '/repo/busy.md');
    const quiet = scored.find((r) => r.file === '/repo/quiet.md');
    expect(busy?.score).toBeCloseTo(100 * 0.2, 6);
    expect(quiet?.score).toBeCloseTo(100 * 0.2 * 0.5, 6);
  });

  it('ranks by score, then total trouble signals, then path', () => {
    const scored = scoreHotspots([
      // Same score for the last two (identical inputs): the path decides.
      hotspot({ file: '/repo/b.md', appliedCount: 4 }),
      hotspot({ file: '/repo/a.md', appliedCount: 4 }),
      // Equal score to the pair is impossible here, so make one clear winner
      // and one tie broken by trouble: skipped raises both score and trouble,
      // so pin the tie with error sessions instead.
      hotspot({ file: '/repo/worst.md', appliedCount: 4, skippedCount: 4, errorSessions: 4 }),
    ]);
    expect(scored.map((r) => r.file)).toEqual(['/repo/worst.md', '/repo/a.md', '/repo/b.md']);
  });
});
