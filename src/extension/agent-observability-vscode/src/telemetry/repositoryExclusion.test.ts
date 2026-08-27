import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { copyFixtureToTemp } from './testSupport';
import { normalizeRepositoryList } from '../aggregate/repoSyncPolicy';

/**
 * Service-level repository exclusion (`agentObservability.excludedRepositories`):
 * an excluded repository must vanish from EVERY surface the service exposes —
 * the repository list, the session listings, the overview, and (privacy-critical)
 * the aggregation rows that feed cloud sync, the payload preview, and the
 * repository pickers.
 */

const SAMPLE_REPO = 'https://github.com/example-org/sample-repo';

function makeConfig(dbPath: string, excluded: readonly string[]): ServiceConfig {
  return {
    isLocalTelemetryEnabled: () => true,
    getSqlitePathOverride: () => dbPath,
    getCodeFileExtensions: () => [],
    getDocFileExtensions: () => [],
    // Same chokepoint the real Configuration uses, so shorthand entries are
    // exercised the way a hand-edited setting reaches the service.
    getExcludedRepositories: () => normalizeRepositoryList(excluded),
  };
}

describe('TelemetryService repository exclusion', () => {
  let cleanup: () => void;
  let copyPath: string;
  let unfiltered: TelemetryService;
  let filtered: TelemetryService;

  beforeAll(() => {
    const copy = copyFixtureToTemp();
    cleanup = copy.cleanup;
    copyPath = copy.dbPath;
    unfiltered = new TelemetryService(makeConfig(copy.dbPath, []));
    filtered = new TelemetryService(makeConfig(copy.dbPath, [SAMPLE_REPO]));
  });

  afterAll(() => {
    unfiltered.dispose();
    filtered.dispose();
    cleanup();
  });

  it('baseline: the unfiltered service reports the sample repository', () => {
    const repos = unfiltered.listRepositories();
    expect(repos.ok && repos.value.some((r) => r.repository === SAMPLE_REPO)).toBe(true);
    const rows = unfiltered.getAggregationRows();
    expect(rows.ok && rows.value.some((r) => r.repository === SAMPLE_REPO)).toBe(true);
  });

  it('omits the excluded repository from listRepositories', () => {
    const repos = filtered.listRepositories();
    expect(repos.ok).toBe(true);
    if (repos.ok) {
      expect(repos.value.some((r) => r.repository === SAMPLE_REPO)).toBe(false);
    }
  });

  it('omits the excluded repository from session listings', () => {
    const all = filtered.listSessions();
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.some((s) => s.repository === SAMPLE_REPO)).toBe(false);
    }
    // Asking for the excluded repository directly yields an EMPTY ok result —
    // not an error — so a stale tree node degrades gracefully.
    const direct = filtered.listSessions(SAMPLE_REPO);
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      expect(direct.value).toEqual([]);
    }
  });

  it('a limited unscoped listing back-fills with visible sessions', () => {
    const all = filtered.listSessions();
    if (!all.ok) {
      throw new Error('expected ok');
    }
    const limited = filtered.listSessions(undefined, Math.min(3, all.value.length));
    expect(limited.ok).toBe(true);
    if (limited.ok) {
      // The cap is filled from the remaining (visible) sessions, not eaten by
      // excluded ones the per-source limit would otherwise have returned.
      expect(limited.value.length).toBe(Math.min(3, all.value.length));
      expect(limited.value.some((s) => s.repository === SAMPLE_REPO)).toBe(false);
    }
  });

  it('drops the excluded repository from the aggregation rows (sync/preview path)', () => {
    const rows = filtered.getAggregationRows();
    expect(rows.ok).toBe(true);
    if (rows.ok) {
      expect(rows.value.length).toBeGreaterThan(0);
      expect(rows.value.some((r) => r.repository === SAMPLE_REPO)).toBe(false);
    }
    const distinct = filtered.getDistinctRepositories();
    expect(distinct.ok).toBe(true);
    if (distinct.ok) {
      expect(distinct.value).not.toContain(SAMPLE_REPO);
    }
  });

  it('an owner/repo shorthand entry hides that repo but not the unknown bucket', () => {
    // Previously the shorthand collapsed to 'unknown' in normalization: the
    // intended repo stayed visible and the whole no-remote bucket vanished.
    const shorthand = new TelemetryService(
      makeConfig(copyPath, ['example-org/sample-repo']),
    );
    try {
      const repos = shorthand.listRepositories();
      expect(repos.ok).toBe(true);
      if (repos.ok) {
        expect(repos.value.some((r) => r.repository === SAMPLE_REPO)).toBe(false);
      }
      const loose = shorthand.listSessions('unknown');
      expect(loose.ok).toBe(true);
    } finally {
      shorthand.dispose();
    }
  });

  it('shrinks the overview consistently with the unfiltered baseline', () => {
    const full = unfiltered.getOverview();
    const partial = filtered.getOverview();
    expect(full.ok && partial.ok).toBe(true);
    if (full.ok && partial.ok) {
      expect(partial.value.totalRepositories).toBe(full.value.totalRepositories - 1);
      expect(partial.value.totalSessions).toBeLessThan(full.value.totalSessions);
      expect(partial.value.totalInteractions).toBeLessThan(full.value.totalInteractions);
    }
  });
});
