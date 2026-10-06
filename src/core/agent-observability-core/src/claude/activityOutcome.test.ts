import { describe, expect, it } from 'vitest';
import { classifyCommand, commandOutcome, type ActivityCommand } from '../analysis/sessionActivity';
import { decideCompletion, evidenceFromActivity } from '../analysis/completionCheck';
import { extractSessionActivity } from './activitySignals';
import type { ContentBlock, TranscriptRecord } from './transcript';

/**
 * A check's result when the exit status is masked: read from what the check
 * printed. Synthetic transcripts only; every output string carries a marker
 * so the last test can prove none of it leaves the chokepoint.
 */
const LEAK = 'OUTPUT-MUST-NOT-LEAK';
const PASS = `      Tests  4 passed (4) ${LEAK}`;
const FAIL = `      Tests  1 failed | 3 passed (4) ${LEAK}`;

let nextId = 0;
const id = (): string => `toolu_${(nextId += 1)}`;

const prompt = (text: string): TranscriptRecord => ({ type: 'user', message: { role: 'user', content: text } });
const say = (text: string): TranscriptRecord => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const call = (toolId: string, name: string, input: unknown): TranscriptRecord => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] },
});
const result = (toolId: string, content: unknown, isError = false, extra: Partial<TranscriptRecord> = {}): TranscriptRecord => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content } as ContentBlock] },
  ...extra,
});

function run(command: string, content: unknown, isError = false, input: Record<string, unknown> = {}): ActivityCommand {
  const toolId = id();
  const activity = extractSessionActivity([prompt('go'), call(toolId, 'Bash', { command, ...input }), result(toolId, content, isError)]);
  return activity.commands[0];
}

describe('classifyCommand mask forms', () => {
  it('names how the exit status is masked and how many lines a truncating pipe lets through', () => {
    expect(classifyCommand('npm test 2>&1 | tail -30')).toMatchObject({ class: 'test', resultMasked: true, maskedBy: 'truncate', maskLines: 30 });
    expect(classifyCommand('npx tsc --noEmit | head -n 5')).toMatchObject({ maskedBy: 'truncate', maskLines: 5 });
    expect(classifyCommand('npm test | tail')).toMatchObject({ maskedBy: 'truncate', maskLines: 10 });
    expect(classifyCommand('npm test | tee out.log')).toEqual({ class: 'test', resultMasked: true, maskedBy: 'truncate' });
    expect(classifyCommand('npx tsc --noEmit | grep "error TS"')).toMatchObject({ maskedBy: 'filter' });
    expect(classifyCommand('npm test | grep -E "pass|fail" | tail -3')).toMatchObject({ maskedBy: 'filter' });
    expect(classifyCommand('npm test | tail -40 | head -5')).toMatchObject({ maskedBy: 'truncate', maskLines: 5 });
    expect(classifyCommand('npm test | node report.js')).toMatchObject({ maskedBy: 'pipe' });
    expect(classifyCommand('npm test || true')).toMatchObject({ maskedBy: 'or' });
    expect(classifyCommand('npm test; echo done')).toMatchObject({ maskedBy: 'sequence' });
    expect(classifyCommand('npm run build && npm test')).toEqual({ class: 'test', resultMasked: false });
  });
});

