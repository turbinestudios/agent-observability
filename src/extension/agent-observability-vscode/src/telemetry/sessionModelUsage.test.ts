import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';

/**
 * Exercises the per-model (`SessionDetail.modelUsage`) and per-agent
 * (`SessionDetail.agentUsage`) breakdowns in getSessionDetail.
 *
 * These breakdowns aggregate the WHOLE agent tree's `chat` spans (the main
 * conversation plus every spawned sub-agent — see treeUsageRollups), so each
 * agent and model shows its real tokens AND AIU and the tables RECONCILE with the
 * `treeStats` card. This is deliberately different from the main-thread
 * `SessionSummary`, which still excludes spawned sub-agents (see the
 * `invoke-agent-token-double-count` investigation).
 *
 * Numbers below are verified against the sanitized fixture.
 */

/**
 * The "Infrastructure" agent run. Its tree (8 ids) is one main thread
 * (`claude-opus-4-6`, 26 chat turns) plus a single spawned sub-agent
 * (`Infrastructure`) that ran two model forms (`claude-sonnet-4-6` and the
 * request-only dotted `claude-sonnet-4.6`).
 */
const AGENT_RUN_INFRA = '8319bef8-8bca-40ce-9eb5-026215d785c0';
/**
 * A CONSTITUENT chat conversation of the same Infrastructure run (its turns carry
 * `chat_session_id = 8319bef8`). Opening it resolves to the same tree — proving the
 * breakdown is independent of which tree node you open.
 */
const CONSTITUENT_CONVERSATION = 'e7c40c84-7288-42c2-8aa3-54a296fba4f4';
/**
 * The "default" agent run: one main thread plus a spawned (unnamed) sub-agent, all
 * `claude-opus-4-6`. Main 22 turns / 541,672 gross in (138,034 fresh); sub-agent 4
 * turns / 36,452 gross in (9,343 fresh).
 */
const AGENT_RUN_DEFAULT = '97fb6af7-7d93-45fe-a00b-289fa761bf66';

