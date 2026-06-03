import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { copyFixtureToTemp } from './testSupport';

/**
 * Service-level error classification: failures become typed Results, never
 * crashes.
 */

/** Minimal in-memory config stub. */
function makeConfig(opts: { enabled?: boolean; override?: string }): ServiceConfig {
  return {
    isLocalTelemetryEnabled: () => opts.enabled ?? true,
    getSqlitePathOverride: () => opts.override,
  };
}

describe('TelemetryService error handling', () => {
  it('returns reason "disabled" when the feature flag is off', () => {
    const svc = new TelemetryService(makeConfig({ enabled: false, override: 'whatever' }));
    const r = svc.getOverview();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('disabled');
    }
    svc.dispose();
  });

  it('returns reason "missingDb" for a non-existent override path', () => {
    const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.db`);
    const svc = new TelemetryService(makeConfig({ enabled: true, override: missing }));
    const r = svc.getOverview();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missingDb');
    }
    svc.dispose();
  });

  it('returns reason "schemaMismatch" for an empty/corrupt db file (no crash)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-bad-'));
    const bad = path.join(dir, 'agent-traces.db');
    // A present-but-not-a-database file.
    fs.writeFileSync(bad, 'this is not a sqlite database');
    const svc = new TelemetryService(makeConfig({ enabled: true, override: bad }));
    try {
      const r = svc.getOverview();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('schemaMismatch');
      }
    } finally {
      svc.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns reason "schemaMismatch" for a valid sqlite db with the wrong schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-wrong-'));
    const wrong = path.join(dir, 'agent-traces.db');
    // Build a real but empty sqlite db (no spans/sessions/schema_version).
    const seed = new Database(wrong);
    seed.exec('CREATE TABLE unrelated (id INTEGER)');
    seed.close();

    const svc = new TelemetryService(makeConfig({ enabled: true, override: wrong }));
    try {
      const r = svc.getOverview();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('schemaMismatch');
      }
    } finally {
      svc.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns reason "schemaMismatch" for a supported-shape db with an unsupported schema_version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-ver-'));
    const wrong = path.join(dir, 'agent-traces.db');
    // schema_version is checked first, so a future/unsupported version (2) is
    // rejected before table/column checks even matter.
    const seed = new Database(wrong);
    seed.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    seed.exec('INSERT INTO schema_version (version) VALUES (2)');
    seed.close();

    const svc = new TelemetryService(makeConfig({ enabled: true, override: wrong }));
    try {
      const r = svc.getOverview();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('schemaMismatch');
      }
    } finally {
      svc.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Permission denial is reproducible on POSIX via chmod; skipped on Windows
  // (where chmod 000 does not deny reads) and when running as root.
  const canTestPermission =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  (canTestPermission ? it : it.skip)(
    'returns reason "permission" for an unreadable override db',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-perm-'));
      const denied = path.join(dir, 'agent-traces.db');
      const seed = new Database(denied);
      seed.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
      seed.close();
      fs.chmodSync(denied, 0o000);

      const svc = new TelemetryService(makeConfig({ enabled: true, override: denied }));
      try {
        const r = svc.getOverview();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe('permission');
        }
      } finally {
        svc.dispose();
        fs.chmodSync(denied, 0o600);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('returns ok for a valid fixture via the service facade', () => {
    const copy = copyFixtureToTemp();
    const svc = new TelemetryService(makeConfig({ enabled: true, override: copy.dbPath }));
    try {
      const r = svc.getOverview();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.totalInteractions).toBe(429);
      }
      // Repositories + sessions also resolve via the facade.
      const repos = svc.listRepositories();
      expect(repos.ok).toBe(true);
      const sessions = svc.listSessions();
      expect(sessions.ok).toBe(true);
    } finally {
      svc.dispose();
      copy.cleanup();
    }
  });
});
