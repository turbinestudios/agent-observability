import { describe, expect, it } from 'vitest';
import type { SessionDetail, SessionTurn } from '../telemetry/models';
import type { CompletionCheck } from './completionCheck';
import {
  HANDOFF_MAX_CHARS,
  HANDOFF_MAX_CONSTRAINTS,
  HANDOFF_MAX_OPEN_ITEMS,
  buildHandoffBrief,
  deriveEnding,
  extractConstraints,
  extractOpenItems,
  renderHandoffBriefMarkdown,
  type HandoffBriefInput,
} from './handoffBrief';
import type { SessionRetrospective } from './retrospective';
import { emptyActivity, type ActivityCommand, type RepoPathFn, type SessionActivity } from './sessionActivity';

const ROOT = '/abs/checkout/repo/';
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const toRepoPath: RepoPathFn = (recorded) =>
  recorded.startsWith(ROOT)
    ? { path: recorded.slice(ROOT.length), insideRepo: true }
    : { path: recorded.slice(recorded.lastIndexOf('/') + 1), insideRepo: false };

function turn(over: Partial<SessionTurn> = {}): SessionTurn {
  return { success: true, events: [], ...over } as unknown as SessionTurn;
}

function detail(turns: SessionTurn[]): SessionDetail {
  return {
    summary: { sessionId: 'sess-1', repository: 'https://github.com/o/repo', source: 'claude', costMicros: 9_990_000 },
    treeStats: { inputTokens: 123_456, outputTokens: 7_890, cachedTokens: 0 },
    turns,
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  } as unknown as SessionDetail;
}

function retro(over: Partial<SessionRetrospective> = {}): SessionRetrospective {
  return {
    sessionId: 'sess-1',
    goal: 'Migrate the settings page to the new form library',
    goalSource: 'ai-title',
    verdict: 'struggled',
    outcome: 'partially',
    findings: [],
    tips: [{ id: 't', text: 'TIP-TEXT should not appear', evidence: [] }],
    counts: {},
    contentDerived: true,
    ...over,
  } as unknown as SessionRetrospective;
}

function command(over: Partial<ActivityCommand>): ActivityCommand {
  return {
    order: 0,
    turnIndex: 0,
    class: 'test',
    failed: false,
    resultKnown: true,
    resultMasked: false,
    background: false,
    sideChain: false,
    text: 'npm test',
    ...over,
  };
}

function activity(over: Partial<SessionActivity> = {}): SessionActivity {
  return { ...emptyActivity(true), ...over };
}

function edit(turnIndex: number, file: string, order = turnIndex): SessionActivity['edits'][number] {
  return { order, turnIndex, path: file, linesAdded: 1, linesRemoved: 0, created: false, tool: 'Edit' };
}

function input(over: Partial<HandoffBriefInput> = {}): HandoffBriefInput {
  return {
    detail: detail([
      turn({ userRequest: 'Migrate the settings page. You must keep the old validation rules.', finalResponse: 'Started.' }),
      turn({
        userRequest: `Never touch the billing module. My key is ${TOKEN}.`,
        finalResponse: 'Done with the form.\n- TODO: wire the save button\nNext steps: add tests for the date field\nAll good otherwise.',
      }),
    ]),
    retrospective: retro(),
    activity: activity({
      edits: [
        edit(0, `${ROOT}src/settings/form.tsx`),
        edit(1, `${ROOT}src/settings/form.tsx`, 2),
        edit(1, `${ROOT}src/settings/date.ts`, 3),
        edit(0, '/tmp/scratch/out.txt', 1),
      ],
      commands: [command({ order: 4, turnIndex: 1, failed: true })],
    }),
    contextFiles: ['AGENTS.md', '.claude/rules/style.md'],
    repository: 'https://github.com/o/repo',
    toRepoPath,
    ...over,
  };
}

