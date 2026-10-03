import { describe, expect, it } from 'vitest';
import type {
  SessionAgentUsage,
  SessionDetail,
  SessionSummary,
  SessionTimelineEntry,
  SessionTreeStats,
  SessionTurn,
} from '../telemetry/models';
import {
  MAX_TIPS,
  assessPrompt,
  buildSessionRetrospective,
  evaluateAdvice,
  isCorrectionPrompt,
  sessionCodeChurn,
  type RetrospectiveSignals,
} from './retrospective';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Zeroed bases spread per test, following the style of sessionDetailHtml.test.ts.

const ZERO_TREE: SessionTreeStats = {
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  errorCount: 0,
  aiuNano: 0,
  linesOfCode: 0,
  linesOfDoc: 0,
  linesOfCodeRemoved: 0,
  linesOfDocRemoved: 0,
};

function ev(overrides: Partial<SessionTimelineEntry> = {}): SessionTimelineEntry {
  return {
    timestampMs: 0,
    operation: 'execute_tool',
    agentMode: 'agent',
    model: 'model-a',
    durationMs: 0,
    success: true,
    ...overrides,
  };
}

function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    timestampMs: 0,
    agentMode: 'agent',
    model: 'model-a',
    durationMs: 0,
    success: true,
    llmCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    events: [],
    ...overrides,
  };
}

function summaryOf(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    repository: 'repo',
    startedAtMs: 0,
    endedAtMs: 0,
    durationMs: 0,
    interactionCount: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    model: 'model-a',
    agentModes: [],
    ...overrides,
  };
}

function detailOf(turns: SessionTurn[], overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    summary: summaryOf(),
    treeStats: { ...ZERO_TREE },
    turns,
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
    ...overrides,
  };
}

function agentRow(overrides: Partial<SessionAgentUsage> = {}): SessionAgentUsage {
  return {
    agentName: 'Sub-agent',
    model: 'model-a',
    kind: 'subagent',
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    aiuNano: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    ...overrides,
  };
}

function sig(overrides: Partial<RetrospectiveSignals> = {}): RetrospectiveSignals {
  return {
    interruptionCount: 0,
    endedWithInterruption: false,
    compactionCount: 0,
    planModeUsed: false,
    apiErrorCount: 0,
    lastEvent: 'assistant-response',
    ...overrides,
  };
}

function findingIds(detail: SessionDetail, signals?: RetrospectiveSignals): string[] {
  return buildSessionRetrospective(detail, signals).findings.map((f) => f.id);
}

// ── Corrections ─────────────────────────────────────────────────────────────

describe('buildSessionRetrospective — correction re-prompts', () => {
  it("flags a follow-up starting with 'no,' as a correction with its turn index", () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Add a logout button to the navbar', finalResponse: 'Added.' }),
        turn({ userRequest: 'no, put it in the settings menu', finalResponse: 'Moved.' }),
      ]),
    );
    const correction = retro.findings.find((f) => f.id === 'correction-reprompt');
    expect(correction?.turnIndex).toBe(1);
    expect(retro.counts.correctionTurns).toBe(1);
  });

  it("flags \"that's wrong\" appearing inside the scanned window", () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Make the button blue', finalResponse: 'Done.' }),
        turn({ userRequest: "hm, that's wrong — it should be teal", finalResponse: 'Fixed.' }),
      ]),
    );
    expect(retro.counts.correctionTurns).toBe(1);
  });

  it("never flags the first prompt, even when it starts with 'no'", () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'no error handling exists yet, add some', finalResponse: 'Done.' })]),
    );
    expect(retro.counts.correctionTurns).toBe(0);
  });

  it("does not flag 'instead' appearing beyond the leading position", () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Convert the config to YAML', finalResponse: 'Done.' }),
        turn({ userRequest: 'also use tabs for indentation instead', finalResponse: 'Done.' }),
      ]),
    );
    expect(retro.counts.correctionTurns).toBe(0);
  });

  it("counts 'revert that' only when an earlier turn actually wrote lines", () => {
    const afterWrites = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Refactor the parser', finalResponse: 'Done.', linesOfCode: 40 }),
        turn({ userRequest: 'revert that change', finalResponse: 'Reverted.' }),
      ]),
    );
    expect(afterWrites.counts.correctionTurns).toBe(1);

    const asTask = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'List the recent commits', finalResponse: 'Here.' }),
        turn({ userRequest: 'revert commit abc123', finalResponse: 'Reverted.' }),
      ]),
    );
    expect(asTask.counts.correctionTurns).toBe(0);
  });

  it('does not flag short acknowledgments', () => {
    for (const ack of ['ok', 'go ahead', '2', 'looks good', 'no worries']) {
      expect(isCorrectionPrompt(ack, true)).toBe(false);
    }
  });

  it("flags a bare 'no' follow-up", () => {
    expect(isCorrectionPrompt('no', false)).toBe(true);
  });

  it("does not flag 'stop the server' — a task, not a correction", () => {
    expect(isCorrectionPrompt('stop the server and rerun the build', false)).toBe(false);
  });
});

