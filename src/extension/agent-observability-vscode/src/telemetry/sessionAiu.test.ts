import { describe, it, expect } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * AIU (Copilot premium-request units) rollup in getSessionDetail.
 *
 * The checked-in fixture carries the `copilot_chat.copilot_usage_nano_aiu`
 * attribute but with sanitized ZERO values, so to exercise a real sum we open a
 * WRITABLE connection to the temp COPY (never the checked-in fixture) and stamp a
 * known nano-AIU on a single-model session's `chat` spans, then read it back
 * through the normal read-only adapter.
 *
 * The chosen session records its turns on 11 `chat` spans, all `claude-opus-4-6`
 * (see sessionModelUsage.test.ts). Verifies: per-model AIU sums the chat spans,
 * the header/total equals that sum, and AIU stays an exact integer nano count.
 */

const SINGLE_MODEL_SESSION = 'e7c40c84-7288-42c2-8aa3-54a296fba4f4';
const AIU_KEY = 'copilot_chat.copilot_usage_nano_aiu';
/** 1.25 AIU per chat span, as integer nano — chosen to expose any float drift. */
const PER_SPAN_NANO = 1_250_000_000;

/** Stamp a known nano-AIU on every `chat` span of `sessionKey` in the copy. */
function stampAiu(dbPath: string, sessionKey: string): number {
  const raw = new Database(dbPath, { fileMustExist: true });
  try {
    const chatSpans = raw.all(
      `SELECT span_id FROM spans
         WHERE operation_name = 'chat'
           AND COALESCE(conversation_id, chat_session_id) = ?`,
      [sessionKey],
    ) as Array<{ span_id: string }>;
    raw.run(`DELETE FROM span_attributes WHERE key = ? AND span_id IN (
               SELECT span_id FROM spans
                 WHERE operation_name = 'chat'
                   AND COALESCE(conversation_id, chat_session_id) = ?)`, [AIU_KEY, sessionKey]);
    for (const { span_id } of chatSpans) {
      raw.run('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)', [
        span_id,
        AIU_KEY,
        String(PER_SPAN_NANO),
      ]);
    }
    return chatSpans.length;
  } finally {
    raw.close();
  }
}

describe('TelemetryDatabase.getSessionDetail — AIU rollup', () => {
  it('sums nano-AIU per model and keeps the total exact', () => {
    const copy = copyFixtureToTemp();
    try {
      const chatCount = stampAiu(copy.dbPath, SINGLE_MODEL_SESSION);
      expect(chatCount).toBeGreaterThan(0);
      const expectedNano = chatCount * PER_SPAN_NANO;

      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        const detail = db.getSessionDetail(SINGLE_MODEL_SESSION);
        expect(detail).toBeDefined();
        if (detail === undefined) {
          return;
        }

        // Single model → one row carrying the full AIU sum.
        expect(detail.modelUsage).toHaveLength(1);
        expect(detail.modelUsage[0].model).toBe('claude-opus-4-6');
        expect(detail.modelUsage[0].aiuNano).toBe(expectedNano);

        // The per-model AIU sum reproduces the (renderer-computed) header total.
        const totalNano = detail.modelUsage.reduce((acc, u) => acc + u.aiuNano, 0);
        expect(totalNano).toBe(expectedNano);

        // Main-thread agent rows carry the same AIU (chat spans are kind 'main').
        const mainAiu = detail.agentUsage
          .filter((u) => u.kind === 'main')
          .reduce((acc, u) => acc + u.aiuNano, 0);
        expect(mainAiu).toBe(expectedNano);

        // Integer nano — no floating-point drift from accumulation.
        expect(Number.isInteger(detail.modelUsage[0].aiuNano)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });

  it('reports 0 AIU (not n/a) for a session whose spans carry no AIU attribute', () => {
    const copy = copyFixtureToTemp();
    try {
      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        const detail = db.getSessionDetail(SINGLE_MODEL_SESSION);
        if (detail === undefined) {
          throw new Error('expected detail');
        }
        // Fixture AIU values are sanitized to zero → the rollup is a clean 0.
        for (const u of detail.modelUsage) {
          expect(u.aiuNano).toBe(0);
        }
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });
});
