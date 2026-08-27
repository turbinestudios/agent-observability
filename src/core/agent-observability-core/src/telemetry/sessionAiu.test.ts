import { describe, it, expect } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * AIU (Copilot premium-request units) rollups in getSessionDetail.
 *
 * AIU is recorded only on `chat` spans, and a spawned sub-agent's `chat` spans
 * live under their OWN conversation id. The per-model/per-agent breakdowns
 * therefore aggregate the WHOLE agent tree's chat spans (like getSessionTreeStats),
 * so sub-agent AIU is no longer lost as 0 and the breakdown totals reconcile with
 * the tree-stats card.
 *
 * The checked-in fixture carries the `copilot_chat.copilot_usage_nano_aiu`
 * attribute but with sanitized ZERO values, so to exercise a real sum we open a
 * WRITABLE connection to the temp COPY (never the checked-in fixture) and stamp a
 * known nano-AIU on every chat span of an agent TREE, then read it back through the
 * normal read-only adapter.
 */

/**
 * An agent-mode run that spawned a sub-agent; its tree spans several conversation
 * ids. Main thread = 22 chat turns, spawned sub-agent = 4 chat turns (26 total).
 */
const AGENT_RUN_SESSION = '97fb6af7-7d93-45fe-a00b-289fa761bf66';
const AIU_KEY = 'copilot_chat.copilot_usage_nano_aiu';
/** 1.25 AIU per chat span, as integer nano — chosen to expose any float drift. */
const PER_SPAN_NANO = 1_250_000_000;

/**
 * Derive the agent-tree id set (connected component over conversation/chat-session
 * edges) for `rootKey`, mirroring TelemetryDatabase.sessionTreeIds — used to stamp
 * AIU across a whole run so the tree rollup's cross-conversation sum is exercised.
 */
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

/**
 * Stamp a known nano-AIU on every `chat` span of the whole agent TREE rooted at
 * `rootKey` (across all its conversation ids). Returns the number of chat spans
 * stamped.
 */
function stampAiuTree(dbPath: string, rootKey: string): number {
  const raw = new Database(dbPath, { fileMustExist: true });
  try {
    const ids = treeIds(raw, rootKey);
    const inList = ids.map(() => '?').join(', ');
    const chatSpans = raw.all(
      `SELECT span_id FROM spans
         WHERE operation_name = 'chat'
           AND (conversation_id IN (${inList}) OR chat_session_id IN (${inList}))`,
      [...ids, ...ids],
    ) as Array<{ span_id: string }>;
    raw.run(
      `DELETE FROM span_attributes WHERE key = ? AND span_id IN (
         SELECT span_id FROM spans
           WHERE operation_name = 'chat'
             AND (conversation_id IN (${inList}) OR chat_session_id IN (${inList})))`,
      [AIU_KEY, ...ids, ...ids],
    );
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
  it('attributes AIU to each agent and model across the tree and stays exact', () => {
    const copy = copyFixtureToTemp();
    try {
      const chatCount = stampAiuTree(copy.dbPath, AGENT_RUN_SESSION);
      expect(chatCount).toBe(26); // 22 main + 4 sub-agent chat turns
      const expectedNano = chatCount * PER_SPAN_NANO;

      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        const detail = db.getSessionDetail(AGENT_RUN_SESSION);
        if (detail === undefined) {
          throw new Error('expected detail');
        }

        // The per-model and per-agent breakdowns each sum to the whole-tree AIU,
        // and that equals the tree-stats card — they all read from the same source.
        const modelAiu = detail.modelUsage.reduce((a, u) => a + u.aiuNano, 0);
        const agentAiu = detail.agentUsage.reduce((a, u) => a + u.aiuNano, 0);
        expect(modelAiu).toBe(expectedNano);
        expect(agentAiu).toBe(expectedNano);
        expect(detail.treeStats.aiuNano).toBe(expectedNano);

        // The fix: the spawned sub-agent's rows now carry REAL AIU (4 chat turns),
        // not 0 as the old single-session rollup reported.
        const subAiu = detail.agentUsage
          .filter((u) => u.kind === 'subagent')
          .reduce((a, u) => a + u.aiuNano, 0);
        expect(subAiu).toBe(4 * PER_SPAN_NANO);

        // Integer nano — no floating-point drift from accumulation.
        expect(Number.isInteger(modelAiu)).toBe(true);
        expect(detail.modelUsage.every((u) => Number.isInteger(u.aiuNano))).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });

  it('reports 0 AIU (not n/a) when the tree spans carry no AIU attribute', () => {
    const copy = copyFixtureToTemp();
    try {
      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        const detail = db.getSessionDetail(AGENT_RUN_SESSION);
        if (detail === undefined) {
          throw new Error('expected detail');
        }
        // Fixture AIU values are sanitized to zero → every rollup is a clean 0.
        for (const u of detail.modelUsage) {
          expect(u.aiuNano).toBe(0);
        }
        for (const u of detail.agentUsage) {
          expect(u.aiuNano).toBe(0);
        }
        expect(detail.treeStats.aiuNano).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });
});

describe('TelemetryDatabase.getSessionTreeStats — AIU rollup (whole agent tree)', () => {
  it('sums nano-AIU over the whole tree (every chat span, all sub-agents)', () => {
    const copy = copyFixtureToTemp();
    try {
      const chatCount = stampAiuTree(copy.dbPath, AGENT_RUN_SESSION);
      expect(chatCount).toBeGreaterThan(0);
      const expectedNano = chatCount * PER_SPAN_NANO;

      const db = TelemetryDatabase.open(copy.dbPath);
      try {
        const stats = db.getSessionTreeStats(AGENT_RUN_SESSION);
        expect(stats).toBeDefined();
        if (stats === undefined) {
          return;
        }
        // Every model turn in the tree is a stamped chat span, so the count and
        // the AIU sum agree exactly — and stay exact integer nano.
        expect(stats.modelTurns).toBe(chatCount);
        expect(stats.aiuNano).toBe(expectedNano);
        expect(Number.isInteger(stats.aiuNano)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      copy.cleanup();
    }
  });
});