// ── Repeated prompts ────────────────────────────────────────────────────────

describe('buildSessionRetrospective — repeated prompts', () => {
  it('flags a later prompt that re-asks the same thing in different order', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'please make the page header sticky when scrolling down' }),
        turn({ userRequest: 'make the header sticky when scrolling down the page please' }),
      ]),
    );
    const finding = retro.findings.find((f) => f.id === 'repeated-prompt');
    expect(finding?.turnIndex).toBe(1);
    expect(retro.counts.repeatedPromptTurns).toBe(1);
  });

  it('does not flag two prompts that merely share a couple of words', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'please add pagination controls to the results table component' }),
        turn({ userRequest: 'now write integration tests covering the login redirect flows please' }),
      ]),
    );
    expect(retro.counts.repeatedPromptTurns).toBe(0);
  });

  it('skips prompts with too few distinct tokens to compare', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'fix it' }), turn({ userRequest: 'fix it' })]),
    );
    expect(retro.counts.repeatedPromptTurns).toBe(0);
  });
});

// ── Tool-error streaks ──────────────────────────────────────────────────────

describe('buildSessionRetrospective — tool-error streaks', () => {
  it('three consecutive failed tool events form one streak finding with its length', () => {
    const fail = ev({ success: false });
    const retro = buildSessionRetrospective(detailOf([turn({ events: [fail, fail, fail] })]));
    const finding = retro.findings.find((f) => f.id === 'tool-error-streak');
    expect(finding?.value).toBe(3);
    expect(retro.counts.maxErrorStreak).toBe(3);
    expect(retro.verdict).toBe('bumpy');
  });

  it('a success in the middle resets the run', () => {
    const fail = ev({ success: false });
    const retro = buildSessionRetrospective(
      detailOf([turn({ events: [fail, fail, ev(), fail, fail] })]),
    );
    expect(retro.counts.errorStreaks).toBe(0);
  });

  it('streaks do not join across turn boundaries', () => {
    const fail = ev({ success: false });
    const retro = buildSessionRetrospective(
      detailOf([turn({ events: [fail, fail] }), turn({ events: [fail] })]),
    );
    expect(retro.counts.errorStreaks).toBe(0);
  });

  it('failed model calls do not count toward a tool streak', () => {
    const chatFail = ev({ operation: 'chat', success: false });
    const retro = buildSessionRetrospective(
      detailOf([turn({ events: [chatFail, chatFail, chatFail, ev({ operation: 'chat' })] })]),
    );
    expect(retro.findings.some((f) => f.id === 'tool-error-streak')).toBe(false);
  });

  it('a five-failure streak alone marks the session struggled', () => {
    const fail = ev({ success: false });
    const retro = buildSessionRetrospective(
      detailOf([turn({ events: [fail, fail, fail, fail, fail] })]),
    );
    expect(retro.verdict).toBe('struggled');
    expect(retro.verdictReasons).toContain('tool-error-streak');
  });
});

