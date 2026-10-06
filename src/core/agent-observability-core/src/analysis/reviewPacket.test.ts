import { describe, expect, it } from 'vitest';
import type { SessionDetail, SessionTurn } from '../telemetry/models';
import type { CompletionCheck } from './completionCheck';
import type { SessionRetrospective } from './retrospective';
import {
  PACKET_MAX_CHARS,
  PACKET_MAX_TURNS,
  buildReviewPacket,
  formatDurationMs,
  formatTokenCount,
  renderReviewPacketMarkdown,
  type ReviewPacketInput,
} from './reviewPacket';
import { emptyActivity, type ActivityCommand, type RepoPathFn, type SessionActivity } from './sessionActivity';

/**
 * Fixtures use literal strings and an injected path function, so nothing here
 * depends on the machine's separators, locale or clock.
 */

const ROOT = '/abs/checkout/repo/';
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const toRepoPath: RepoPathFn = (recorded) =>
  recorded.startsWith(ROOT)
    ? { path: recorded.slice(ROOT.length), insideRepo: true }
    : { path: recorded.slice(recorded.lastIndexOf('/') + 1), insideRepo: false };

function turn(over: Partial<SessionTurn> = {}): SessionTurn {
  return {
    timestampMs: 0,
    agentMode: 'agent',
    model: 'model-a',
    durationMs: 60_000,
    success: true,
    llmCalls: 1,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    events: [],
    ...over,
  };
}

function detail(turns: SessionTurn[], over: Partial<SessionDetail['summary']> = {}): SessionDetail {
  return {
    summary: {
      sessionId: 'sess-1',
      repository: 'https://github.com/o/repo',
      durationMs: 65 * 60_000,
      costMicros: 1_234_000,
      source: 'claude',
      ...over,
    },
    treeStats: { inputTokens: 12_300, outputTokens: 700, cachedTokens: 0 },
    turns,
    modelUsage: [{ model: 'model-a', inputTokens: 12_300, outputTokens: 700 }],
    agentUsage: [
      { agentName: 'main', kind: 'main', inputTokens: 600, outputTokens: 100 },
      { agentName: 'Explore', kind: 'subagent', inputTokens: 250, outputTokens: 50 },
    ],
    treeModelTurns: [],
  } as unknown as SessionDetail;
}

function retro(over: Partial<SessionRetrospective> = {}): SessionRetrospective {
  return {
    sessionId: 'sess-1',
    goal: 'Fix the flaky login test',
    goalSource: 'ai-title',
    goalConfidence: 'high',
    verdict: 'bumpy',
    verdictReasons: [],
    outcome: 'partially',
    findings: [],
    tips: [],
    counts: {},
    contentDerived: true,
    ...over,
  } as unknown as SessionRetrospective;
}

function command(over: Partial<ActivityCommand>): ActivityCommand {
  return {
    order: 0,
    turnIndex: 0,
    class: 'other',
    failed: false,
    resultKnown: true,
    resultMasked: false,
    background: false,
    sideChain: false,
    text: 'echo hi',
    ...over,
  };
}

function activity(over: Partial<SessionActivity> = {}): SessionActivity {
  return { ...emptyActivity(true), ...over };
}

function input(over: Partial<ReviewPacketInput> = {}): ReviewPacketInput {
  return {
    detail: detail([
      turn({ userRequest: 'Please fix the SECRET-PROMPT-ALPHA login test in src/login.test.ts' }),
      turn({ userRequest: 'No, SECRET-PROMPT-BETA, keep the old helper', success: false }),
    ]),
    retrospective: retro(),
    activity: activity({
      edits: [
        { order: 1, turnIndex: 0, path: `${ROOT}src/login.ts`, linesAdded: 10, linesRemoved: 2, created: false, tool: 'Edit' },
        { order: 2, turnIndex: 1, path: `${ROOT}src/login.ts`, linesAdded: 3, linesRemoved: 3, created: false, tool: 'Edit' },
        { order: 3, turnIndex: 1, path: `${ROOT}.github/workflows/ci.yml`, linesAdded: 1, linesRemoved: 0, created: false, tool: 'Edit' },
        { order: 4, turnIndex: 1, path: '/tmp/elsewhere/notes.txt', linesAdded: 1, linesRemoved: 0, created: true, tool: 'Write' },
      ],
      commands: [
        command({ order: 5, turnIndex: 1, class: 'test', failed: true, text: 'npm test' }),
        command({ order: 6, turnIndex: 1, class: 'filesystem', text: `rm -rf build && export GH=${TOKEN}` }),
        command({ order: 7, turnIndex: 1, class: 'network', text: 'curl -H "Authorization: Bearer abcdef0123456789abcdef" https://example.test' }),
      ],
      permissionModes: ['bypassPermissions'],
      subAgents: [{ name: 'Explore', calls: 2 }],
    }),
    repository: 'https://github.com/o/repo',
    title: 'Fix the flaky login test',
    toRepoPath,
    costMode: 'usd',
    ...over,
  };
}