describe('deriveEnding', () => {
  const base = { detail: detail([turn({ finalResponse: 'ok' })]), retrospective: retro() };

  it('prefers the live board when it knows how the session ended', () => {
    expect(deriveEnding({ ...base, liveLastEvent: 'tool-pending' })).toBe('tool-pending');
    expect(deriveEnding({ ...base, liveLastEvent: 'interruption' })).toBe('interrupted');
    expect(deriveEnding({ ...base, liveLastEvent: 'assistant-text' })).toBe('waiting');
    expect(deriveEnding({ ...base, liveLastEvent: 'turn-ended' })).toBe('turn-complete');
    expect(deriveEnding({ ...base, liveLastEvent: 'tool-result', lastToolFailed: true })).toBe('error');
  });

  it('falls back to the transcript shape', () => {
    expect(deriveEnding(base)).toBe('turn-complete');
    expect(deriveEnding({ ...base, liveLastEvent: 'unknown' })).toBe('turn-complete');
    expect(deriveEnding({ ...base, detail: detail([turn({ success: false, finalResponse: 'x' })]) })).toBe('error');
    expect(deriveEnding({ ...base, lastToolFailed: true })).toBe('error');
    expect(deriveEnding({ ...base, detail: detail([turn({})]) })).toBe('unknown');
    expect(deriveEnding({ ...base, detail: detail([]) })).toBe('unknown');
    expect(
      deriveEnding({
        ...base,
        retrospective: retro({
          findings: [{ id: 'user-interruption', severity: 'friction', description: 'd', turnIndex: 0, contentDerived: false }],
        } as unknown as Partial<SessionRetrospective>),
      }),
    ).toBe('interrupted');
  });
});

describe('extractConstraints', () => {
  it('quotes constraint sentences with their request number and marks corrections', () => {
    const constraints = extractConstraints([
      turn({ userRequest: 'Add a login page. You must not change the API. Thanks!' }),
      turn({ userRequest: 'No, that is wrong. Keep the old helper instead of writing a new one.' }),
      turn({ userRequest: 'Looks fine, continue.' }),
    ]);
    expect(constraints).toEqual([
      { turnIndex: 0, text: 'You must not change the API.', kind: 'constraint' },
      { turnIndex: 1, text: 'No, that is wrong.', kind: 'correction' },
      { turnIndex: 1, text: 'Keep the old helper instead of writing a new one.', kind: 'constraint' },
    ]);
  });

  it('de-duplicates keeping the newest statement, and keeps only the newest few', () => {
    const repeated = extractConstraints([
      turn({ userRequest: 'Never use any.' }),
      turn({ userRequest: 'Please continue.\nNever use any.' }),
    ]);
    expect(repeated).toEqual([{ turnIndex: 1, text: 'Never use any.', kind: 'constraint' }]);

    const many = extractConstraints(
      Array.from({ length: HANDOFF_MAX_CONSTRAINTS + 4 }, (_, i) => turn({ userRequest: `Always run check number ${i}.` })),
    );
    expect(many).toHaveLength(HANDOFF_MAX_CONSTRAINTS);
    expect(many[many.length - 1].turnIndex).toBe(HANDOFF_MAX_CONSTRAINTS + 3);
    expect(many[0].turnIndex).toBe(4);
  });

  it('redacts secrets inside a quoted constraint', () => {
    const [only] = extractConstraints([turn({ userRequest: `Never commit ${TOKEN} to the repo.` })]);
    expect(only.text).not.toContain(TOKEN);
    expect(only.text).toContain('Never commit');
  });
});

describe('extractOpenItems', () => {
  it('picks marker lines from the last reply, stripped of bullets and capped', () => {
    expect(
      extractOpenItems('All done.\n- [ ] update the docs\n* TODO: wire the save button\n2) Next step: add tests\nNothing else.'),
    ).toEqual(['update the docs', 'TODO: wire the save button', 'Next step: add tests']);
    expect(extractOpenItems(undefined)).toEqual([]);
    const lots = Array.from({ length: 20 }, (_, i) => `- remaining item ${i}`).join('\n');
    expect(extractOpenItems(lots)).toHaveLength(HANDOFF_MAX_OPEN_ITEMS);
  });
});

