import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * Exercises the per-model usage rollup (`SessionDetail.modelUsage`) added to
 * getSessionDetail, against the sanitized fixture from a temp COPY.
 *
 * Verified against the fixture (see the plan): the rollup accumulates over LLM
 * operations — both `chat` AND `invoke_agent`. The multi-model fixture session
 * below records its models/tokens ENTIRELY on `invoke_agent` spans (it has no
 * `chat` spans at all), so a chat-only rollup would wrongly produce zero rows.
 */

/**
 * Multi-model session: 7 invoke_agent spans across three distinct RESOLVED ids —
 * `claude-opus-4-6` (dashed response form), `claude-sonnet-4-6`, and
 * `claude-opus-4.6` (a request-only span whose dotted id stays a separate row).
 * Tool/hook spans (no model, no tokens) are excluded from the rollup.
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

  it('rolls up a genuinely multi-model session into one row per resolved model', () => {
    const detail = db.getSessionDetail(MULTI_MODEL_SESSION);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    expect(detail.modelUsage).toHaveLength(3);
    // Assert the NATURAL (rendered) order — not a re-sorted copy — so the
    // (input+output) desc primary sort is actually locked against regression.
    expect(detail.modelUsage.map((u) => u.model)).toEqual([
      'claude-opus-4-6', // 475039 tokens (heaviest)
      'claude-sonnet-4-6', // 11061 tokens
      'claude-opus-4.6', // request-only span, 0 tokens
    ]);

    // The request-only dotted span carries no tokens but still counts as a call.
    const dotted = detail.modelUsage.find((u) => u.model === 'claude-opus-4.6');
    expect(dotted).toBeDefined();
    expect(dotted?.llmCalls).toBe(1);
    expect(dotted?.inputTokens).toBe(0);
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

  it('returns undefined (no detail) for an unknown session key', () => {
    expect(db.getSessionDetail('does-not-exist')).toBeUndefined();
  });
});