// ── Rework churn ────────────────────────────────────────────────────────────

describe('buildSessionRetrospective — rework churn', () => {
  it('flags a session that removed 60% of the code lines it added', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ linesOfCode: 100, linesOfCodeRemoved: 60 })]),
    );
    const finding = retro.findings.find((f) => f.id === 'rework-churn');
    expect(finding?.value).toBe(60);
    expect(retro.counts.churnRatioPct).toBe(60);
    expect(retro.verdict).toBe('bumpy');
  });

  it('stays silent below the minimum written-lines floor', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ linesOfCode: 30, linesOfCodeRemoved: 30 })]),
    );
    expect(retro.findings.some((f) => f.id === 'rework-churn')).toBe(false);
    expect(retro.counts.churnRatioPct).toBe(0);
  });

  it('doc lines never contribute to churn', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ linesOfDoc: 200, linesOfDocRemoved: 180 })]),
    );
    expect(retro.findings.some((f) => f.id === 'rework-churn')).toBe(false);
  });

  it('sessionCodeChurn reports added, removed, and the rounded ratio', () => {
    expect(sessionCodeChurn([turn({ linesOfCode: 80, linesOfCodeRemoved: 20 })])).toEqual({
      added: 80,
      removed: 20,
      ratioPct: 25,
    });
  });
});

// ── Long-tail turns ─────────────────────────────────────────────────────────

describe('buildSessionRetrospective — long-tail turns', () => {
  it('flags a turn with eleven minutes of active event time, summed from durations', () => {
    // Claude turns carry durationMs 0 — activity must come from the events.
    const retro = buildSessionRetrospective(
      detailOf([
        turn({
          events: [
            ev({ durationMs: 4 * 60_000 }),
            ev({ durationMs: 4 * 60_000 }),
            ev({ durationMs: 3 * 60_000 }),
          ],
        }),
      ]),
    );
    const finding = retro.findings.find((f) => f.id === 'long-tail-turn');
    expect(finding?.severity).toBe('info');
    expect(retro.verdict).toBe('smooth');
  });

  it('does not mistake one long idle gap for a long turn', () => {
    // A single 700-minute event duration is an overnight pause, not work —
    // the per-event clamp keeps it below the threshold.
    const retro = buildSessionRetrospective(
      detailOf([turn({ events: [ev({ operation: 'chat', durationMs: 700 * 60_000 })] })]),
    );
    expect(retro.findings.some((f) => f.id === 'long-tail-turn')).toBe(false);
  });

  it('never flags a turn without events', () => {
    const retro = buildSessionRetrospective(detailOf([turn({ timestampMs: 1_000 })]));
    expect(retro.findings.some((f) => f.id === 'long-tail-turn')).toBe(false);
  });
});

// ── Transcript-only signals ─────────────────────────────────────────────────

