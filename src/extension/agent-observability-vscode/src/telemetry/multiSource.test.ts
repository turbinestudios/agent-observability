import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { PathEnvironment } from './paths';
import { createReadonlySnapshot, ReadonlySnapshot } from './snapshot';
import { copyFixtureToTemp } from './testSupport';

/**
 * Cross-environment merging: a service resolving TWO source databases (as when
 * a Windows window also sees a WSL distro's database, or vice versa) must show
 * the union of both environments' sessions in every query.
 *
 * Source A is the fixture as-is. Source B is a second copy whose session ids
 * are rewritten disjoint, since real environments never share a session. The
 * rewrite is UPPER() — a bijection on hex ids that keeps them UUID-shaped, so
 * B's sessions still pass the human-initiated (UUID) filter while comparing
 * unequal to A's lowercase ids. The service is pointed at both via a fake
 * PathEnvironment whose WSL discovery reports them (the merge logic is
 * identical for the windowsHost direction).
 */

function makeConfig(override?: string): ServiceConfig {
  return {
    isLocalTelemetryEnabled: () => true,
    getSqlitePathOverride: () => override,
    getCodeFileExtensions: () => [],
    getDocFileExtensions: () => [],
  };
}

/** Env that reports the given paths as WSL discoveries (no local candidates). */
function makeEnv(paths: string[]): PathEnvironment {
  return {
    platform: 'win32',
    env: {},
    homedir: () => '',
    statKind: () => 'absent',
    findWslDatabases: () => paths.map((p, i) => ({ path: p, mtimeMs: 1000 - i, distro: 'Ubuntu' })),
    findWindowsHostDatabases: () => [],
  };
}

