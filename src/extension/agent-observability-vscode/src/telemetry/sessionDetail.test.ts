import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * Exercises getSessionDetail against the sanitized fixture from a temp COPY.
 *
 * The fixture redacts `copilot_chat.user_request` to a `[redacted:N]`
 * placeholder — that is expected. The test asserts the field is POPULATED for
 * chat entries (with the redacted value), the timeline is ordered, and the
 * header counts are consistent.
 *
 * Session `e7c40c84-...` is a known fixture session with 11 chat spans, each
 * carrying a user_request attribute.
 */

const KNOWN_SESSION = 'e7c40c84-7288-42c2-8aa3-54a296fba4f4';

describe('TelemetryDatabase.getSessionDetail against the fixture', () => {
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

  it('uses a session key returned by listSessions', () => {
    const keys = db.listSessions().map((s) => s.sessionId);
    expect(keys).toContain(KNOWN_SESSION);
  });

  it('returns an ordered timeline with consistent header counts', () => {
    const detail = db.getSessionDetail(KNOWN_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    // Timeline is strictly non-decreasing by timestamp.
    for (let i = 1; i < detail.timeline.length; i++) {
      expect(detail.timeline[i].timestampMs).toBeGreaterThanOrEqual(
        detail.timeline[i - 1].timestampMs,
      );
    }

    // Header summary matches the timeline. The repository is sanitized: either
    // the canonical https form or the literal `unknown` (this fixture session
    // records no remote URL, so it legitimately resolves to `unknown`).
    expect(detail.summary.sessionId).toBe(KNOWN_SESSION);
    expect(
      detail.summary.repository === 'unknown' ||
        /^https?:\/\//.test(detail.summary.repository),
    ).toBe(true);
    expect(detail.summary.repository).not.toMatch(/[@?#\s]/);
    expect(detail.summary.interactionCount).toBe(detail.timeline.length);

    const chat = detail.timeline.filter((e) => e.operation === 'chat').length;
    const tools = detail.timeline.filter((e) => e.operation === 'execute_tool').length;
    expect(detail.summary.llmCalls).toBe(chat);
    expect(detail.summary.toolCalls).toBe(tools);
    expect(detail.summary.durationMs).toBe(
      detail.summary.endedAtMs - detail.summary.startedAtMs,
    );
  });

  it('populates userRequest for chat entries (redacted placeholder is expected)', () => {
    const detail = db.getSessionDetail(KNOWN_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    const chatEntries = detail.timeline.filter((e) => e.operation === 'chat');
    expect(chatEntries.length).toBeGreaterThan(0);

    const withRequest = chatEntries.filter(
      (e) => e.userRequest !== undefined && e.userRequest.length > 0,
    );
    expect(withRequest.length).toBeGreaterThan(0);

    // The fixture redacts the content to a `[redacted:N]` placeholder.
    for (const e of withRequest) {
      expect(e.userRequest).toMatch(/^\[redacted:\d+\]$/);
    }
  });

  it('does not attach userRequest to non-chat entries', () => {
    const detail = db.getSessionDetail(KNOWN_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }
    const nonChatWithRequest = detail.timeline.filter(
      (e) => e.operation !== 'chat' && e.userRequest !== undefined,
    );
    expect(nonChatWithRequest).toHaveLength(0);
  });

  it('returns undefined for an unknown session key', () => {
    expect(db.getSessionDetail('does-not-exist')).toBeUndefined();
  });
});