describe('buildReviewPacket', () => {
  it('rolls up files repository-relative with re-edit counts and marks outside files', () => {
    const packet = buildReviewPacket(input());
    const login = packet.files.find((f) => f.path === 'src/login.ts');
    expect(login).toMatchObject({ edits: 2, reEdits: 1, linesAdded: 13, linesRemoved: 5, insideRepo: true });
    expect(packet.files.find((f) => f.path === 'notes.txt')?.insideRepo).toBe(false);
    expect(packet.filesAvailable).toBe(true);
    expect(packet.commands).toEqual([
      { class: 'test', runs: 1, failures: 1 },
      { class: 'network', runs: 1, failures: 0 },
      { class: 'filesystem', runs: 1, failures: 0 },
    ]);
    expect(packet.turns.map((t) => t.outcome)).toEqual(['ok', 'failed']);
    expect(packet.subAgents).toEqual([{ name: 'Explore', calls: 2, tokenSharePct: 30 }]);
  });

  it('finds risky actions from commands, paths and permission modes', () => {
    const ids = buildReviewPacket(input()).risks.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['rm-rf', 'network-call', 'permission-bypass', 'ci-change', 'write-outside-repo']));
  });

  it('never lets a planted token or authorization header through, and counts the replacements', () => {
    const packet = buildReviewPacket(input());
    const markdown = renderReviewPacketMarkdown([packet], { includePrompts: true });
    expect(JSON.stringify(packet)).not.toContain(TOKEN);
    expect(markdown).not.toContain(TOKEN);
    expect(markdown).not.toContain('abcdef0123456789abcdef');
    expect(packet.redactions).toBeGreaterThanOrEqual(2);
    expect(markdown).toContain('secret-looking');
  });

  it('marks corrected and interrupted requests from the retrospective findings, and lists dead ends', () => {
    const packet = buildReviewPacket(
      input({
        retrospective: retro({
          findings: [
            { id: 'correction-reprompt', severity: 'friction', description: 'A follow-up read as a correction.', turnIndex: 1, contentDerived: true },
            { id: 'vague-first-prompt', severity: 'info', description: 'The opening prompt was short.', contentDerived: true },
          ],
          tips: [{ id: 't', text: 'State the end state up front.', evidence: [] }],
        } as unknown as Partial<SessionRetrospective>),
      }),
    );
    expect(packet.turns[0].outcome).toBe('corrected');
    expect(packet.deadEnds).toEqual([{ turnIndex: 1, kind: 'correction', note: 'A follow-up read as a correction.' }]);
    expect(packet.findings).toHaveLength(2);
    expect(packet.tips).toEqual(['State the end state up front.']);
  });

  it('caps the request list and reports how many were left out', () => {
    const many = Array.from({ length: PACKET_MAX_TURNS + 10 }, (_, i) => turn({ userRequest: `request number ${i}` }));
    const packet = buildReviewPacket(input({ detail: detail(many) }));
    expect(packet.turns).toHaveLength(PACKET_MAX_TURNS);
    expect(packet.turnsOmitted).toBe(10);
    expect(renderReviewPacketMarkdown([packet], { includePrompts: true })).toContain('- and 10 more');
  });
});

