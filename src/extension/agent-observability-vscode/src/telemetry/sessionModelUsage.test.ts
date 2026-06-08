import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * Exercises the per-model usage rollup (`SessionDetail.modelUsage`) added to
 * getSessionDetail, against the sanitized fixture from a temp COPY.
 *
 * Verified against the fixture (see the plan): the rollup accumulates over LLM
 * operations — `chat` AND MAIN-THREAD `invoke_agent`. The multi-model fixture
 * session below records its models/tokens ENTIRELY on `invoke_agent` spans (it
 * has no `chat` spans at all), so a chat-only rollup would wrongly produce zero
 * rows. SPAWNED sub-agent invoke_agent spans (a distinct chat_session_id from the
 * conversation) are excluded to avoid double-counting — see the
 * `invoke-agent-token-double-count` investigation.
 */

/**
 * Multi-model session: 7 invoke_agent spans. SIX are main-thread (chat_session_id
 * == conversation_id) across two distinct RESOLVED ids — `claude-opus-4-6`
 * (dashed response form) and `claude-opus-4.6` (a request-only span whose dotted
 * id stays a separate row). The SEVENTH is a spawned `claude-sonnet-4-6`
 * sub-agent (chat_session_id is a `toolu_…` tool-call id) that is EXCLUDED from
 * the rollup. Tool/hook spans (no model, no tokens) are likewise excluded.
 */
const MULTI_MODEL_SESSION = '8319bef8-8bca-40ce-9eb5-026215d785c0';
/** Single-model session: 11 `chat` spans, all `claude-opus-4-6`. */
const SINGLE_MODEL_SESSION = 'e7c40c84-7288-42c2-8aa3-54a296fba4f4';
/** Tool-only session (3 execute_tool spans, no LLM ops) → empty rollup. */
const TOOL_ONLY_SESSION = 'toolu_bdrk_01JXcDn11Bw6B9EfCNPTTnWU';