describe('TelemetryDatabase.getSessionDetail — tree-scoped model/agent breakdowns', () => {
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

  it('rolls the whole tree up into one row per resolved model, heaviest first', () => {
    const detail = db.getSessionDetail(AGENT_RUN_INFRA);
    expect(detail).toBeDefined();
    if (detail === undefined) {
      return;
    }

    // One main model + the sub-agent's two model forms. Assert the NATURAL
    // (rendered) order so the (input+output) desc primary sort is locked.
    expect(detail.modelUsage.map((u) => u.model)).toEqual([
      'claude-opus-4-6', // main thread, heaviest
      'claude-sonnet-4-6', // sub-agent
      'claude-sonnet-4.6', // sub-agent request-only form, 0 tokens
    ]);

    const opus = detail.modelUsage[0];
    expect(opus).toMatchObject({
      model: 'claude-opus-4-6',
      llmCalls: 26,
      // TIN = fresh (non-cache-read) input = gross 458647 − 435540 cache reads.
      inputTokens: 23107,
      outputTokens: 16392,
      cachedTokens: 435540,
    });

    const sonnet = detail.modelUsage.find((u) => u.model === 'claude-sonnet-4-6');
    expect(sonnet).toMatchObject({ llmCalls: 1, inputTokens: 10814, outputTokens: 247 });

    // No spurious `unknown` bucket — only `chat` spans (which carry a model) feed
    // the rollup, never tool/hook spans.
    expect(detail.modelUsage.some((u) => u.model === 'unknown')).toBe(false);
  });

  it('reconciles the per-model rollup with the tree-stats card (NOT the main-thread summary)', () => {
    const detail = db.getSessionDetail(AGENT_RUN_INFRA);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    const sum = (key: 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'llmCalls') =>
      detail.modelUsage.reduce((acc, u) => acc + u[key], 0);

    // The breakdown sums to the whole-tree card.
    expect(sum('inputTokens')).toBe(detail.treeStats.inputTokens); // 33,921 fresh
    expect(sum('outputTokens')).toBe(detail.treeStats.outputTokens);
    expect(sum('cachedTokens')).toBe(detail.treeStats.cachedTokens);
    expect(sum('llmCalls')).toBe(detail.treeStats.modelTurns); // 28 chat spans

    // And it is strictly larger than the main-thread summary (which omits the
    // spawned sub-agent) — the whole point of the change.
    expect(detail.treeStats.inputTokens).toBeGreaterThan(detail.summary.inputTokens);
    expect(sum('inputTokens')).not.toBe(detail.summary.inputTokens);
  });

  it('includes spawned sub-agent usage that the main-thread summary excludes', () => {
    const detail = db.getSessionDetail(AGENT_RUN_INFRA);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    // The sub-agent's model now appears (the old single-session rollup dropped it).
    expect(detail.modelUsage.some((u) => u.model === 'claude-sonnet-4-6')).toBe(true);
    // The main-thread summary still excludes it (23,107 fresh main vs 33,921 tree).
    expect(detail.summary.inputTokens).toBe(23107);
    expect(detail.summary.llmCalls).toBe(6); // 6 main-thread invoke_agent spans
  });

  it('attributes each agent (main + sub) in agentUsage with its real tokens', () => {
    const detail = db.getSessionDetail(AGENT_RUN_INFRA);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    const main = detail.agentUsage.filter((u) => u.kind === 'main');
    const subs = detail.agentUsage.filter((u) => u.kind === 'subagent');

    // Main thread is one friendly-labelled agent on claude-opus-4-6.
    expect(new Set(main.map((u) => u.agentName))).toEqual(new Set(['Main agent']));
    // Fresh main-thread input (gross 458647 − 435540 cache reads).
    expect(main.reduce((a, u) => a + u.inputTokens, 0)).toBe(23107);

    // The spawned sub-agent surfaces under its debug-log name, across both model
    // forms it ran.
    expect(new Set(subs.map((u) => u.agentName))).toEqual(new Set(['Sub-agent: Infrastructure']));
    expect(subs.reduce((a, u) => a + u.inputTokens, 0)).toBe(10814);

    // The whole breakdown reconciles with the tree card and is ordered main-first.
    expect(detail.agentUsage.reduce((a, u) => a + u.inputTokens, 0)).toBe(
      detail.treeStats.inputTokens,
    );
    expect(detail.agentUsage[0].kind).toBe('main');
    expect(detail.agentUsage[detail.agentUsage.length - 1].kind).toBe('subagent');
  });

  it('reads the optional reasoning_tokens column (present in this fixture, all zero)', () => {
    const detail = db.getSessionDetail(AGENT_RUN_INFRA);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    for (const u of detail.modelUsage) {
      expect(typeof u.reasoningTokens).toBe('number');
    }
    expect(detail.modelUsage.reduce((acc, u) => acc + u.reasoningTokens, 0)).toBe(0);
  });

  it('classifies main vs sub-agent independently of which tree node is opened', () => {
    // A constituent chat conversation and the agent root share one tree, so their
    // breakdowns are identical — and the main thread is still labelled `main`
    // (classification keys on the runSubagent debug label, not the root key).
    const fromRoot = db.getSessionDetail(AGENT_RUN_INFRA);
    const fromLeaf = db.getSessionDetail(CONSTITUENT_CONVERSATION);
    if (fromRoot === undefined || fromLeaf === undefined) {
      throw new Error('expected detail');
    }
    expect(fromLeaf.modelUsage).toEqual(fromRoot.modelUsage);
    expect(fromLeaf.agentUsage).toEqual(fromRoot.agentUsage);
    expect(fromLeaf.agentUsage.some((u) => u.kind === 'main')).toBe(true);
  });

  it('breaks down an agent run with a single shared model (main + default sub-agent)', () => {
    const detail = db.getSessionDetail(AGENT_RUN_DEFAULT);
    if (detail === undefined) {
      throw new Error('expected detail');
    }
    // Both threads ran claude-opus-4-6, so one model row carrying the tree total.
    expect(detail.modelUsage).toHaveLength(1);
    expect(detail.modelUsage[0]).toMatchObject({
      model: 'claude-opus-4-6',
      llmCalls: 26,
      // Fresh tree input = gross 578124 − 430747 cache reads.
      inputTokens: 147377,
    });
    expect(detail.modelUsage[0].inputTokens).toBe(detail.treeStats.inputTokens);

    // Main-thread summary still excludes the spawned sub-agent; TIN is now fresh
    // (gross 541672 − 403638 cache reads = 138034).
    expect(detail.summary.inputTokens).toBe(138034);
    expect(detail.summary.outputTokens).toBe(10792);
    expect(detail.summary.cachedTokens).toBe(403638);
    expect(detail.summary.llmCalls).toBe(7);

    // agentUsage splits the one model across the main thread and the unnamed
    // ("default") sub-agent.
    const main = detail.agentUsage.filter((u) => u.kind === 'main');
    const subs = detail.agentUsage.filter((u) => u.kind === 'subagent');
    expect(main).toHaveLength(1);
    // Fresh input: main 541672−403638=138034; sub 36452−27109=9343.
    expect(main[0]).toMatchObject({ agentName: 'Main agent', llmCalls: 22, inputTokens: 138034 });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ agentName: 'Sub-agent', llmCalls: 4, inputTokens: 9343 });
    expect(detail.agentUsage.reduce((a, u) => a + u.inputTokens, 0)).toBe(
      detail.treeStats.inputTokens,
    );
  });

  it('returns undefined (no detail) for an unknown session key', () => {
    expect(db.getSessionDetail('does-not-exist')).toBeUndefined();
  });
});
