import { describe, expect, it } from 'vitest';
import type { SessionDetail, SessionTurn } from '../../telemetry/models';
import type { SessionRetrospective } from '../../analysis/retrospective';
import {
  DEEP_RETRO_PROMPT_CHARS,
  buildDeepRetrospectivePrompt,
  parseDeepRetrospective,
} from './deepRetrospective';

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

function detailOf(turns: SessionTurn[]): SessionDetail {
  return {
    summary: {
      sessionId: 's1',
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
    },
    treeStats: {
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
    },
    turns,
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  };
}

const heuristic: SessionRetrospective = {
  sessionId: 's1',
  goal: 'Fix the login bug',
  goalSource: 'ai-title',
  goalConfidence: 'medium',
  verdict: 'bumpy',
  verdictReasons: ['correction-reprompt'],
  outcome: 'unclear',
  findings: [
    {
      id: 'correction-reprompt',
      severity: 'friction',
      description: 'The follow-up prompt reads as a correction.',
      turnIndex: 1,
      contentDerived: true,
    },
  ],
  tips: [],
  counts: {
    verdict: 'bumpy',
    outcome: 'unclear',
    correctionTurns: 1,
    repeatedPromptTurns: 0,
    interruptions: 0,
    errorStreaks: 0,
    maxErrorStreak: 0,
    longTailTurns: 0,
    compactions: 0,
    churnRatioPct: 0,
    planModeUsed: false,
    tipCount: 0,
  },
  contentDerived: true,
};

describe('buildDeepRetrospectivePrompt', () => {
  it('grounds the judge in the goal, the heuristic verdict, and the transcript', () => {
    const prompt = buildDeepRetrospectivePrompt(
      detailOf([
        turn({ userRequest: 'Fix the login bug', finalResponse: 'Fixed in auth.ts.' }),
        turn({ userRequest: 'no, the OAuth path', finalResponse: 'Fixed there too.' }),
      ]),
      heuristic,
    );
    expect(prompt).toContain('Stated goal: Fix the login bug');
    expect(prompt).toContain('judged this session "bumpy"');
    expect(prompt).toContain('correction-reprompt (turn 2)');
    expect(prompt).toContain('Developer asked: Fix the login bug');
    expect(prompt).toContain('Assistant finished: Fixed in auth.ts.');
    expect(prompt).toContain('```ao-retro');
  });

  it('caps a huge prompt instead of shipping the whole thing', () => {
    const prompt = buildDeepRetrospectivePrompt(
      detailOf([turn({ userRequest: 'x'.repeat(10_000) })]),
      heuristic,
    );
    const asked = prompt.split('Developer asked: ')[1].split('\n')[0];
    expect(asked.length).toBeLessThanOrEqual(DEEP_RETRO_PROMPT_CHARS);
  });

  it('describes an interruption instead of quoting its marker text', () => {
    const prompt = buildDeepRetrospectivePrompt(
      detailOf([
        turn({ userRequest: 'Start the migration' }),
        turn({ userRequest: '[Request interrupted by user]' }),
      ]),
      heuristic,
    );
    expect(prompt).toContain('The developer interrupted the agent here.');
  });

  it('summarizes tools by name and failure count, never their output', () => {
    const prompt = buildDeepRetrospectivePrompt(
      detailOf([
        turn({
          userRequest: 'Run the checks',
          events: [
            { timestampMs: 0, operation: 'execute_tool', agentMode: 'agent', model: 'm', toolName: 'Bash', durationMs: 0, success: true },
            { timestampMs: 0, operation: 'execute_tool', agentMode: 'agent', model: 'm', toolName: 'Bash', durationMs: 0, success: false },
          ],
        }),
      ]),
      heuristic,
    );
    expect(prompt).toContain('Bash ×1, failed ×1');
  });
});

describe('parseDeepRetrospective', () => {
  it('parses a well-formed fenced verdict', () => {
    const reply = [
      'Here you go:',
      '```ao-retro',
      JSON.stringify({
        goal: 'Fix the login bug',
        outcome: 'likely-fulfilled',
        narrative: 'Went fine after one correction.',
        promptCritique: 'Name the file next time.',
        advice: ['a', 'b', 'c', 'd'],
      }),
      '```',
    ].join('\n');
    const verdict = parseDeepRetrospective(reply, 'sonnet', 42);
    expect(verdict?.outcome).toBe('likely-fulfilled');
    expect(verdict?.narrative).toBe('Went fine after one correction.');
    expect(verdict?.advice).toEqual(['a', 'b', 'c']);
    expect(verdict?.model).toBe('sonnet');
    expect(verdict?.generatedAtMs).toBe(42);
  });

  it('drops an outcome label it does not recognize rather than passing it on', () => {
    const reply = '```ao-retro\n{"outcome": "triumphant", "narrative": "ok"}\n```';
    expect(parseDeepRetrospective(reply, 'm', 0)?.outcome).toBeUndefined();
  });

  it('returns nothing for a reply without a fence, or with broken JSON', () => {
    expect(parseDeepRetrospective('The session went well.', 'm', 0)).toBeUndefined();
    expect(parseDeepRetrospective('```ao-retro\n{not json\n```', 'm', 0)).toBeUndefined();
  });

  it('treats a verdict that says nothing as no verdict', () => {
    expect(parseDeepRetrospective('```ao-retro\n{"goal": "x"}\n```', 'm', 0)).toBeUndefined();
  });
});