describe('buildSessionRetrospective — transcript signals', () => {
  it('two interruptions produce one finding with the count, and at least bumpy', () => {
    const retro = buildSessionRetrospective(detailOf([turn({})]), sig({ interruptionCount: 2 }));
    const finding = retro.findings.find((f) => f.id === 'user-interruption');
    expect(finding?.value).toBe(2);
    expect(retro.verdict).toBe('bumpy');
  });

  it('counts an interruption-marker turn even without extracted signals', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Tidy the imports', finalResponse: 'Done.' }),
        turn({ userRequest: '[Request interrupted by user]', llmCalls: 0 }),
      ]),
      undefined,
      // Old session: well past the recent-activity grace.
      Date.now(),
    );
    expect(retro.counts.interruptions).toBe(1);
    // The marker is an interruption, never a correction or a prompt.
    expect(retro.counts.correctionTurns).toBe(0);
    expect(retro.firstPrompt).toBeDefined();
  });

  it('two compactions are friction; one is only information', () => {
    const two = buildSessionRetrospective(detailOf([turn({})]), sig({ compactionCount: 2 }));
    expect(two.findings.find((f) => f.id === 'context-compaction')?.severity).toBe('friction');
    expect(two.verdict).toBe('bumpy');

    const one = buildSessionRetrospective(detailOf([turn({})]), sig({ compactionCount: 1 }));
    expect(one.findings.find((f) => f.id === 'context-compaction')?.severity).toBe('info');
    expect(one.verdict).toBe('smooth');
  });

  it('notes plan mode was skipped only for sessions that wrote a lot across turns', () => {
    const writing = [
      turn({ linesOfCode: 120 }),
      turn({ linesOfCode: 120 }),
      turn({ linesOfCode: 120 }),
    ];
    const skipped = buildSessionRetrospective(detailOf(writing), sig({ planModeUsed: false }));
    expect(skipped.findings.find((f) => f.id === 'plan-mode-skipped')?.severity).toBe('info');
    expect(skipped.verdict).toBe('smooth');

    const used = buildSessionRetrospective(detailOf(writing), sig({ planModeUsed: true }));
    expect(used.findings.some((f) => f.id === 'plan-mode-skipped')).toBe(false);
  });

  it('omitted signals produce no interruption, compaction, or plan-mode findings', () => {
    const ids = findingIds(detailOf([turn({ linesOfCode: 400 })]));
    expect(ids).not.toContain('user-interruption');
    expect(ids).not.toContain('context-compaction');
    expect(ids).not.toContain('plan-mode-skipped');
  });
});

// ── Sub-agent fan-out ───────────────────────────────────────────────────────

describe('buildSessionRetrospective — sub-agent fan-out', () => {
  it('notes a fan-out-heavy session without changing a smooth verdict', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({})], {
        treeStats: { ...ZERO_TREE, totalTokens: 150_000 },
        agentUsage: [agentRow({ inputTokens: 100_000, outputTokens: 5_000, llmCalls: 10 })],
      }),
    );
    expect(retro.findings.find((f) => f.id === 'subagent-heavy')?.severity).toBe('info');
    expect(retro.verdict).toBe('smooth');
  });

  it('stays silent when the main thread dominates', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({})], {
        treeStats: { ...ZERO_TREE, totalTokens: 150_000 },
        agentUsage: [agentRow({ kind: 'main', inputTokens: 140_000 })],
      }),
    );
    expect(retro.findings.some((f) => f.id === 'subagent-heavy')).toBe(false);
  });
});

// ── Opening prompt ──────────────────────────────────────────────────────────

describe('buildSessionRetrospective — the opening prompt', () => {
  it("rates 'fix the bug' vague, but keeps it informational without corrections", () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'fix the bug', finalResponse: 'Fixed.' })]),
    );
    expect(retro.firstPrompt?.rating).toBe('vague');
    expect(retro.findings.find((f) => f.id === 'vague-first-prompt')?.severity).toBe('info');
    expect(retro.verdict).toBe('smooth');
  });

  it('upgrades a vague prompt to friction when two corrections followed', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'fix the bug', finalResponse: 'Fixed one.' }),
        turn({ userRequest: 'no, the one in the login flow', finalResponse: 'Fixed.' }),
        turn({ userRequest: "that's not it either, look at the redirect", finalResponse: 'Fixed.' }),
      ]),
    );
    expect(retro.findings.find((f) => f.id === 'vague-first-prompt')?.severity).toBe('friction');
    expect(retro.tips.some((t) => t.id === 'vague-prompt-confirmed')).toBe(true);
  });

  it('rates a prompt with a file path and code spans specific', () => {
    const assessed = assessPrompt('Fix the `parseUser` crash in src/auth/login.ts');
    expect(assessed.rating).toBe('specific');
    expect(assessed.markers).toContain('file-path');
    expect(assessed.markers).toContain('code-span');
  });

  it('rates a very large prompt oversized and suggests splitting the session', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'do everything: '.padEnd(3500, 'x'), finalResponse: 'Done.' })]),
    );
    expect(retro.firstPrompt?.rating).toBe('oversized');
    expect(retro.tips.some((t) => t.id === 'split-multi-goal-session')).toBe(true);
  });
});

