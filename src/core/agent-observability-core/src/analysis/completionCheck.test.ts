import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  DETAIL_TEXT,
  classifyClosingText,
  completionCounts,
  decideCompletion,
  evidenceFromActivity,
  extensionOf,
  isReportedDoneUnverified,
  type CompletionEvidence,
} from './completionCheck';
import { classifyCommand, emptyActivity, type ActivityCommand, type ActivityFileEdit, type SessionActivity } from './sessionActivity';

const CODE = ['.ts', '.py'];
const DOCS = ['.md', '.txt'];
const OPTS = { codeExtensions: CODE, docExtensions: DOCS };

const SECRET_COMMAND = 'npm test -- --token=SUPERSECRETVALUE';
const SECRET_PATH = path.join('C:', 'Users', 'someone', 'private-project', 'billing.ts');
const SECRET_MESSAGE = 'All done, the Zebra invoice module has been implemented.';

function command(text: string, order: number, over: Partial<ActivityCommand> = {}): ActivityCommand {
  const classified = classifyCommand(text);
  return {
    order,
    turnIndex: 0,
    class: classified.class,
    failed: false,
    resultKnown: true,
    resultMasked: classified.resultMasked,
    background: false,
    sideChain: false,
    text,
    ...over,
  };
}

function edit(file: string, order: number, turnIndex = 0): ActivityFileEdit {
  return { order, turnIndex, path: file, linesAdded: 3, linesRemoved: 1, created: false, tool: 'Edit' };
}

function activity(over: Partial<SessionActivity>): SessionActivity {
  return { ...emptyActivity(true), ...over };
}

function decide(over: Partial<SessionActivity>): ReturnType<typeof decideCompletion> {
  return decideCompletion(evidenceFromActivity(activity(over), OPTS));
}

describe('classifyClosingText', () => {
  it('reads completion claims', () => {
    for (const text of [
      'All tests pass and the feature is now complete.',
      'I have implemented the parser.',
      "I've fixed the bug.",
      'The endpoint has been added.',
      'Done.',
      'Successfully implemented the cache.',
    ]) {
      expect(classifyClosingText(text).claim, text).toBe('done');
    }
  });

  it('lets an admission of unfinished work win over a completion claim', () => {
    for (const text of [
      'Done, but I could not get the integration test to pass.',
      'Implemented. Remaining: wire the settings page.',
      'The fix has been applied; two tests are still failing.',
      'Finished the refactor. TODO: update the docs.',
      'I was unable to reproduce the issue.',
    ]) {
      expect(classifyClosingText(text).claim, text).toBe('partial');
    }
    expect(classifyClosingText('Everything is done; there are no remaining issues.').claim).toBe('done');
  });

  it('notices when the text says checks were not run', () => {
    expect(classifyClosingText('I did not run the tests.')).toEqual({ claim: 'partial', admitsSkippedChecks: true });
    expect(classifyClosingText('Implemented without running the build.').admitsSkippedChecks).toBe(true);
    expect(classifyClosingText('All tests pass.').admitsSkippedChecks).toBe(false);
  });

  it('reads nothing into neutral or missing text', () => {
    expect(classifyClosingText('Here is what the function does.')).toEqual({ claim: 'none', admitsSkippedChecks: false });
    expect(classifyClosingText(undefined).claim).toBe('none');
    expect(classifyClosingText('   ').claim).toBe('none');
  });
});

