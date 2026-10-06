import { describe, expect, it } from 'vitest';
import type { TranscriptRecord } from './transcript';
import { REWORK_MAX_TRACKED_LINES, extractSessionActivity } from './activitySignals';

/**
 * The line-level rework matcher inside the activity chokepoint: lines an
 * earlier turn added to a file that a later turn removed. Only integers leave
 * the extraction; these tests pin the count, never the text.
 */

const FILE = '/repo/src/a.ts';
let nextId = 0;

function prompt(text: string): TranscriptRecord {
  return { type: 'user', message: { role: 'user', content: text } };
}

/** One edit call plus its result record; `patch` makes it the structured-patch form. */
function editCall(input: Record<string, unknown>, opts: { tool?: string; patch?: string[]; failed?: boolean } = {}): TranscriptRecord[] {
  const id = `call-${(nextId += 1)}`;
  return [
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: opts.tool ?? 'Edit', input }] },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: opts.failed === true }] },
      ...(opts.patch !== undefined ? { toolUseResult: { structuredPatch: [{ lines: opts.patch }] } } : {}),
    },
  ];
}

function reworked(records: TranscriptRecord[]): number {
  return extractSessionActivity(records).reworkedLinesByFile?.[FILE] ?? 0;
}

describe('rework matcher', () => {
  it('counts lines added in one turn and removed in a later one, from old/new strings', () => {
    const records = [
      prompt('add it'),
      ...editCall({ file_path: FILE, old_string: 'const a = 1;', new_string: 'const a = 1;\nconst helper = build();\nreturn helper;' }),
      prompt('no, drop the helper'),
      ...editCall({ file_path: FILE, old_string: 'const a = 1;\nconst helper = build();\nreturn helper;', new_string: 'const a = 1;' }),
    ];
    // The unchanged context line `const a = 1;` is neither added nor removed.
    expect(reworked(records)).toBe(2);
  });

  it('uses the structured patch when the result carries one', () => {
    const records = [
      prompt('one'),
      ...editCall({ file_path: FILE, old_string: 'x', new_string: 'y' }, { patch: [' keep();', '+first(line);', '+second(line);'] }),
      prompt('two'),
      ...editCall({ file_path: FILE, old_string: 'x', new_string: 'y' }, { patch: ['-first(line);', '+third(line);'] }),
    ];
    expect(reworked(records)).toBe(1);
  });

  it('ignores removals within the turn that added the line', () => {
    const records = [
      prompt('one turn'),
      ...editCall({ file_path: FILE, old_string: '', new_string: 'const tmp = compute();' }),
      ...editCall({ file_path: FILE, old_string: 'const tmp = compute();', new_string: 'const value = compute();' }),
    ];
    expect(reworked(records)).toBe(0);
  });

  it('matches whitespace-normalised and skips lines too short to mean anything', () => {
    const records = [
      prompt('one'),
      ...editCall({ file_path: FILE, old_string: '', new_string: '    if (ready)   {\n  }\n\n' }),
      prompt('two'),
      ...editCall({ file_path: FILE, old_string: 'if (ready) {\n}', new_string: '' }),
    ];
    // `if (ready) {` matches despite indentation; the lone brace and blank lines never count.
    expect(reworked(records)).toBe(1);
  });

  it('handles MultiEdit edits individually and a Write as added lines', () => {
    const records = [
      prompt('one'),
      ...editCall({ file_path: FILE, content: 'alpha = 1;\nbeta = 2;\ngamma = 3;' }, { tool: 'Write' }),
      prompt('two'),
      ...editCall(
        { file_path: FILE, edits: [{ old_string: 'alpha = 1;', new_string: 'alpha = 10;' }, { old_string: 'gamma = 3;', new_string: '' }] },
        { tool: 'MultiEdit' },
      ),
    ];
    expect(reworked(records)).toBe(2);
  });

  it('does not count an edit whose tool call failed', () => {
    const records = [
      prompt('one'),
      ...editCall({ file_path: FILE, old_string: '', new_string: 'const kept = true;' }),
      prompt('two'),
      ...editCall({ file_path: FILE, old_string: 'const kept = true;', new_string: '' }, { failed: true }),
    ];
    expect(reworked(records)).toBe(0);
  });

  it('stops remembering new lines past the per-file cap, so the work stays bounded', () => {
    const many = Array.from({ length: REWORK_MAX_TRACKED_LINES + 50 }, (_, i) => `line_number_${i}();`);
    const records = [
      prompt('one'),
      ...editCall({ file_path: FILE, content: many.join('\n') }, { tool: 'Write' }),
      prompt('two'),
      ...editCall({ file_path: FILE, old_string: many.join('\n'), new_string: '' }),
    ];
    expect(reworked(records)).toBe(REWORK_MAX_TRACKED_LINES);
  });

  it('leaves the field absent when nothing was reworked, and never exposes line text', () => {
    const activity = extractSessionActivity([
      prompt('one'),
      ...editCall({ file_path: FILE, old_string: '', new_string: 'const SECRET_MARKER = 1;' }),
      prompt('two'),
      ...editCall({ file_path: FILE, old_string: 'const SECRET_MARKER = 1;', new_string: '' }),
    ]);
    expect(activity.reworkedLinesByFile).toEqual({ [FILE]: 1 });
    expect(JSON.stringify({ ...activity, closingText: undefined })).not.toContain('SECRET_MARKER');
    expect(extractSessionActivity([prompt('one'), ...editCall({ file_path: FILE, old_string: '', new_string: 'x = 1;' })]).reworkedLinesByFile).toBeUndefined();
  });
});