// ── Verdict and outcome ─────────────────────────────────────────────────────

describe('buildSessionRetrospective — verdict and outcome', () => {
  it('a clean answered session is smooth and likely fulfilled, with no reasons', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({
          userRequest: 'Add a `--verbose` flag to cli/main.ts',
          finalResponse: 'Added and tested.',
        }),
      ]),
    );
    expect(retro.verdict).toBe('smooth');
    expect(retro.outcome).toBe('likely-fulfilled');
    expect(retro.verdictReasons).toEqual([]);
  });

  it('one correction makes the session bumpy, not struggled', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Rename the User class to Account', finalResponse: 'Renamed.' }),
        turn({ userRequest: 'no, keep the file name as it was', finalResponse: 'Kept.' }),
      ]),
    );
    expect(retro.verdict).toBe('bumpy');
  });

  it('three corrections make the session struggled and the reasons say why', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Restyle the settings page', finalResponse: 'Done.' }),
        turn({ userRequest: 'no, use the dark palette', finalResponse: 'Done.' }),
        turn({ userRequest: 'wrong shade of gray, use the token', finalResponse: 'Done.' }),
        turn({ userRequest: "actually the spacing regressed, fix that back", finalResponse: 'Done.' }),
      ]),
    );
    expect(retro.verdict).toBe('struggled');
    expect(retro.verdictReasons).toContain('correction-reprompt');
  });

  it('an ended-on-interruption session is abandoned regardless of other signals', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'Migrate the tests', finalResponse: 'Working…' })]),
      sig({ endedWithInterruption: true, lastEvent: 'interruption' }),
    );
    expect(retro.verdict).toBe('abandoned');
    expect(retro.outcome).toBe('likely-unfulfilled');
  });

  it('an unanswered final prompt reads as abandoned from the turns alone', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Draft the schema', finalResponse: 'Drafted.' }),
        turn({ userRequest: 'now generate the migration too', llmCalls: 0 }),
      ]),
    );
    expect(retro.verdict).toBe('abandoned');
    expect(retro.findings.find((f) => f.id === 'abandoned-ending')?.severity).toBe('blocker');
  });

  it('a session that closes with a slash command ended normally, not abandoned', () => {
    // `/clear` bookkeeping passes the mapper's turn anchor, so it arrives here
    // as a turn whose "prompt" is command markup with no model call — the
    // largest false-abandonment class the calibration probe found.
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Tighten the retry logic', finalResponse: 'Done.' }),
        turn({
          userRequest: '<command-name>/clear</command-name> <command-message>clear</command-message>',
          llmCalls: 0,
        }),
      ]),
    );
    expect(retro.verdict).not.toBe('abandoned');
    // Command markup is bookkeeping, never a prompt.
    expect(retro.counts.correctionTurns).toBe(0);
  });

  it('grants very recent activity a grace period instead of calling it abandoned', () => {
    const endedAtMs = 5_000_000;
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'Run the suite', llmCalls: 0 })], {
        summary: summaryOf({ endedAtMs }),
      }),
      undefined,
      endedAtMs + 60_000,
    );
    expect(retro.verdict).not.toBe('abandoned');
  });

  it('a struggled session that still ended answered and uncorrected is partial', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'Stabilize the flaky e2e suite', finalResponse: 'Stable now.' })]),
      sig({ interruptionCount: 3 }),
    );
    expect(retro.verdict).toBe('struggled');
    expect(retro.outcome).toBe('partially');
  });
});

// ── Goal ────────────────────────────────────────────────────────────────────