describe('evidenceFromActivity', () => {
  it('separates code edits from documentation edits by extension', () => {
    const e = evidenceFromActivity(
      activity({ edits: [edit('a.ts', 0), edit('README.md', 1), edit('Dockerfile', 2), edit('a.ts', 3)] }),
      OPTS,
    );
    expect(e.codeEditCalls).toBe(3);
    expect(e.docEditCalls).toBe(1);
    expect(e.filesEdited).toBe(2);
    expect(extensionOf(path.join('x', '.env'))).toBe('');
    expect(extensionOf(path.join('x', 'A.TS'))).toBe('.ts');
  });

  it('orders checks against the last code edit inside one turn', () => {
    const before = evidenceFromActivity(activity({ commands: [command('npm test', 0)], edits: [edit('a.ts', 1)] }), OPTS);
    expect(before.verifiedAfterLastEdit).toBe(false);
    const after = evidenceFromActivity(activity({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1)] }), OPTS);
    expect(after).toMatchObject({ verifiedAfterLastEdit: true, lastVerifyClass: 'test', lastVerifyResultKnown: true });
    // A documentation edit after the check does not un-verify the code.
    const docsLater = evidenceFromActivity(
      activity({ edits: [edit('a.ts', 0), edit('NOTES.md', 2)], commands: [command('npm test', 1)] }),
      OPTS,
    );
    expect(docsLater.verifiedAfterLastEdit).toBe(true);
  });

  it('counts failures and unobservable results separately', () => {
    const e = evidenceFromActivity(
      activity({
        edits: [edit('a.ts', 0)],
        commands: [
          command('npm test', 1, { failed: true }),
          command('npm test | tail -5', 2, { failed: false }),
          command('npm run build', 3, { background: true }),
          command('npx eslint .', 4, { resultKnown: false }),
          command('git status', 5),
        ],
      }),
      OPTS,
    );
    expect(e).toMatchObject({ verifyRuns: 4, verifyFailures: 1, verifyUnknownResult: 3, lastVerifyClass: 'lint' });
    expect(e.lastVerifyResultKnown).toBe(false);
  });

  it('counts files outside the repository and files never read back', () => {
    const e = evidenceFromActivity(
      activity({
        edits: [edit('in.ts', 0), edit('out.ts', 1)],
        reads: [{ order: 2, turnIndex: 0, path: 'in.ts' }],
      }),
      { ...OPTS, isInsideRepo: (p) => p === 'in.ts' },
    );
    expect(e.filesOutsideRepo).toBe(1);
    expect(e.filesNeverReadBack).toBe(1);
  });
});

