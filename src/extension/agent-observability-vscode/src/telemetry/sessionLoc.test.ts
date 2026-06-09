import { describe, it, expect } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * LOCAL-ONLY Lines-of-Code / Lines-of-Documentation rollups in getSessionDetail /
 * getSessionTreeStats. These are parsed from the raw `gen_ai.tool.call.arguments`
 * attribute of file-writing `execute_tool` spans — which the checked-in fixture
 * sanitizes — so we open a WRITABLE connection to the temp COPY (never the
 * fixture), stamp a known `create_file` argument on every `execute_tool` span of
 * an agent tree, then read it back through the normal read-only adapter.
 */

const AGENT_RUN_SESSION = '97fb6af7-7d93-45fe-a00b-289fa761bf66';
const ARGS_KEY = 'gen_ai.tool.call.arguments';
const CODE_EXTS = ['.ts'];
const DOC_EXTS = ['.md'];
/** A create_file writing a 3-line .ts file → 3 code lines, 0 removed, per span. */
const STAMP_ARGS = JSON.stringify({ filePath: 'src/stamped.ts', content: 'a\nb\nc' });
const LINES_PER_SPAN = 3;

function treeIds(raw: Database, rootKey: string): string[] {
  const seen = new Set<string>([rootKey]);
  let frontier = [rootKey];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = raw.all(
        `SELECT DISTINCT conversation_id, chat_session_id FROM spans
           WHERE conversation_id = ? OR chat_session_id = ?`,
        [id, id],
      ) as Array<{ conversation_id: string | null; chat_session_id: string | null }>;
      for (const r of rows) {
        for (const v of [r.conversation_id, r.chat_session_id]) {
          if (v !== null && v.length > 0 && !seen.has(v)) {
            seen.add(v);
            next.push(v);
          }
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Stamp the known argument on every execute_tool span of the whole tree. Returns
 *  the tree-wide and main-thread execute_tool span counts. */
function stampToolArgs(dbPath: string, rootKey: string): { tree: number; main: number } {
  const raw = new Database(dbPath, { fileMustExist: true });
  try {
    const ids = treeIds(raw, rootKey);
    const inList = ids.map(() => '?').join(', ');
    const toolSpans = raw.all(
      `SELECT span_id FROM spans
         WHERE operation_name = 'execute_tool'
           AND (conversation_id IN (${inList}) OR chat_session_id IN (${inList}))`,
      [...ids, ...ids],
    ) as Array<{ span_id: string }>;
    raw.run(
      `DELETE FROM span_attributes WHERE key = ? AND span_id IN (
         SELECT span_id FROM spans
           WHERE operation_name = 'execute_tool'
             AND (conversation_id IN (${inList}) OR chat_session_id IN (${inList})))`,
      [ARGS_KEY, ...ids, ...ids],
    );
    // The stamped arguments are a create_file shape, so align tool_name too — the
    // parser dispatches on the real tool name (here every stamped span is create_file).
    raw.run(
      `UPDATE spans SET tool_name = 'create_file'
         WHERE operation_name = 'execute_tool'
           AND (conversation_id IN (${inList}) OR chat_session_id IN (${inList}))`,
      [...ids, ...ids],
    );
    for (const { span_id } of toolSpans) {
      raw.run('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)', [
        span_id,
        ARGS_KEY,
        STAMP_ARGS,
      ]);
    }
    const mainRows = raw.all(
      `SELECT COUNT(*) AS n FROM spans
         WHERE operation_name = 'execute_tool'
           AND COALESCE(conversation_id, chat_session_id) = ?`,
      [rootKey],
    ) as Array<{ n: number }>;
    return { tree: toolSpans.length, main: mainRows[0].n };
  } finally {
    raw.close();
  }
}

describe('TelemetryDatabase LoC/LoD rollups', () => {
  it('sums whole-tree code lines and attributes main-thread lines per turn', () => {
    const copy = copyFixtureToTemp();
    try {
      const counts = stampToolArgs(copy.dbPath, AGENT_RUN_SESSION);
      expect(counts.tree).toBeGreaterThan(0);

      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        const detail = db.getSessionDetail(AGENT_RUN_SESSION, CODE_EXTS, DOC_EXTS);
        if (detail === undefined) {
          throw new Error('expected detail');
        }

        // Whole-tree rollup: every stamped execute_tool span contributes 3 code lines.
        expect(detail.treeStats.linesOfCode).toBe(counts.tree * LINES_PER_SPAN);
        expect(detail.treeStats.linesOfDoc).toBe(0);
        expect(detail.treeStats.linesOfCodeRemoved).toBe(0);
        expect(detail.treeStats.linesOfDocRemoved).toBe(0);

        // Per-turn (main-thread) counts sum to the main-thread execute_tool subset.
        const turnLoc = detail.turns.reduce((a, t) => a + t.linesOfCode, 0);
        expect(turnLoc).toBe(counts.main * LINES_PER_SPAN);
        expect(detail.turns.reduce((a, t) => a + t.linesOfDoc, 0)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });

  it('reports 0 line counts when no extension lists are configured', () => {
    const copy = copyFixtureToTemp();
    try {
      stampToolArgs(copy.dbPath, AGENT_RUN_SESSION);
      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        // Default (no extensions) → the raw arguments are never even read.
        const detail = db.getSessionDetail(AGENT_RUN_SESSION);
        if (detail === undefined) {
          throw new Error('expected detail');
        }
        expect(detail.treeStats.linesOfCode).toBe(0);
        expect(detail.treeStats.linesOfDoc).toBe(0);
        expect(detail.turns.every((t) => t.linesOfCode === 0 && t.linesOfDoc === 0)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });
});
