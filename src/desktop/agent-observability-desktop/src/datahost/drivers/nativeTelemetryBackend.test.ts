import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import type { Result } from '@agent-observability/core/src/telemetry/telemetryService';
import { TelemetryDatabase } from '@agent-observability/core/src/telemetry/database';
import type { PathEnvironment } from '@agent-observability/core/src/telemetry/paths';
import type { SessionTitleInfo } from '@agent-observability/core/src/telemetry/sessionTitles';
import { FIXTURE_DB } from '@agent-observability/core/src/telemetry/testSupport';
import * as snapshots from '@agent-observability/core/src/telemetry/snapshot';
import * as titleStore from '@agent-observability/core/src/telemetry/titleStore';
import { CopilotSource } from '@agent-observability/core/src/sources/sessionSource';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { NativeTelemetryBackend } from './nativeTelemetryBackend';
import { analyzeSession } from '../analysis/sessionAnalyzer';
import { DetailRenderer } from '../detail/detailRenderer';

// Sanitized fixture only; every database opened here is a disposable copy.
const SESSION = '97fb6af7-7d93-45fe-a00b-289fa761bf66';
const ACCEPTED = { files: [], sources: [] };
let root: string;
let dbPath: string;
let config: Configuration;
let environment: PathEnvironment;
let titles: Map<string, SessionTitleInfo>;
let backend: NativeTelemetryBackend;
let service: TelemetryService;

function value<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-native-reader-'));
  dbPath = path.join(root, 'source.db');
  fs.copyFileSync(FIXTURE_DB, dbPath);
  config = new Configuration({
    get: <T>(key: string, fallback: T): T =>
      (key === 'sqlitePath' ? dbPath : fallback) as T,
    onDidChange: () => ({ dispose: () => undefined }),
  });
  environment = {
    platform: 'linux', env: {}, homedir: () => root,
    statKind: (file) => {
      try { return fs.statSync(file).isFile() ? 'file' : 'absent'; } catch { return 'absent'; }
    },
  };
  titles = new Map();
  backend = new NativeTelemetryBackend({ allTitles: () => titles });
  service = new TelemetryService(config, environment, backend);
});

