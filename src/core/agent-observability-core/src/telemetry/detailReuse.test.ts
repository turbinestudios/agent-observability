import { describe, expect, it } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';
import type { ReadBindings } from './readBackend';

const SESSION = '97fb6af7-7d93-45fe-a00b-289fa761bf66';

describe('detail calculation reuse', () => {
  it('walks each tree id once and reads tool arguments/model/mode maps once per view', () => {
    const copy = copyFixtureToTemp();
    const raw = new Database(copy.dbPath, { readOnly: true });
    const calls: { sql: string; params?: ReadBindings }[] = [];
    const db = TelemetryDatabase.fromConnection({
      get: (sql, params) => raw.get(sql, params),
      all: (sql, params) => { calls.push({ sql, params }); return raw.all(sql, params); },
      close: () => raw.close(),
    });
    const writes = () => calls.filter((call) => call.params?.[0] === 'gen_ai.tool.call.arguments');
    const tree = () => calls.filter((call) => call.sql.includes('SELECT DISTINCT conversation_id, chat_session_id'));
    try {
      const detail = db.getSessionDetail(SESSION, ['.ts'], ['.md']);
      expect(detail).toBeDefined();
      expect(writes()).toHaveLength(1);
      expect(tree().length).toBeGreaterThan(1);
      expect(new Set(tree().map((call) => call.params?.[0])).size).toBe(tree().length);
      expect(calls.filter((call) => call.sql.includes("a.key = 'copilot_chat.mode_name'"))).toHaveLength(1);
      expect(calls.filter((call) => call.sql.includes('AND (response_model IS NOT NULL OR request_model IS NOT NULL)'))).toHaveLength(1);
      const walked = tree().length;
      expect(db.getSessionTreeStats(SESSION, ['.ts'], ['.md'])).toEqual(detail?.treeStats);
      db.getContextDiscoveryEvents(SESSION);
      expect(tree()).toHaveLength(walked);
      expect(writes()).toHaveLength(1);
      // A different classification must not reuse the previous line deltas.
      db.getSessionTreeStats(SESSION, ['.md'], ['.ts']);
      expect(writes()).toHaveLength(2);
      db.getSessionTreeStats('different-root');
      db.getSessionTreeStats(SESSION);
      expect(tree().length).toBeGreaterThan(walked); // one-entry tree cache
    } finally {
      db.close();
      copy.cleanup();
    }
  });

  it('does not expose mutable cached mode arrays to callers', () => {
    const copy = copyFixtureToTemp();
    const db = TelemetryDatabase.open(copy.dbPath);
    try {
      const first = db.getSessionDetail(SESSION);
      expect(first).toBeDefined();
      first!.summary.agentModes.push('custom');
      const next = db.getSessionDetail(SESSION);
      expect(next!.summary.agentModes).not.toEqual(first!.summary.agentModes);
    } finally {
      db.close();
      copy.cleanup();
    }
  });
});