describe('command outcome', () => {
  it('trusts the exit status of an unmasked check, and a failure marker over a clean flag', () => {
    expect(run('npm test', 'whatever').outcome).toBe('passed');
    expect(run('npm test', 'whatever', true).outcome).toBe('failed');
    expect(run('npm test', FAIL).outcome).toBe('failed');
  });

  it('reads a masked check from its own summary', () => {
    expect(run('npm test 2>&1 | tail -30', PASS).outcome).toBe('passed');
    expect(run('npm test 2>&1 | tail -30', FAIL).outcome).toBe('failed');
    expect(run('npm test | grep Tests', PASS).outcome).toBe('passed');
    expect(run('npm test || true', FAIL).outcome).toBe('failed');
    expect(run('npm test; echo done', 'done').outcome).toBe('unknown');
    // The result block as an array of text blocks.
    expect(run('npm test | tail -5', [{ type: 'text', text: PASS }]).outcome).toBe('passed');
  });

  it('falls back to stdout on the structured result when the block carries no text', () => {
    const toolId = id();
    const activity = extractSessionActivity([
      prompt('go'),
      call(toolId, 'Bash', { command: 'npm test | tail -5' }),
      result(toolId, '', false, { toolUseResult: { stdout: PASS, stderr: '' } }),
    ]);
    expect(activity.commands[0].outcome).toBe('passed');
  });

  it('never passes a masked check on silence, except a silent type-check or lint that was not cut', () => {
    // Filtering for errors and finding none proves nothing.
    expect(run('npx tsc --noEmit | grep "error TS"', '').outcome).toBe('unknown');
    // A test runner is never silent on success.
    expect(run('npm test | tail -5', '').outcome).toBe('unknown');
    // tsc and eslint are: nothing printed behind a truncating pipe is their pass.
    expect(run('npx tsc --noEmit 2>&1 | tail -20', '').outcome).toBe('passed');
    expect(run('npx eslint src | head -20', '').outcome).toBe('passed');
    // Script banners only, fewer lines than the pipe lets through: nothing was cut.
    expect(run('npm run typecheck 2>&1 | tail -20', '\n> pkg@1.0.0 typecheck\n> tsc --noEmit\n').outcome).toBe('passed');
    // The same banners filling the whole window: an earlier workspace's errors may have been cut.
    expect(run('npm run typecheck --workspaces 2>&1 | tail -2', '> pkg@1.0.0 typecheck\n> tsc --noEmit').outcome).toBe('unknown');
    // A tool-call error is never a silent pass.
    expect(run('npx tsc --noEmit | tail -20', '', true).outcome).toBe('unknown');
  });

  it('leaves a background start and a missing result unknown, and non-checks without an outcome', () => {
    expect(run('npm test', PASS, false, { run_in_background: true }).outcome).toBe('unknown');
    const toolId = id();
    const noResult = extractSessionActivity([prompt('go'), call(toolId, 'Bash', { command: 'npm test' })]).commands[0];
    expect(noResult.outcome).toBe('unknown');
    const other = run('git status', 'clean');
    expect(other.outcome).toBeUndefined();
    expect(commandOutcome(other)).toBe('passed');
  });
});

describe('completion over masked checks', () => {
  const session = (command: string, output: string, closing: string): TranscriptRecord[] => {
    const [editId, checkId] = [id(), id()];
    return [
      prompt('fix the bug'),
      call(editId, 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
      result(editId, 'edited'),
      call(checkId, 'Bash', { command }),
      result(checkId, output),
      say(closing),
    ];
  };
  const decide = (records: TranscriptRecord[]) => {
    const activity = extractSessionActivity(records);
    const evidence = evidenceFromActivity(activity, { codeExtensions: [], docExtensions: ['.md'] });
    return { activity, evidence, check: decideCompletion(evidence) };
  };

  it('reads Verified from a piped check whose summary shows a pass', () => {
    expect(decide(session('npm test 2>&1 | tail -30', PASS, 'All done, the fix is implemented.')).check.status).toBe('verified');
  });

  it('reads a contradiction from a piped check whose summary shows a failure after a done claim', () => {
    expect(decide(session('npm test 2>&1 | tail -30', FAIL, 'All done, the fix is implemented.')).check.status).toBe('contradicted');
  });

  it('reads Left unfinished from a piped failing check with no done claim', () => {
    expect(decide(session('npm test 2>&1 | tail -30', FAIL, 'Here is where things stand.')).check.status).toBe('incomplete');
  });

  it('stays Not verified when the piped output has no recognisable summary, with the could-not-be-read sentence', () => {
    const { check } = decide(session('npm test | grep -c ok', '3', 'All done, the fix is implemented.'));
    expect(check.status).toBe('unverified');
    const sentence = check.checks.find((c) => c.id === 'last-verification-passed')?.detail;
    expect(sentence).toBe('A check ran after the last edit; its result could not be read from what the session recorded.');
  });

  it('lets no output text reach the evidence, the check or the counts', () => {
    const { activity, evidence, check } = decide(session('npm test 2>&1 | tail -30', PASS, 'All done.'));
    expect(JSON.stringify({ evidence, check })).not.toContain(LEAK);
    // The activity itself carries only the three-valued outcome for the command.
    const { text: _text, ...rest } = activity.commands[0];
    expect(JSON.stringify(rest)).not.toContain(LEAK);
    expect(JSON.stringify({ ...activity, commands: [], closingText: undefined })).not.toContain(LEAK);
  });
});
