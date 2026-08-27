import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { flattenSpans } from './otlpParse';
import { otlpSpansToRows } from './otlpToRows';
import { IngestStore } from './ingestStore';
import { TelemetryDatabase } from '../telemetry/database';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });

const SESSION = 'sess-S';

/** A coherent two-span session (one chat anchor + one failed tool call). */
const envelope = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'session.id', value: sv(SESSION) }] },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat gpt',
              spanId: 'c1',
              traceId: 'tr1',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.agent.name', value: sv('copilot') },
                { key: 'gen_ai.conversation.id', value: sv(SESSION) },
                { key: 'copilot_chat.chat_session_id', value: sv(SESSION) },
                { key: 'gen_ai.request.model', value: sv('gpt-x') },
                { key: 'gen_ai.response.model', value: sv('gpt-x') },
                { key: 'gen_ai.usage.input_tokens', value: iv(100) },
                { key: 'gen_ai.usage.output_tokens', value: iv(20) },
                { key: 'copilot_chat.user_request', value: sv('hello there') },
              ],
            },
            {
              name: 'execute_tool read_file',
              spanId: 't1',
              traceId: 'tr1',
              parentSpanId: 'c1',
              startTimeUnixNano: '1700000002000000000',
              endTimeUnixNano: '1700000002500000000',
              status: { code: 2, message: 'boom' },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('execute_tool') },
                { key: 'gen_ai.tool.name', value: sv('read_file') },
                { key: 'copilot_chat.chat_session_id', value: sv(SESSION) },
              ],
            },
          ],
        },
      ],
    },
  ],
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function freshDbPath(): string {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-ingest-'));
  return path.join(tmp, 'agent-traces.db');
}

describe('IngestStore → TelemetryDatabase round-trip', () => {
  it('persists OTLP spans so the existing read layer reads them back', () => {
    const dbPath = freshDbPath();
    const rows = otlpSpansToRows(flattenSpans(envelope));

    const store = new IngestStore(dbPath);
    expect(store.writeSpans(rows)).toBe(2);
    store.close();

    const db = TelemetryDatabase.open(dbPath);
    try {
      const interactions = db.getSessionInteractions(SESSION);
      expect(interactions.length).toBe(2);

      const chat = interactions.find((i) => i.operation === 'chat')!;
      expect(chat.agentName).toBe('copilot');
      expect(chat.model).toContain('gpt-x');
      expect(chat.inputTokens).toBe(100);
      expect(chat.outputTokens).toBe(20);
      expect(chat.success).toBe(true);

      const tool = interactions.find((i) => i.operation === 'execute_tool')!;
      expect(tool.toolName).toBe('read_file');
      expect(tool.success).toBe(false); // status_code 2 → failure

      // The full detail drill-down also builds from our DB.
      const detail = db.getSessionDetail(SESSION, [], []);
      expect(detail?.summary.sessionId).toBe(SESSION);
      expect(detail!.turns.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-writing the same spans never duplicates rows', () => {
    const dbPath = freshDbPath();
    const rows = otlpSpansToRows(flattenSpans(envelope));
    const store = new IngestStore(dbPath);
    store.writeSpans(rows);
    store.writeSpans(rows); // same span_ids → REPLACE, not duplicate
    store.close();

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.getSessionInteractions(SESSION).length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('prunes spans older than the retention window', () => {
    const dbPath = freshDbPath();
    const rows = otlpSpansToRows(flattenSpans(envelope)); // spans at ~1.7e12 ms (2023)
    const store = new IngestStore(dbPath);
    store.writeSpans(rows);
    // "now" far in the future with a 1-day window → both spans are stale.
    const removed = store.prune(24 * 60 * 60_000, 1_900_000_000_000);
    store.close();
    expect(removed).toBe(2);

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.getSessionInteractions(SESSION).length).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('IngestStore session-title sidecar', () => {
  const NOW = 1_700_000_100_000;

  it('round-trips titles through TelemetryDatabase.readArchivedSessionTitles', () => {
    const dbPath = freshDbPath();
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    expect(
      store.writeSessionTitles(new Map([[SESSION, { title: 'Fix upload bug', derived: false }]]), NOW),
    ).toBe(1);
    store.close();

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.readArchivedSessionTitles().get(SESSION)).toEqual({
        title: 'Fix upload bug',
        derived: false,
      });
    } finally {
      db.close();
    }
  });

  it('readArchivedSessionTitles is empty for a DB without the sidecar table', () => {
    // A native Copilot DB has no session_titles table; simulate by dropping it.
    const dbPath = freshDbPath();
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    store.close();
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE session_titles');
    raw.close();

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.readArchivedSessionTitles().size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('writes only new or changed rows, so a quiet sweep leaves the file untouched', () => {
    const dbPath = freshDbPath();
    const store = new IngestStore(dbPath);
    const titles = new Map([[SESSION, { title: 'Fix upload bug', derived: false }]]);
    expect(store.writeSessionTitles(titles, NOW)).toBe(1);
    expect(store.writeSessionTitles(titles, NOW + 60_000)).toBe(0); // unchanged → no write
    expect(
      store.writeSessionTitles(new Map([[SESSION, { title: 'Renamed', derived: false }]]), NOW + 120_000),
    ).toBe(1); // a rename IS written
    store.close();
  });

  it('never downgrades a stored authoritative title to a derived fallback', () => {
    const dbPath = freshDbPath();
    const store = new IngestStore(dbPath);
    store.writeSessionTitles(new Map([[SESSION, { title: 'Real name', derived: false }]]), NOW);
    // The native index rotated out; only the derived fallback remains upstream.
    expect(
      store.writeSessionTitles(new Map([[SESSION, { title: 'hello there…', derived: true }]]), NOW + 1),
    ).toBe(0);
    store.close();

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.readArchivedSessionTitles().get(SESSION)).toEqual({
        title: 'Real name',
        derived: false,
      });
    } finally {
      db.close();
    }
  });

  it('prune removes titles whose sessions have no spans left', () => {
    const dbPath = freshDbPath();
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    store.writeSessionTitles(new Map([[SESSION, { title: 'Fix upload bug', derived: false }]]), NOW);
    store.prune(24 * 60 * 60_000, 1_900_000_000_000); // all spans stale
    store.close();

    const db = TelemetryDatabase.open(dbPath);
    try {
      expect(db.readArchivedSessionTitles().size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('knownChatSessionIds lists the distinct chat_session_ids of stored spans', () => {
    const dbPath = freshDbPath();
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    expect(store.knownChatSessionIds()).toEqual(new Set([SESSION]));
    store.close();
  });
});