describe('buildHandoffBrief and renderHandoffBriefMarkdown', () => {
  it('orders files by last touch, reports state, open items and what was not verified', () => {
    const brief = buildHandoffBrief(input());
    expect(brief.files.map((f) => f.path)).toEqual(['src/settings/form.tsx', 'src/settings/date.ts', 'out.txt']);
    expect(brief.files[0]).toMatchObject({ edits: 2, lastTurn: 1, insideRepo: true });
    expect(brief.state).toMatchObject({ turns: 2, ending: 'turn-complete', lastTurnFailed: false, filesChanged: 3 });
    expect(brief.openItems[0]).toEqual({ text: 'The last test run failed.', origin: 'failed-command' });
    expect(brief.openItems.filter((o) => o.origin === 'last-reply').map((o) => o.text)).toEqual([
      'TODO: wire the save button',
      'Next steps: add tests for the date field',
    ]);
    expect(brief.verified).toEqual([]);
    expect(brief.notVerified).toHaveLength(1);
    expect(brief.contextFiles).toEqual(['AGENTS.md', '.claude/rules/style.md']);
    expect(brief.redactions).toBeGreaterThanOrEqual(1);
  });

  it('uses the completion check sentences when one is available', () => {
    const completion: CompletionCheck = {
      status: 'verified',
      claim: 'done',
      checks: [
        { id: 'verification-after-last-edit', passed: true, detail: 'A check ran after the last code edit.' },
        { id: 'edits-read-back', passed: false, detail: 'Some edited files were not read back.' },
      ],
    };
    const brief = buildHandoffBrief(input({ completion }));
    expect(brief.verified).toEqual(['A check ran after the last code edit.']);
    expect(brief.notVerified).toEqual(['Some edited files were not read back.']);
  });

  it('adds an interrupted open item and reports a passing last check when there is no completion check', () => {
    const brief = buildHandoffBrief(
      input({ liveLastEvent: 'interruption', activity: activity({ commands: [command({ turnIndex: 1 })] }) }),
    );
    expect(brief.state.ending).toBe('interrupted');
    expect(brief.openItems.some((o) => o.origin === 'interrupted')).toBe(true);
    expect(brief.verified).toEqual(['The last test run was observed to pass (request 2).']);
  });

  it('writes to the next agent with no absolute path, secret, cost, token figure, verdict or tips', () => {
    const markdown = renderHandoffBriefMarkdown(buildHandoffBrief(input()));
    for (const heading of [
      '## Goal',
      '## Where things stand',
      '## Constraints I was given',
      '## Files in play',
      '## Verified and not verified',
      '## Open items',
      '## Context files loaded',
      '## Suggested first prompt',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('"You must keep the old validation rules." (request 1)');
    expect(markdown).toContain('(from the last reply)');
    expect(markdown).toContain('out.txt (outside the repository)');
    for (const banned of ['/abs/checkout', '/tmp/scratch', TOKEN, '$9.99', '123,456', '123456', '7890', 'struggled', 'TIP-TEXT']) {
      expect(markdown).not.toContain(banned);
    }
  });

  it('suggests a first prompt naming the top files and the first open item', () => {
    const brief = buildHandoffBrief(input());
    expect(brief.suggestedPrompt).toContain('Continue this work: Migrate the settings page to the new form library');
    expect(brief.suggestedPrompt).toContain('Read src/settings/form.tsx, src/settings/date.ts, out.txt first.');
    expect(brief.suggestedPrompt).toContain('Start with this open item: The last test run failed.');
    expect(brief.suggestedPrompt).toContain('Respect the constraints listed above.');
    expect(brief.suggestedPrompt).toContain('Nothing is verified yet');
  });

  it('stays under the total cap by trimming files, then constraints', () => {
    const deep = 'very-long-directory-name/'.repeat(12);
    const edits = Array.from({ length: 20 }, (_, i) => edit(0, `${ROOT}${deep}file-${i}.ts`, i));
    const turns = Array.from({ length: 8 }, (_, i) =>
      turn({ userRequest: `Always ${'respect this rule and '.repeat(15)}number ${i}.`, finalResponse: 'ok' }),
    );
    const brief = buildHandoffBrief(input({ detail: detail(turns), activity: activity({ edits }) }));
    const markdown = renderHandoffBriefMarkdown(brief);
    expect(markdown.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expect(markdown).toContain('more');
    expect(markdown).toContain('## Suggested first prompt');
  });
});