afterEach(() => {
  service.dispose();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function writer(): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  return db;
}

function setModel(db: Database.Database, model: string): void {
  db.prepare('UPDATE spans SET response_model = ? WHERE COALESCE(conversation_id, chat_session_id) = ?')
    .run(model, SESSION);
}

function detector(): LocalDeviationDetector {
  return new LocalDeviationDetector({ getWorkflowConfigs: () => [], getMaxSessionMinutes: () => 60 });
}

describe('native telemetry parity', () => {
  it('matches snapshot detail, interactions, context and bounded safe aggregation', () => {
    const snapshot = new TelemetryService(config, environment);
    snapshot.setSnapshotRoot(path.join(root, 'snapshots'));
    try {
      expect(service.getSessionDetail(SESSION)).toEqual(snapshot.getSessionDetail(SESSION));
      expect(service.getSessionInteractions(SESSION)).toEqual(snapshot.getSessionInteractions(SESSION));
      expect(service.getContextDiscoveryEvents(SESSION)).toEqual(snapshot.getContextDiscoveryEvents(SESSION));
      expect(service.getContextToolReads(SESSION)).toEqual(snapshot.getContextToolReads(SESSION));
      expect(service.getSystemInstructionsBySpan(SESSION)).toEqual(snapshot.getSystemInstructionsBySpan(SESSION));
      expect(service.getSubagentNames(SESSION)).toEqual(snapshot.getSubagentNames(SESSION));
      expect(service.getSpanAttributes(SESSION, 'copilot_chat.user_request'))
        .toEqual(snapshot.getSpanAttributes(SESSION, 'copilot_chat.user_request'));
      expect(service.listSessions()).toEqual(snapshot.listSessions());
      expect(service.listRepositories()).toEqual(snapshot.listRepositories());
      expect(service.getOverview()).toEqual(snapshot.getOverview());
      expect(service.getAggregationRows(0, 9_000_000_000_000))
        .toEqual(snapshot.getAggregationRows(0, 9_000_000_000_000));
      expect(service.getAggregationRows(0, 1)).toEqual({ ok: true, value: [] });
      const nativeSource = new CopilotSource(service, config);
      const snapshotSource = new CopilotSource(snapshot, config);
      expect(nativeSource.getContextAnalysis(SESSION, ACCEPTED))
        .toEqual(snapshotSource.getContextAnalysis(SESSION, ACCEPTED));
      expect(analyzeSession(nativeSource, SESSION, { detector: detector(), acceptedMissing: ACCEPTED }))
        .toEqual(analyzeSession(snapshotSource, SESSION, { detector: detector(), acceptedMissing: ACCEPTED }));
    } finally {
      snapshot.dispose();
    }
  }, 30_000);

  it('serves detail and background analysis without snapshots or workspace title scans', () => {
    const copy = vi.spyOn(snapshots, 'createReadonlySnapshot').mockImplementation(() => {
      throw new Error('Native reads must never copy a database');
    });
    const scan = vi.spyOn(titleStore, 'readMergedSessionTitles').mockImplementation(() => {
      throw new Error('Native reads must never scan workspace titles');
    });
    const source = new CopilotSource(service, config);
    const renderer = new DetailRenderer({ get: () => source }, detector());
    expect(renderer.renderDocument('copilot', SESSION, 'dark', 1, { acceptedMissing: ACCEPTED }))
      .toContain('Timeline');
    expect(analyzeSession(source, SESSION, { detector: detector(), acceptedMissing: ACCEPTED }))
      .toBeDefined();
    expect(copy).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  }, 30_000);
});

describe('native snapshot lifetime', () => {
  it('sees WAL-only commits and fresh cached models on the next request', () => {
    const db = writer();
    try {
      const before = value(service.getSessionDetail(SESSION));
      const mainMtime = fs.statSync(dbPath).mtimeMs;
      setModel(db, 'fresh-model');
      expect(fs.statSync(dbPath).mtimeMs).toBe(mainMtime);
      const after = value(service.getSessionDetail(SESSION));
      expect(after.summary.model).toBe('fresh-model');
      expect(after.summary.model).not.toBe(before.summary.model);
    } finally {
      db.close();
    }
  });

  it('keeps nested related queries in one consistent view while a writer commits', () => {
    const db = writer();
    try {
      service.readConsistently(() => {
        const before = value(service.getSessionDetail(SESSION));
        setModel(db, 'next-snapshot');
        // A direct interaction query must see the old values too, not just a
        // cached model map. The next outer request observes the new commit.
        const interactions = value(service.getSessionInteractions(SESSION));
        expect(interactions.some((row) => row.model === 'next-snapshot')).toBe(false);
        expect(value(service.getSessionDetail(SESSION))).toEqual(before);
      });
      expect(value(service.getSessionDetail(SESSION)).summary.model).toBe('next-snapshot');
      expect(db.pragma('wal_checkpoint(TRUNCATE)')).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
    } finally {
      db.close();
    }
  });

  it('groups all context-analysis reads in one native transaction scope', () => {
    const read = vi.spyOn(backend, 'read');
    new CopilotSource(service, config).getContextAnalysis(SESSION, ACCEPTED);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reuses the caller detail instead of reassembling it for context labels', () => {
    const source = new CopilotSource(service, config);
    const detail = value(source.getSessionDetail(SESSION));
    const expected = source.getContextAnalysis(SESSION, ACCEPTED);
    const readDetail = vi.spyOn(service, 'getSessionDetail');
    expect(source.getContextAnalysis(SESSION, ACCEPTED, detail)).toEqual(expected);
    expect(readDetail).not.toHaveBeenCalled();
    source.getContextAnalysis(SESSION, ACCEPTED, {
      ...detail, summary: { ...detail.summary, sessionId: 'other' },
    });
    expect(readDetail).toHaveBeenCalledTimes(1);
  });

  it('releases readers when a callback throws, without pinning WAL', () => {
    const db = writer();
    try {
      expect(() => service.readConsistently(() => {
        value(service.getSessionDetail(SESSION));
        setModel(db, 'committed-before-error');
        throw new Error('synthetic failure');
      })).toThrow('synthetic failure');
      expect(db.pragma('wal_checkpoint(TRUNCATE)')).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
      expect(value(service.getSessionDetail(SESSION)).summary.model).toBe('committed-before-error');
    } finally {
      db.close();
    }
  });

  it('does not retain a connection to a replaced file', () => {
    value(service.getSessionDetail(SESSION));
    fs.renameSync(dbPath, path.join(root, 'old.db'));
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const db = new Database(dbPath);
    setModel(db, 'replacement-model');
    db.close();
    expect(value(service.getSessionDetail(SESSION)).summary.model).toBe('replacement-model');
  });
});

describe('local title overlays', () => {
  it('reuses indexed names and sees title-only changes without an archive write', () => {
    titles.set(SESSION, { title: 'Indexed title', derived: false });
    expect(value(service.getSessionDetail(SESSION)).summary.title).toBe('Indexed title');
    titles.set(SESSION, { title: 'Renamed title', derived: false });
    expect(value(service.getSessionDetail(SESSION)).summary.title).toBe('Renamed title');
  });

  it('retains authoritative archived titles unless a current authoritative name overrides them', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE session_titles (chat_session_id TEXT, title TEXT, derived INTEGER)');
    db.prepare('INSERT INTO session_titles VALUES (?, ?, ?)').run(SESSION, 'Archived title', 0);
    db.close();
    expect(value(service.getSessionDetail(SESSION)).summary.title).toBe('Archived title');
    titles.set(SESSION, { title: 'Derived fallback', derived: true });
    expect(value(service.getSessionDetail(SESSION)).summary.title).toBe('Archived title');
    titles.set(SESSION, { title: 'Current name', derived: false });
    expect(value(service.getSessionDetail(SESSION)).summary.title).toBe('Current name');
  });

  it('resolves indexed UUID titles when telemetry uses a different conversation key', () => {
    const db = new Database(dbPath);
    db.prepare(`UPDATE spans SET conversation_id = ?, chat_session_id = ?
      WHERE COALESCE(conversation_id, chat_session_id) = ?`).run('conversation-turn', SESSION, SESSION);
    db.close();
    titles.set(SESSION, { title: 'Chat session name', derived: false });
    expect(value(service.getSessionDetail('conversation-turn')).summary.title).toBe('Chat session name');
  });
});