describe('TelemetryDatabase.getSessionDetail — modelUsage rollup', () => {
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

  it('rolls up a multi-model session into one row per resolved main-thread model', () => {
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    expect(detail.modelUsage).toHaveLength(2);
    // Assert the NATURAL (rendered) order — not a re-sorted copy — so the
    // (input+output) desc primary sort is actually locked against regression.
    expect(detail.modelUsage.map((u) => u.model)).toEqual([
      'claude-opus-4-6', // 5 main-thread spans, heaviest
      'claude-opus-4.6', // request-only span, 0 tokens
    ]);

    // The request-only dotted span carries no tokens but still counts as a call.
    const dotted = detail.modelUsage.find((u) => u.model === 'claude-opus-4.6');
    expect(dotted).toBeDefined();
    expect(dotted?.llmCalls).toBe(1);
    expect(dotted?.inputTokens).toBe(0);
  });

  it('excludes the spawned sub-agent (a distinct chat_session_id) from the rollup', () => {
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    // The only claude-sonnet-4-6 span in this session is a spawned sub-agent
    // (chat_session_id is a `toolu_…` tool-call id), so it must not appear.
    expect(detail.modelUsage.some((u) => u.model === 'claude-sonnet-4-6')).toBe(false);
    // Main-thread total: the sub-agent's 10,814 input tokens are NOT counted
    // (counting all invoke_agent spans would yield 469,461).
    expect(detail.summary.inputTokens).toBe(458647);
  });

  it('keeps the rollup token sums equal to the header totals', () => {
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    const sum = (key: 'inputTokens' | 'outputTokens' | 'cachedTokens') =>
      detail.modelUsage.reduce((acc, u) => acc + u[key], 0);
    expect(sum('inputTokens')).toBe(detail.summary.inputTokens);
    expect(sum('outputTokens')).toBe(detail.summary.outputTokens);
    expect(sum('cachedTokens')).toBe(detail.summary.cachedTokens);
  });

  it('counts main-thread invoke_agent spans in the header llmCalls (agent mode)', () => {
    // This session records its turns entirely on invoke_agent spans (no `chat`).
    // SIX are main-thread; the header LLM-call count must include them — counting
    // only `chat` (the old bug) would report 0 for every agent-mode session.
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    expect(detail.summary.llmCalls).toBe(6);
    // And the header count agrees with the per-model rollup (both count chat +
    // main-thread invoke_agent, excluding spawned sub-agents).
    const rollupCalls = detail.modelUsage.reduce((acc, u) => acc + u.llmCalls, 0);
    expect(detail.summary.llmCalls).toBe(rollupCalls);
  });

  it('reads the optional reasoning_tokens column (present in this fixture, all zero)', () => {
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    // The column exists in the fixture, so the field is wired through as a number.
    for (const u of detail.modelUsage) {
      expect(typeof u.reasoningTokens).toBe('number');
    }
    const reasoningTotal = detail.modelUsage.reduce((acc, u) => acc + u.reasoningTokens, 0);
    expect(reasoningTotal).toBe(0);
  });

  it('produces a single row for a single-model chat session', () => {
    const detail = db.getSessionDetail(SINGLE_MODEL_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }
    expect(detail.modelUsage).toHaveLength(1);
    expect(detail.modelUsage[0].model).toBe('claude-opus-4-6');
    expect(detail.modelUsage[0].llmCalls).toBe(detail.summary.llmCalls);
    expect(detail.modelUsage[0].inputTokens).toBe(detail.summary.inputTokens);
  });

  it('returns an empty rollup for a session with no LLM-operation spans', () => {
    const detail = db.getSessionDetail(TOOL_ONLY_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }
    // Tool/hook spans carry no model and no tokens — no spurious unknown bucket.
    expect(detail.modelUsage).toEqual([]);
  });

  it('attributes the spawned sub-agent in agentUsage without inflating the totals', () => {
    // 8319bef8: main thread is "GitHub Copilot Chat"; the lone spawned sub-agent
    // is "Infrastructure" on claude-sonnet-4-6 (10,814 input tokens).
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    const main = detail.agentUsage.filter((u) => u.kind === 'main');
    const subs = detail.agentUsage.filter((u) => u.kind === 'subagent');

    // Main-thread rows are all the one agent; they sum to the header totals.
    expect(new Set(main.map((u) => u.agentName))).toEqual(new Set(['GitHub Copilot Chat']));
    expect(main.reduce((a, u) => a + u.inputTokens, 0)).toBe(detail.summary.inputTokens);

    // The sub-agent is surfaced with its own agent name + model, but its tokens
    // are NOT in the session totals.
    expect(subs).toHaveLength(1);
    expect(subs[0].agentName).toBe('Infrastructure');
    expect(subs[0].model).toBe('claude-sonnet-4-6');
    expect(subs[0].inputTokens).toBe(10814);
    expect(main.some((u) => u.inputTokens === 10814)).toBe(false);

    // agentUsage is ordered main-thread first.
    expect(detail.agentUsage[0].kind).toBe('main');
    expect(detail.agentUsage[detail.agentUsage.length - 1].kind).toBe('subagent');
  });

  it('counts only main-thread tokens for an agent session that spawned a sub-agent', () => {
    // 97fb6af7: 8 invoke_agent spans, no chat. SEVEN are main-thread; ONE is a
    // spawned sub-agent (36,452 input tokens). Counting all eight (the old bug)
    // yields 578,124 input — this asserts the deduped main-thread totals, which
    // match what GitHub's per-session Agent Debug Logs reports.
    const detail = db.getSessionDetail('97fb6af7-7d93-45fe-a00b-289fa761bf66');
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    expect(detail.summary.inputTokens).toBe(541672);
    expect(detail.summary.outputTokens).toBe(10792);
    expect(detail.summary.cachedTokens).toBe(403638);
    // SEVEN main-thread invoke_agent spans → header LLM-call count of 7 (the
    // spawned sub-agent is excluded), not 0 as the chat-only counter produced.
    expect(detail.summary.llmCalls).toBe(7);
    // Single model, and the rollup still equals the header totals.
    expect(detail.modelUsage).toHaveLength(1);
    expect(detail.modelUsage[0].model).toBe('claude-opus-4-6');
    expect(detail.modelUsage[0].inputTokens).toBe(detail.summary.inputTokens);
    expect(detail.modelUsage[0].llmCalls).toBe(detail.summary.llmCalls);
  });

  it('returns undefined (no detail) for an unknown session key', () => {
    expect(db.getSessionDetail('does-not-exist')).toBeUndefined();
  });
});