describe('buildSessionRetrospective — the goal', () => {
  it('takes the goal from the session title and says where it came from', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'Fix the `auth` loop in src/login.ts', finalResponse: 'ok' })], {
        summary: summaryOf({ title: 'Fix the auth loop', titleDerived: false }),
      }),
    );
    expect(retro.goal).toBe('Fix the auth loop');
    expect(retro.goalSource).toBe('ai-title');
    expect(retro.goalConfidence).toBe('high');
  });

  it('marks a first-prompt-derived goal as such, with lower confidence', () => {
    const retro = buildSessionRetrospective(
      detailOf([turn({ userRequest: 'fix the bug', finalResponse: 'ok' })], {
        summary: summaryOf({ title: 'fix the bug', titleDerived: true }),
      }),
    );
    expect(retro.goalSource).toBe('first-prompt');
    expect(retro.goalConfidence).toBe('low');
  });

  it('says so when the session has no goal statement at all', () => {
    const retro = buildSessionRetrospective(detailOf([turn({})]));
    expect(retro.goal).toBeUndefined();
    expect(retro.goalSource).toBe('none');
  });
});

// ── Tips and the counts projection ──────────────────────────────────────────

describe('buildSessionRetrospective — tips and counts', () => {
  it('caps tips at the maximum, highest priority first, each citing evidence', () => {
    const fail = ev({ success: false });
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'fix the bug', finalResponse: 'ok', linesOfCode: 100, linesOfCodeRemoved: 60 }),
        turn({ userRequest: 'no, the other module', finalResponse: 'ok', events: [fail, fail, fail] }),
        turn({ userRequest: "that's not right, look again", finalResponse: 'ok' }),
      ]),
      sig({ endedWithInterruption: true, interruptionCount: 2, compactionCount: 2 }),
    );
    expect(retro.tips.length).toBe(MAX_TIPS);
    expect(retro.tips.map((t) => t.id)).toEqual([
      'restate-goal-after-abandon',
      'vague-prompt-confirmed',
      'capture-environment-context',
    ]);
    for (const tip of retro.tips) {
      expect(tip.evidence.length).toBeGreaterThan(0);
    }
  });

  it('evaluateAdvice over the finding ids and counts reproduces the session tips exactly', () => {
    const fail = ev({ success: false });
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'fix the bug', finalResponse: 'ok', linesOfCode: 100, linesOfCodeRemoved: 60 }),
        turn({ userRequest: 'no, the other module', finalResponse: 'ok', events: [fail, fail, fail] }),
        turn({ userRequest: "that's not right, look again", finalResponse: 'ok' }),
      ]),
      sig({ endedWithInterruption: true, interruptionCount: 2, compactionCount: 2 }),
    );
    const replayed = evaluateAdvice(new Set(retro.findings.map((f) => f.id)), retro.counts);
    expect(replayed).toEqual(retro.tips);
    expect(evaluateAdvice(new Set(), retro.counts)).toEqual([]);
  });

  it('orders findings blockers first, then friction, then info', () => {
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: 'Ship the release notes page', finalResponse: 'ok', linesOfCode: 400 }),
        turn({ userRequest: 'no, group entries by month', llmCalls: 0 }),
      ]),
      sig({ planModeUsed: false, lastEvent: 'user-request' }),
    );
    const severities = retro.findings.map((f) => f.severity);
    const firstFriction = severities.indexOf('friction');
    const firstInfo = severities.indexOf('info');
    expect(severities[0]).toBe('blocker');
    expect(firstInfo).toBeGreaterThan(firstFriction);
  });

  it('keeps every string of user content out of the counts projection', () => {
    const marker = 'SECRET_PROMPT_MARKER_XYZZY';
    const retro = buildSessionRetrospective(
      detailOf([
        turn({ userRequest: `Fix the ${marker} handler`, finalResponse: `${marker} fixed` }),
        turn({ userRequest: `no, the other ${marker} path`, finalResponse: 'ok' }),
      ]),
    );
    expect(JSON.stringify(retro.counts)).not.toContain(marker);
    // Finding descriptions and tips are generic sentences by contract.
    expect(JSON.stringify(retro.findings)).not.toContain(marker);
    expect(JSON.stringify(retro.tips)).not.toContain(marker);
  });
});