describe('TelemetryService over multiple source databases', () => {
  let copyA: { dbPath: string; cleanup: () => void };
  let copyB: { dbPath: string; cleanup: () => void };
  /** Normalized (rollback-journal) rewrite of copy B with disjoint session ids. */
  let sourceB: ReadonlySnapshot;

  beforeAll(() => {
    copyA = copyFixtureToTemp();
    copyB = copyFixtureToTemp();
    // The fixture may be WAL-flagged (unopenable read-write by the bundled
    // driver), so normalize via the snapshot machinery, then rewrite the
    // session-key columns so B's sessions are disjoint from A's.
    sourceB = createReadonlySnapshot(copyB.dbPath);
    const db = new Database(sourceB.dbPath);
    db.exec(
      'UPDATE spans SET conversation_id = UPPER(conversation_id) WHERE conversation_id IS NOT NULL',
    );
    db.exec(
      'UPDATE spans SET chat_session_id = UPPER(chat_session_id) WHERE chat_session_id IS NOT NULL',
    );
    db.close();
  });

  afterAll(() => {
    sourceB.dispose();
    copyB.cleanup();
    copyA.cleanup();
  });

  function baseline(): TelemetryService {
    return new TelemetryService(makeConfig(copyA.dbPath));
  }

  function merged(): TelemetryService {
    return new TelemetryService(makeConfig(), makeEnv([copyA.dbPath, sourceB.dbPath]));
  }

  it('merges the overview: additive counters double, distinct dimensions do not', () => {
    const single = baseline();
    const multi = merged();
    try {
      const a = single.getOverview();
      const m = multi.getOverview();
      expect(a.ok).toBe(true);
      expect(m.ok).toBe(true);
      if (!a.ok || !m.ok) {
        return;
      }
      expect(m.value.totalInteractions).toBe(2 * a.value.totalInteractions);
      expect(m.value.totalSessions).toBe(2 * a.value.totalSessions);
      expect(m.value.inputTokens).toBe(2 * a.value.inputTokens);
      expect(m.value.outputTokens).toBe(2 * a.value.outputTokens);
      expect(m.value.cachedTokens).toBe(2 * a.value.cachedTokens);
      expect(m.value.errorCount).toBe(2 * a.value.errorCount);
      // Same repositories and models exist in both copies → unions, not sums.
      expect(m.value.totalRepositories).toBe(a.value.totalRepositories);
      expect(m.value.totalModels).toBe(a.value.totalModels);
      // Identical spans in both → identical average (rounding-stable).
      expect(m.value.avgDurationMs).toBe(a.value.avgDurationMs);
    } finally {
      single.dispose();
      multi.dispose();
    }
  });

  it('merges session lists: union of both environments, newest first', () => {
    const single = baseline();
    const multi = merged();
    try {
      const a = single.listSessions();
      const m = multi.listSessions();
      expect(a.ok).toBe(true);
      expect(m.ok).toBe(true);
      if (!a.ok || !m.ok) {
        return;
      }
      expect(m.value.length).toBe(2 * a.value.length);
      const ids = new Set(m.value.map((s) => s.sessionId));
      expect(ids.size).toBe(m.value.length);
      for (const session of a.value) {
        expect(ids.has(session.sessionId)).toBe(true);
        expect(ids.has(session.sessionId.toUpperCase())).toBe(true);
      }
      // Newest-first ordering holds across the merged list.
      for (let i = 1; i < m.value.length; i++) {
        expect(m.value[i - 1].startedAtMs).toBeGreaterThanOrEqual(m.value[i].startedAtMs);
      }
    } finally {
      single.dispose();
      multi.dispose();
    }
  });

  it('applies a limit AFTER merging across sources', () => {
    const multi = merged();
    try {
      const m = multi.listSessions(undefined, 3);
      expect(m.ok).toBe(true);
      if (m.ok) {
        expect(m.value.length).toBe(3);
      }
    } finally {
      multi.dispose();
    }
  });

  it('merges repository rollups by name with summed counts', () => {
    const single = baseline();
    const multi = merged();
    try {
      const a = single.listRepositories();
      const m = multi.listRepositories();
      expect(a.ok).toBe(true);
      expect(m.ok).toBe(true);
      if (!a.ok || !m.ok) {
        return;
      }
      expect(m.value.map((r) => r.repository).sort()).toEqual(
        a.value.map((r) => r.repository).sort(),
      );
      for (const repo of m.value) {
        const base = a.value.find((r) => r.repository === repo.repository)!;
        expect(repo.sessionCount).toBe(2 * base.sessionCount);
        expect(repo.interactionCount).toBe(2 * base.interactionCount);
        expect(repo.models).toEqual(base.models);
        expect(repo.lastActivityMs).toBe(base.lastActivityMs);
      }
    } finally {
      single.dispose();
      multi.dispose();
    }
  });

  it('routes a session detail lookup to whichever source knows the session', () => {
    const single = baseline();
    const multi = merged();
    try {
      const a = single.listSessions(undefined, 1);
      expect(a.ok).toBe(true);
      if (!a.ok) {
        return;
      }
      const fromA = a.value[0].sessionId;
      const fromB = fromA.toUpperCase();

      const detailA = multi.getSessionDetail(fromA);
      expect(detailA.ok).toBe(true);
      if (detailA.ok) {
        expect(detailA.value.summary.sessionId).toBe(fromA);
      }
      const detailB = multi.getSessionDetail(fromB);
      expect(detailB.ok).toBe(true);
      if (detailB.ok) {
        expect(detailB.value.summary.sessionId).toBe(fromB);
      }

      const missing = multi.getSessionDetail('no-such-session');
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.reason).toBe('missingDb');
      }
    } finally {
      single.dispose();
      multi.dispose();
    }
  });

  it('concatenates aggregation rows across sources', () => {
    const single = baseline();
    const multi = merged();
    try {
      const a = single.getAggregationRows();
      const m = multi.getAggregationRows();
      expect(a.ok).toBe(true);
      expect(m.ok).toBe(true);
      if (a.ok && m.ok) {
        expect(m.value.length).toBe(2 * a.value.length);
      }
    } finally {
      single.dispose();
      multi.dispose();
    }
  });

  it('keeps working when one source fails to open', () => {
    const multi = new TelemetryService(
      makeConfig(),
      makeEnv([copyA.dbPath, 'Z:\\definitely\\missing\\agent-traces.db']),
    );
    try {
      const m = multi.listSessions();
      expect(m.ok).toBe(true);
    } finally {
      multi.dispose();
    }
  });
});
