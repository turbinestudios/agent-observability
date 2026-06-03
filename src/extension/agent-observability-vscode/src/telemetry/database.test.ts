import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryDatabase } from './database';
import { statusToSuccess } from './models';
import { copyFixtureToTemp } from './testSupport';

/**
 * Exercises the read-only adapter against the real sanitized fixture, opened
 * from a temp COPY (so the snapshot/open path is what runs).
 *
 * Fixture facts: 429 spans, repo 'https://github.com/example-org/sample-repo'.
 */

const KNOWN_SESSION = '97fb6af7-7d93-45fe-a00b-289fa761bf66';
const SAMPLE_REPO = 'https://github.com/example-org/sample-repo';

describe('TelemetryDatabase against the fixture', () => {
  let db: TelemetryDatabase;
  let cleanup: () => void;

  beforeAll(() => {
    const copy = copyFixtureToTemp();
    cleanup = copy.cleanup;
    db = TelemetryDatabase.open(copy.dbPath);
  });

  afterAll(() => {
    db.close();
    cleanup();
  });

  it('validates the schema without throwing', () => {
    expect(() => db.validateSchema()).not.toThrow();
  });

  it('reports 429 total interactions in the overview', () => {
    const m = db.getOverviewMetrics();
    expect(m.totalInteractions).toBe(429);
    expect(m.totalSessions).toBeGreaterThan(0);
    expect(m.totalModels).toBeGreaterThan(0);
    expect(m.avgDurationMs).toBeGreaterThan(0);
    // Error count uses status_code = 2 (134 in the fixture).
    expect(m.errorCount).toBe(134);
    // Token sums (chat spans only) are positive.
    expect(m.inputTokens).toBeGreaterThan(0);
    expect(m.outputTokens).toBeGreaterThan(0);
  });

  it('lists the sanitized sample repository (no .git)', () => {
    const repos = db.listRepositories();
    const ids = repos.map((r) => r.repository);
    expect(ids).toContain(SAMPLE_REPO);
    // No raw, credential-bearing or .git-suffixed URL leaks through.
    for (const id of ids) {
      expect(id).not.toMatch(/\.git$/);
      expect(id).not.toMatch(/[@?#\s]/);
    }
    const sample = repos.find((r) => r.repository === SAMPLE_REPO);
    expect(sample).toBeDefined();
    expect(sample?.sessionCount).toBeGreaterThan(0);
    expect(sample?.interactionCount).toBeGreaterThan(0);
  });

  it('lists non-empty sessions, each carrying a sanitized repository', () => {
    const sessions = db.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) {
      // Sanitized: either the canonical https form or the literal 'unknown'.
      expect(s.repository === 'unknown' || /^https?:\/\//.test(s.repository)).toBe(true);
      expect(s.repository).not.toMatch(/[@?#\s]/);
    }
    // At least one session resolves to the sample repo.
    expect(sessions.some((s) => s.repository === SAMPLE_REPO)).toBe(true);
  });

  it('filters sessions by repository', () => {
    const all = db.listSessions();
    const filtered = db.listSessions(SAMPLE_REPO);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(all.length);
    expect(filtered.every((s) => s.repository === SAMPLE_REPO)).toBe(true);
  });

  it('returns ordered interactions for a known session', () => {
    const interactions = db.getSessionInteractions(KNOWN_SESSION);
    expect(interactions.length).toBeGreaterThan(1);
    // Strictly non-decreasing by timestamp.
    for (let i = 1; i < interactions.length; i++) {
      expect(interactions[i].timestampMs).toBeGreaterThanOrEqual(interactions[i - 1].timestampMs);
    }
    // Every interaction is tagged with the session and the sample repo.
    for (const it of interactions) {
      expect(it.sessionId).toBe(KNOWN_SESSION);
      expect(it.repository).toBe(SAMPLE_REPO);
    }
  });

  it('derives success/error strictly from status_code (0,1 ok; 2 error)', () => {
    const interactions = db.getSessionInteractions(KNOWN_SESSION);
    const errors = interactions.filter((i) => !i.success).length;
    const successes = interactions.filter((i) => i.success).length;
    expect(errors + successes).toBe(interactions.length);
    // Cross-check the helper definition directly.
    expect(statusToSuccess(0)).toBe(true);
    expect(statusToSuccess(1)).toBe(true);
    expect(statusToSuccess(2)).toBe(false);
  });

  it('honors a since filter in the overview', () => {
    const full = db.getOverviewMetrics();
    const future = db.getOverviewMetrics(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    expect(future.totalInteractions).toBe(0);
    expect(future.totalInteractions).toBeLessThan(full.totalInteractions);
  });
});
