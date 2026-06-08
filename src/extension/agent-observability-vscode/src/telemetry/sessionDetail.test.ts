import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * Exercises getSessionDetail against the sanitized fixture from a temp COPY.
 *
 * The fixture redacts `copilot_chat.user_request` / `gen_ai.output.messages` to a
 * `[redacted:N]` placeholder — that is expected. The test asserts the per-turn
 * request/response are POPULATED (with the redacted value), the turns are
 * ordered, and the header counts are consistent with the grouped structure.
 *
 * Session `e7c40c84-...` is a known fixture session with 11 chat spans, each
 * carrying a user_request attribute and no tool/hook spans — so it groups into
 * 11 anchored turns with no nested events.
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

  it('returns ordered turns that partition every span with consistent header counts', () => {
    const detail = db.getSessionDetail(KNOWN_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    // A turn is "anchored" when it originated from a user-request span; the rest
    // are tool/hook/sub-agent events. Every span is accounted for exactly once.
    const anchored = detail.turns.filter((t) => t.userRequest !== undefined);
    const allEvents = detail.turns.flatMap((t) => t.events);
    expect(anchored.length + allEvents.length).toBe(detail.summary.interactionCount);

    // Flattened timeline (anchor start, then its events, per turn) is strictly
    // non-decreasing by timestamp.
    const stamps = detail.turns.flatMap((t) => [t.timestampMs, ...t.events.map((e) => e.timestampMs)]);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
    }

    // Repository is sanitized: either the canonical https form or the literal
    // `unknown` (this fixture session records no remote URL).
    expect(detail.summary.sessionId).toBe(KNOWN_SESSION);
    expect(
      detail.summary.repository === 'unknown' ||
        /^https?:\/\//.test(detail.summary.repository),
    ).toBe(true);
    expect(detail.summary.repository).not.toMatch(/[@?#\s]/);

    // Tools/hooks never anchor a turn — they appear only as nested events, so the
    // tool-call header count equals the execute_tool events.
    const toolEvents = allEvents.filter((e) => e.operation === 'execute_tool');
    expect(toolEvents.length).toBe(detail.summary.toolCalls);

    expect(detail.summary.durationMs).toBe(
      detail.summary.endedAtMs - detail.summary.startedAtMs,
    );

    // Per-turn token totals partition the session totals (sub-agent tokens are
    // excluded from both), so summing every turn reproduces the header counts.
    const turns = detail.turns;
    const sum = (pick: (t: (typeof turns)[number]) => number) =>
      turns.reduce((acc, t) => acc + pick(t), 0);
    expect(sum((t) => t.inputTokens)).toBe(detail.summary.inputTokens);
    expect(sum((t) => t.outputTokens)).toBe(detail.summary.outputTokens);
    expect(sum((t) => t.cachedTokens)).toBe(detail.summary.cachedTokens);
  });

  it('groups the known chat session into anchored, event-free turns', () => {
    const detail = db.getSessionDetail(KNOWN_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }
    // 11 chat spans → 11 anchored turns, each with no nested events.
    expect(detail.turns).toHaveLength(11);
    expect(detail.turns.every((t) => t.userRequest !== undefined)).toBe(true);
    expect(detail.turns.every((t) => t.events.length === 0)).toBe(true);
    // chat spans are the LLM calls for this ask-mode session.
    expect(detail.summary.llmCalls).toBe(11);
  });

  it('populates userRequest and finalResponse per turn (redacted placeholder is expected)', () => {
    const detail = db.getSessionDetail(KNOWN_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    const withRequest = detail.turns.filter(
      (t) => t.userRequest !== undefined && t.userRequest.length > 0,
    );
    expect(withRequest.length).toBeGreaterThan(0);
    for (const t of withRequest) {
      // The fixture redacts the content to a `[redacted:N]` placeholder.
      expect(t.userRequest).toMatch(/^\[redacted:\d+\]$/);
    }

    // The chat spans of this session also carry gen_ai.output.messages, so the
    // final response is surfaced (likewise a redacted placeholder).
    const withResponse = detail.turns.filter(
      (t) => t.finalResponse !== undefined && t.finalResponse.length > 0,
    );
    expect(withResponse.length).toBeGreaterThan(0);
    for (const t of withResponse) {
      expect(t.finalResponse).toMatch(/^\[redacted:\d+\]$/);
    }
  });

  it('returns undefined for an unknown session key', () => {
    expect(db.getSessionDetail('does-not-exist')).toBeUndefined();
  });
});