describe('source safety and failures', () => {
  it('opens source connections read-only and does not alter the source or schema', () => {
    const digest = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = digest();
    const opened: Database.Database[] = [];
    const original = Database.prototype.prepare;
    const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database, sql: string,
    ) {
      if (!opened.includes(this)) {
        opened.push(this);
        expect(this.readonly).toBe(true);
        expect(() => this.exec('DELETE FROM spans')).toThrow();
      }
      return original.call(this, sql);
    });
    value(service.getSessionDetail(SESSION));
    prepare.mockRestore();
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((db) => !db.open)).toBe(true);
    expect(digest()).toBe(before);
  });

  it('skips an invalid source when another source can answer', () => {
    const invalid = path.join(root, 'invalid.db');
    fs.writeFileSync(invalid, 'not sqlite');
    const result = backend.read([{ path: invalid }, { path: dbPath }], (handles) => {
      expect(handles).toHaveLength(1);
      return handles[0].db.getSessionDetail(SESSION);
    });
    expect(result?.summary.sessionId).toBe(SESSION);
  });

  it('reads every resolved native database and prefers the archive when present', () => {
    const stable = path.join(root, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
    const insiders = path.join(root, 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
    for (const file of [stable, insiders]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(FIXTURE_DB, file);
    }
    const stableDb = new Database(stable);
    stableDb.exec('DELETE FROM span_attributes; DELETE FROM spans');
    stableDb.close();
    const multi = new TelemetryService({
      isLocalTelemetryEnabled: () => true,
      getCodeFileExtensions: () => [], getDocFileExtensions: () => [],
      getSqlitePathOverride: () => undefined,
    }, { ...environment, env: { XDG_CONFIG_HOME: root } }, backend);
    expect(value(multi.getSessionDetail(SESSION)).summary.sessionId).toBe(SESSION);
    // A present archive is the sole source, exactly like the indexer and the
    // default snapshot service. No native spans may be double-counted.
    multi.setArchiveDbPath(stable);
    expect(value(multi.getOverview()).totalInteractions).toBe(0);
    expect(multi.getSessionDetail(SESSION)).toMatchObject({ ok: false, reason: 'missingDb' });
    multi.setArchiveDbPath(path.join(root, 'not-present.db'));
    expect(multi.getSessionDetail(SESSION).ok).toBe(true);
    multi.dispose();
  });

  it('honors repository exclusions without adding raw content to aggregation', () => {
    const repository = value(service.getSessionDetail(SESSION)).summary.repository;
    const filtered = new TelemetryService({
      isLocalTelemetryEnabled: () => true,
      getCodeFileExtensions: () => [], getDocFileExtensions: () => [],
      getSqlitePathOverride: () => dbPath,
      getExcludedRepositories: () => new Set([repository]),
    }, environment, backend);
    expect(value(filtered.getAggregationRows()).some((row) => row.repository === repository)).toBe(false);
    expect(value(filtered.listSessions()).some((row) => row.repository === repository)).toBe(false);
    const serialized = JSON.stringify(value(service.getAggregationRows()));
    expect(serialized).not.toContain('copilot_chat.user_request');
    expect(serialized).not.toContain('gen_ai.tool.call.arguments');
    expect(serialized).not.toContain('gen_ai.output.messages');
    filtered.dispose();
  });

  it('maps missing files and unsupported schema into typed failures and can recover', () => {
    fs.rmSync(dbPath);
    expect(service.getSessionDetail(SESSION)).toMatchObject({ ok: false, reason: 'missingDb' });
    fs.copyFileSync(FIXTURE_DB, dbPath);
    const db = new Database(dbPath);
    db.exec('UPDATE schema_version SET version = 999');
    db.close();
    expect(service.getSessionDetail(SESSION)).toMatchObject({ ok: false, reason: 'schemaMismatch' });
    // A leaked connection would prevent replacement on Windows.
    fs.rmSync(dbPath);
    fs.copyFileSync(FIXTURE_DB, dbPath);
    expect(service.getSessionDetail(SESSION).ok).toBe(true);
  });

  it('never opens sources while telemetry is disabled', () => {
    const read = vi.spyOn(backend, 'read');
    const disabled = new TelemetryService({
      isLocalTelemetryEnabled: () => false,
      getCodeFileExtensions: () => [], getDocFileExtensions: () => [],
      getSqlitePathOverride: () => dbPath,
    }, environment, backend);
    expect(disabled.getSessionDetail(SESSION)).toMatchObject({ ok: false, reason: 'disabled' });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps schema validation identical to the shared snapshot reader', () => {
    const db = new Database(dbPath);
    db.exec('DROP VIEW sessions');
    db.close();
    expect(() => backend.read([{ path: dbPath }], () => undefined)).toThrow('sessions');
    const snapshot = snapshots.createReadonlySnapshot(dbPath, { root: path.join(root, 'snapshots') });
    try {
      expect(() => TelemetryDatabase.open(snapshot.dbPath)).toThrow('sessions');
    } finally {
      snapshot.dispose();
    }
  });
});