describe('decideCompletion', () => {
  it('is not applicable without code edits, and says why', () => {
    expect(decide({ commands: [command('npm test', 0)] })).toMatchObject({ status: 'not-applicable', naReason: 'no-edits', checks: [] });
    expect(decide({ edits: [edit('README.md', 0)] })).toMatchObject({ status: 'not-applicable', naReason: 'docs-only' });
  });

  it('is not applicable when the source cannot see commands', () => {
    const check = decideCompletion(evidenceFromActivity(emptyActivity(false), OPTS));
    expect(check).toMatchObject({ status: 'not-applicable', naReason: 'source-lacks-evidence' });
  });

  it('is verified when a check observably passed after the last edit', () => {
    const check = decide({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1)], closingText: 'All tests pass.' });
    expect(check.status).toBe('verified');
    expect(check.checks.find((c) => c.id === 'verification-after-last-edit')?.passed).toBe(true);
    expect(check.checks.find((c) => c.id === 'last-verification-passed')?.passed).toBe(true);
    expect(isReportedDoneUnverified(check)).toBe(false);
  });

  it('is unverified when nothing was checked after the last edit', () => {
    const check = decide({ commands: [command('npm test', 0)], edits: [edit('a.ts', 1, 4)], closingText: 'Done.' });
    expect(check.status).toBe('unverified');
    expect(check.checks[0]).toMatchObject({ id: 'verification-after-last-edit', passed: false, evidenceTurnIndex: 4 });
    expect(check.checks.some((c) => c.id === 'last-verification-passed')).toBe(false);
    expect(isReportedDoneUnverified(check)).toBe(true);
  });

  it('treats a masked or background run as ran, with a result that was not observed', () => {
    for (const run of [
      command('npm test | tail -20', 1),
      command('npm test || true', 1, { failed: false }),
      command('npm test', 1, { background: true }),
      command('npm test', 1, { resultKnown: false }),
      // Even a reported error is not the check's own verdict when it was masked.
      command('npm test | grep -c ok', 1, { failed: true }),
    ]) {
      const check = decide({ edits: [edit('a.ts', 0)], commands: [run], closingText: 'Done.' });
      expect(check.status, run.text).toBe('unverified');
      expect(check.checks.find((c) => c.id === 'verification-after-last-edit')?.passed).toBe(true);
      const result = check.checks.find((c) => c.id === 'last-verification-passed');
      expect(result?.passed).toBe(false);
      expect(result?.detail).toBe(DETAIL_TEXT['last-verification-passed'].unknown);
    }
  });

  it('is contradicted when it reported done and the last check failed', () => {
    const check = decide({
      edits: [edit('a.ts', 0)],
      commands: [command('npm test', 1, { failed: true })],
      closingText: 'The fix has been implemented.',
    });
    expect(check.status).toBe('contradicted');
    expect(isReportedDoneUnverified(check)).toBe(true);
  });

  it('is unverified, not contradicted, when a failed check was followed by more edits', () => {
    const check = decide({
      edits: [edit('a.ts', 0), edit('a.ts', 2)],
      commands: [command('npm test', 1, { failed: true })],
      closingText: 'Done.',
    });
    expect(check.status).toBe('unverified');
  });

  it('is incomplete on an admitted gap, a failed ending, or a failed check with no claim', () => {
    expect(
      decide({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1)], closingText: 'Done, but two tests are still failing.' })
        .status,
    ).toBe('incomplete');
    expect(decide({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1)], endedOnFailedTool: true }).status).toBe(
      'incomplete',
    );
    expect(decide({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1, { failed: true })] }).status).toBe('incomplete');
  });

  it('lists the admission and outside-repository checks only when they apply', () => {
    const quiet = decide({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1)] });
    expect(quiet.checks.map((c) => c.id)).toEqual([
      'verification-after-last-edit',
      'last-verification-passed',
      'clean-ending',
      'completion-claimed',
      'edits-read-back',
    ]);
    const loud = decideCompletion(
      evidenceFromActivity(
        activity({ edits: [edit('a.ts', 0)], commands: [command('npm test', 1)], closingText: 'I did not run the tests.' }),
        { ...OPTS, isInsideRepo: () => false },
      ),
    );
    expect(loud.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['incompletion-admitted', 'edits-inside-repository']),
    );
  });

  it('never puts command, path or message text into a detail sentence', () => {
    const check = decideCompletion(
      evidenceFromActivity(
        activity({
          edits: [edit(SECRET_PATH, 0)],
          commands: [command(SECRET_COMMAND, 1, { failed: true })],
          closingText: SECRET_MESSAGE,
        }),
        { ...OPTS, isInsideRepo: () => false },
      ),
    );
    const evidence = evidenceFromActivity(
      activity({ edits: [edit(SECRET_PATH, 0)], commands: [command(SECRET_COMMAND, 1)], closingText: SECRET_MESSAGE }),
      OPTS,
    );
    const serialized = JSON.stringify([check, evidence, completionCounts(check, evidence)]);
    for (const fragment of ['SUPERSECRETVALUE', 'npm test', 'private-project', 'billing', 'Zebra', 'invoice']) {
      expect(serialized).not.toContain(fragment);
    }
    const allowed = new Set(Object.values(DETAIL_TEXT).flatMap((t) => [t.passed, t.failed, t.unknown]));
    for (const item of check.checks) {
      expect(allowed.has(item.detail)).toBe(true);
    }
  });
});

describe('completionCounts', () => {
  it('flattens the check and evidence into content-free fields', () => {
    const evidence: CompletionEvidence = evidenceFromActivity(
      activity({ edits: [edit('a.ts', 0), edit('b.ts', 1)], commands: [command('npx tsc --noEmit', 2)], closingText: 'Done.' }),
      OPTS,
    );
    expect(completionCounts(decideCompletion(evidence), evidence)).toEqual({
      completionStatus: 'verified',
      completionClaim: 'done',
      verifyRuns: 1,
      verifyFailures: 0,
      lastVerifyClass: 'typecheck',
      verifiedAfterLastEdit: true,
      lastVerifyFailed: false,
      endedOnFailedTool: false,
      filesEdited: 2,
      filesOutsideRepo: 0,
    });
  });

  it('carries the not-applicable reason', () => {
    const evidence = evidenceFromActivity(emptyActivity(true), OPTS);
    expect(completionCounts(decideCompletion(evidence), evidence)).toMatchObject({
      completionStatus: 'not-applicable',
      completionNaReason: 'no-edits',
    });
  });
});
