import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { CLOSING_TEXT_MAX_CHARS, extractSessionActivity } from './activitySignals';
import type { ContentBlock, TranscriptRecord } from './transcript';

/**
 * Synthetic transcripts only. Paths are built with `path.join` so nothing here
 * depends on the separator of the machine running the test.
 */

const FILE_A = path.join('repo', 'src', 'a.ts');
const FILE_B = path.join('repo', 'src', 'b.ts');

let nextId = 0;
const id = (): string => `toolu_${(nextId += 1)}`;

const prompt = (text: string): TranscriptRecord => ({ type: 'user', message: { role: 'user', content: text } });
const say = (text: string): TranscriptRecord => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const call = (toolId: string, name: string, input: unknown, extra: Partial<TranscriptRecord> = {}): TranscriptRecord => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] },
  ...extra,
});
const result = (toolId: string, isError = false, toolUseResult?: TranscriptRecord['toolUseResult']): TranscriptRecord => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content: 'OUTPUT-MUST-NOT-LEAK' } as ContentBlock],
  },
  ...(toolUseResult !== undefined ? { toolUseResult } : {}),
});

describe('extractSessionActivity', () => {
  it('reads shell commands with class, failure, background and missing results', () => {
    const [pass, fail, bg, none] = [id(), id(), id(), id()];
    const activity = extractSessionActivity([
      prompt('please fix it'),
      call(pass, 'Bash', { command: 'npm test' }),
      result(pass),
      call(fail, 'Bash', { command: 'npx tsc --noEmit | tail -5' }),
      result(fail, true),
      prompt('again'),
      call(bg, 'Bash', { command: 'npm run dev', run_in_background: true }),
      result(bg),
      call(none, 'Bash', { command: 'git status' }),
    ]);
    expect(activity.commands.map((c) => [c.class, c.turnIndex, c.failed, c.resultKnown, c.resultMasked, c.background])).toEqual([
      ['test', 0, false, true, false, false],
      ['typecheck', 0, true, true, true, false],
      ['run', 1, false, true, false, true],
      ['git', 1, false, false, false, false],
    ]);
    expect(activity.commands.map((c) => c.order)).toEqual([0, 1, 2, 3]);
    expect(activity.commands.every((c) => !c.sideChain)).toBe(true);
    expect(activity.complete).toBe(true);
  });

  it('counts edit lines from the structured patch, else from the input strings', () => {
    const [patched, plain, multi, write, read, notebook] = [id(), id(), id(), id(), id(), id()];
    const activity = extractSessionActivity([
      prompt('edit things'),
      call(read, 'Read', { file_path: FILE_A }),
      result(read),
      call(patched, 'Edit', { file_path: FILE_A, old_string: 'x', new_string: 'y' }),
      result(patched, false, { structuredPatch: [{ lines: [' ctx', '-old1', '-old2', '+new1', '+new2', '+new3'] }] }),
      call(plain, 'Edit', { file_path: FILE_A, old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' }),
      result(plain),
      call(multi, 'MultiEdit', {
        file_path: FILE_B,
        edits: [
          { old_string: 'a', new_string: 'a\nb' },
          { old_string: 'c\nd', new_string: 'c' },
        ],
      }),
      result(multi),
      call(write, 'Write', { file_path: path.join('repo', 'new.ts'), content: 'l1\nl2\nl3' }),
      result(write),
      call(notebook, 'NotebookEdit', { notebook_path: path.join('repo', 'n.ipynb'), new_source: 'cell' }),
      result(notebook),
    ]);
    expect(activity.edits.map((e) => [e.tool, e.path, e.linesAdded, e.linesRemoved, e.created])).toEqual([
      ['Edit', FILE_A, 3, 2, false],
      ['Edit', FILE_A, 3, 2, false],
      ['MultiEdit', FILE_B, 3, 3, false],
      ['Write', path.join('repo', 'new.ts'), 3, 0, true],
      ['NotebookEdit', path.join('repo', 'n.ipynb'), 1, 0, false],
    ]);
    expect(activity.reads).toEqual([{ order: 0, turnIndex: 0, path: FILE_A }]);
  });

  it('does not call a Write to an already-read file a creation', () => {
    const [read, write] = [id(), id()];
    const activity = extractSessionActivity([
      prompt('go'),
      call(read, 'Read', { file_path: FILE_A }),
      result(read),
      call(write, 'Write', { file_path: FILE_A, content: 'x' }),
      result(write),
    ]);
    expect(activity.edits[0].created).toBe(false);
  });

  it('counts sub-agents and places side-chain commands at the call that spawned them', () => {
    const [edit, firstTask, secondTask, sideBash, orphanBash] = [id(), id(), id(), id(), id()];
    const main = [
      prompt('go'),
      call(firstTask, 'Task', { subagent_type: 'Explore' }),
      result(firstTask),
      call(edit, 'Edit', { file_path: FILE_A, old_string: 'a', new_string: 'b' }),
      result(edit),
      call(secondTask, 'Agent', { subagent_type: 'Explore' }),
      result(secondTask),
    ];
    const side = [
      call(sideBash, 'Bash', { command: 'npm test' }, { isSidechain: true, sourceToolUseID: secondTask }),
      result(sideBash),
      call(orphanBash, 'Bash', { command: 'npm run lint' }, { isSidechain: true }),
      result(orphanBash, true),
    ];
    const activity = extractSessionActivity(main, side);
    expect(activity.subAgents).toEqual([{ name: 'Explore', calls: 2 }]);
    const sideCommands = activity.commands.filter((c) => c.sideChain);
    expect(sideCommands.map((c) => [c.class, c.order, c.failed])).toEqual([
      ['test', 2, false],
      // No link back: it takes the FIRST spawn's position, never a later one.
      ['lint', 0, true],
    ]);
    expect(activity.edits[0].order).toBe(1);
  });

  it('skips meta and tool-result user records when counting turns', () => {
    const bash = id();
    const activity = extractSessionActivity([
      { type: 'user', isMeta: true, message: { role: 'user', content: 'injected' } },
      call(bash, 'Bash', { command: 'ls' }),
      result(bash),
      prompt('first real prompt'),
    ]);
    expect(activity.commands[0].turnIndex).toBe(-1);
  });

  it('keeps only the tail of the closing text and never tool output', () => {
    const bash = id();
    const long = `${'x'.repeat(CLOSING_TEXT_MAX_CHARS)}THE-END`;
    const activity = extractSessionActivity([prompt('go'), call(bash, 'Bash', { command: 'ls' }), result(bash), say(long)]);
    expect(activity.closingText).toHaveLength(CLOSING_TEXT_MAX_CHARS);
    expect(activity.closingText?.endsWith('THE-END')).toBe(true);
    expect(JSON.stringify(activity)).not.toContain('OUTPUT-MUST-NOT-LEAK');
  });

  it('reports a trailing run of failed tool calls only when the session ends on it', () => {
    const [ok, f1, f2] = [id(), id(), id()];
    const records = [
      prompt('go'),
      call(ok, 'Bash', { command: 'ls' }),
      result(ok),
      call(f1, 'Bash', { command: 'npm test' }),
      result(f1, true),
      call(f2, 'Bash', { command: 'npm test' }),
      result(f2, true),
    ];
    expect(extractSessionActivity(records)).toMatchObject({ endedOnFailedTool: true, trailingFailedTools: 2 });
    expect(extractSessionActivity([...records, say('I could not fix it.')])).toMatchObject({
      endedOnFailedTool: false,
      trailingFailedTools: 2,
    });
  });

  it('collects permission modes and tolerates malformed inputs', () => {
    const [noInput, noCommand] = [id(), id()];
    const activity = extractSessionActivity([
      { type: 'permission-mode', permissionMode: 'plan' },
      { ...prompt('go'), permissionMode: 'bypassPermissions' },
      call(noInput, 'Edit', undefined),
      call(noCommand, 'Bash', { command: '   ' }),
      { type: 'assistant' },
    ]);
    expect(activity.permissionModes).toEqual(['bypassPermissions', 'plan']);
    expect(activity.edits).toEqual([]);
    expect(activity.commands).toEqual([]);
  });

  it('returns an empty, complete activity for an empty transcript', () => {
    expect(extractSessionActivity([])).toEqual({
      commands: [],
      edits: [],
      reads: [],
      permissionModes: [],
      subAgents: [],
      endedOnFailedTool: false,
      trailingFailedTools: 0,
      complete: true,
    });
  });
});
