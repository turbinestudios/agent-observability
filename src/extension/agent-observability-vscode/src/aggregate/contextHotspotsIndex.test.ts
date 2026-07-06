import { describe, it, expect } from 'vitest';
import { buildContextHotspots, hasMultipleRepositories } from './contextHotspotsIndex';
import type { ContextFileObservation } from './contextInsightsExtractor';

const REPO = 'https://github.com/acme/widgets';

/** Build a ContextFileObservation with sensible defaults for terse test data. */
function obs(partial: Partial<ContextFileObservation> & Pick<ContextFileObservation, 'sessionKey' | 'contextFile'>): ContextFileObservation {
  return {
    startTimeMs: 1_000,
    repository: REPO,
    category: 'instruction',
    applied: true,
    estTokens: 100,
    hadError: false,
    hadDeviation: false,
    ...partial,
  };
}

describe('buildContextHotspots', () => {
  it('groups observations by file and counts distinct contributing sessions', () => {
    const hotspots = buildContextHotspots([
      obs({ sessionKey: 's1', contextFile: '.github/copilot-instructions.md', startTimeMs: 2_000 }),
      obs({ sessionKey: 's2', contextFile: '.github/copilot-instructions.md', startTimeMs: 1_000 }),
      obs({ sessionKey: 's1', contextFile: '.github/skills/a/SKILL.md', category: 'skill' }),
    ]);

    expect(hotspots).toHaveLength(2);
    // Busiest file first (2 sessions vs 1); its sessions are newest-first.
    expect(hotspots[0].contextFile).toBe('.github/copilot-instructions.md');
    expect(hotspots[0].sessions.map((s) => s.sessionKey)).toEqual(['s1', 's2']);
    expect(hotspots[1].contextFile).toBe('.github/skills/a/SKILL.md');
    expect(hotspots[1].category).toBe('skill');
  });

  it('folds a repeated (session, file) into one session, keeping applied and max weight', () => {
    const [hotspot] = buildContextHotspots([
      obs({ sessionKey: 's1', contextFile: 'a.md', applied: false, estTokens: 50, startTimeMs: 2_000 }),
      obs({ sessionKey: 's1', contextFile: 'a.md', applied: true, estTokens: 120, startTimeMs: 1_000 }),
    ]);

    expect(hotspot.sessions).toHaveLength(1);
    const [session] = hotspot.sessions;
    expect(session.applied).toBe(true); // OR of both
    expect(session.estTokens).toBe(120); // max of both
    expect(session.startTimeMs).toBe(1_000); // earliest
    expect(hotspot.appliedCount).toBe(1);
    expect(hotspot.estTokensMax).toBe(120);
  });

  it('sorts contributing sessions newest-first', () => {
    const [hotspot] = buildContextHotspots([
      obs({ sessionKey: 'old', contextFile: 'a.md', startTimeMs: 1_000 }),
      obs({ sessionKey: 'new', contextFile: 'a.md', startTimeMs: 5_000 }),
      obs({ sessionKey: 'mid', contextFile: 'a.md', startTimeMs: 3_000 }),
    ]);

    expect(hotspot.sessions.map((s) => s.sessionKey)).toEqual(['new', 'mid', 'old']);
  });

  it('computes appliedCount from only the sessions where the file was applied', () => {
    const [hotspot] = buildContextHotspots([
      obs({ sessionKey: 's1', contextFile: 'a.md', applied: true }),
      obs({ sessionKey: 's2', contextFile: 'a.md', applied: false }),
      obs({ sessionKey: 's3', contextFile: 'a.md', applied: true }),
    ]);

    expect(hotspot.sessions).toHaveLength(3);
    expect(hotspot.appliedCount).toBe(2);
  });

  it('breaks equal-session-count ties by estTokensMax desc, then path', () => {
    const hotspots = buildContextHotspots([
      obs({ sessionKey: 's1', contextFile: 'light.md', estTokens: 10 }),
      obs({ sessionKey: 's1', contextFile: 'heavy.md', estTokens: 900 }),
      obs({ sessionKey: 's1', contextFile: 'also-light.md', estTokens: 10 }),
    ]);

    // All have 1 session → heaviest first, then alphabetical among equal weights.
    expect(hotspots.map((h) => h.contextFile)).toEqual(['heavy.md', 'also-light.md', 'light.md']);
  });

  it('returns an empty index for no observations', () => {
    expect(buildContextHotspots([])).toEqual([]);
  });
});

describe('hasMultipleRepositories', () => {
  it('is false for a single repository', () => {
    const hotspots = buildContextHotspots([
      obs({ sessionKey: 's1', contextFile: 'a.md' }),
      obs({ sessionKey: 's2', contextFile: 'b.md' }),
    ]);
    expect(hasMultipleRepositories(hotspots)).toBe(false);
  });

  it('is true when hotspots span more than one repository', () => {
    const hotspots = buildContextHotspots([
      obs({ sessionKey: 's1', contextFile: 'a.md', repository: 'https://github.com/acme/one' }),
      obs({ sessionKey: 's2', contextFile: 'b.md', repository: 'https://github.com/acme/two' }),
    ]);
    expect(hasMultipleRepositories(hotspots)).toBe(true);
  });

  it('is false for an empty index', () => {
    expect(hasMultipleRepositories([])).toBe(false);
  });
});