describe('renderReviewPacketMarkdown', () => {
  it('emits no absolute path for a fixture built from absolute paths', () => {
    const markdown = renderReviewPacketMarkdown([buildReviewPacket(input())], { includePrompts: true });
    expect(markdown).toContain('src/login.ts');
    expect(markdown).toContain('notes.txt (outside the repository)');
    expect(markdown).not.toContain('/abs/checkout');
    expect(markdown).not.toContain('/tmp/elsewhere');
    expect(markdown).toContain('re-edited 1 time');
    expect(markdown).toContain('est. cost $1.23');
    expect(markdown).toContain('1 h 5 min');
  });

  it('drops every line of prompt text in the no-prompt variant', () => {
    const packet = buildReviewPacket(
      input({ retrospective: retro({ goal: 'SECRET-PROMPT-GOAL do the thing', goalSource: 'first-prompt' }) }),
    );
    const withPrompts = renderReviewPacketMarkdown([packet], { includePrompts: true });
    const without = renderReviewPacketMarkdown([packet], { includePrompts: false });
    expect(withPrompts).toContain('SECRET-PROMPT-ALPHA');
    expect(withPrompts).toContain('SECRET-PROMPT-GOAL');
    for (const text of ['SECRET-PROMPT-ALPHA', 'SECRET-PROMPT-BETA', 'SECRET-PROMPT-GOAL', 'rm -rf build', 'curl -H']) {
      expect(without).not.toContain(text);
    }
    expect(without).toContain('prompt text not included');
    expect(without).toContain('Recursive forced delete');
    expect(without).toContain('src/login.ts');
  });

  it('says in one line when the source has no file or command detail', () => {
    const packet = buildReviewPacket(input({ activity: emptyActivity(false) }));
    expect(packet.filesAvailable).toBe(false);
    expect(renderReviewPacketMarkdown([packet], { includePrompts: true })).toContain(
      'File and command detail is not available for this source.',
    );
  });

  it('falls back to command counts without a completion check, and lists its sentences with one', () => {
    const absent = renderReviewPacketMarkdown([buildReviewPacket(input())], { includePrompts: true });
    expect(absent).toContain('Not checked by the completion check');
    expect(absent).toContain('the last one failed');

    const completion: CompletionCheck = {
      status: 'unverified',
      claim: 'done',
      checks: [
        { id: 'verification-after-last-edit', passed: false, detail: 'No check was observed after the last code edit.' },
        { id: 'clean-ending', passed: true, detail: 'The session did not end on a failed step.' },
      ],
    };
    const packet = buildReviewPacket(input({ completion }));
    const present = renderReviewPacketMarkdown([packet], { includePrompts: true });
    expect(packet.verification.status).toBe('unverified');
    expect(present).toContain('Status: not verified');
    expect(present).toContain('Not observed: No check was observed after the last code edit.');
    expect(present).toContain('Observed: The session did not end on a failed step.');
  });

  it('renders several sessions under one header with combined totals', () => {
    const a = buildReviewPacket(input());
    const b = buildReviewPacket(input({ detail: detail([turn({ userRequest: 'second session' })], { sessionId: 'sess-2', costMicros: undefined }) }));
    const markdown = renderReviewPacketMarkdown([a, b], { includePrompts: true });
    expect(markdown).toContain('# Review packet: 2 sessions');
    expect(markdown).toContain('2 sessions, 3 requests, 26k tokens, est. cost $1.23 (1 of 2 priced)');
    expect(markdown).toContain('## Session 1: Fix the flaky login test');
    expect(markdown).toContain('## Session 2: Fix the flaky login test');
    expect(markdown).toContain('### Files changed');
  });

  it('stays under the size cap by trimming lists in order', () => {
    const long = 'x'.repeat(130);
    const many = Array.from({ length: PACKET_MAX_TURNS }, (_, i) => turn({ userRequest: `${i} ${long}` }));
    const edits = Array.from({ length: 30 }, (_, i) => ({
      order: i,
      turnIndex: 0,
      path: `${ROOT}src/${'deep/'.repeat(20)}file-${i}.ts`,
      linesAdded: 1,
      linesRemoved: 0,
      created: false,
      tool: 'Edit',
    }));
    const packet = buildReviewPacket(input({ detail: detail(many), activity: activity({ edits }) }));
    const markdown = renderReviewPacketMarkdown(Array.from({ length: 12 }, () => packet), { includePrompts: true });
    expect(markdown.length).toBeLessThanOrEqual(60_000);
    expect(markdown).toContain('more');
    expect(renderReviewPacketMarkdown([packet], { includePrompts: true }).length).toBeLessThanOrEqual(PACKET_MAX_CHARS);
    expect(renderReviewPacketMarkdown([], { includePrompts: true })).toBe('');
  });
});

describe('hand formatting', () => {
  it('formats token counts and durations the same on every machine', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_300)).toBe('12.3k');
    expect(formatTokenCount(2_000)).toBe('2k');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatDurationMs(10_000)).toBe('under a minute');
    expect(formatDurationMs(12 * 60_000)).toBe('12 min');
    expect(formatDurationMs(120 * 60_000)).toBe('2 h');
  });
});
