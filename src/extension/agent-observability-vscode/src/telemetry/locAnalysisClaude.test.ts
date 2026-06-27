import { describe, it, expect } from 'vitest';
import { countClaudeWrittenLines } from './locAnalysis';

const CODE = ['.ts'];
const DOC = ['.md'];

describe('countClaudeWrittenLines', () => {
  it('Write: whole content added, classified by extension', () => {
    const d = countClaudeWrittenLines('Write', { file_path: 'a.ts', content: 'x\ny\nz' }, CODE, DOC);
    expect(d.added.code).toBe(3);
    expect(d.added.doc).toBe(0);
    expect(d.removed.code).toBe(0);
  });

  it('Write to a doc file counts as documentation', () => {
    const d = countClaudeWrittenLines('Write', { file_path: 'README.md', content: 'a\nb' }, CODE, DOC);
    expect(d.added.doc).toBe(2);
    expect(d.added.code).toBe(0);
  });

  it('Edit: new_string added, old_string removed', () => {
    const d = countClaudeWrittenLines(
      'Edit',
      { file_path: 'a.ts', old_string: 'old\nlines', new_string: 'a\nb\nc' },
      CODE,
      DOC,
    );
    expect(d.added.code).toBe(3);
    expect(d.removed.code).toBe(2);
  });

  it('MultiEdit: sums every edit', () => {
    const d = countClaudeWrittenLines(
      'MultiEdit',
      {
        file_path: 'a.ts',
        edits: [
          { old_string: 'a', new_string: 'a\nb' },
          { old_string: 'x\ny', new_string: 'z' },
        ],
      },
      CODE,
      DOC,
    );
    expect(d.added.code).toBe(3); // 2 + 1
    expect(d.removed.code).toBe(3); // 1 + 2
  });

  it('NotebookEdit: new_source added', () => {
    const d = countClaudeWrittenLines('NotebookEdit', { notebook_path: 'n.ts', new_source: 'p\nq' }, CODE, DOC);
    expect(d.added.code).toBe(2);
  });

  it('unknown tools and non-object input yield an all-zero delta', () => {
    expect(countClaudeWrittenLines('Bash', { command: 'ls' }, CODE, DOC)).toEqual({
      added: { code: 0, doc: 0 },
      removed: { code: 0, doc: 0 },
    });
    expect(countClaudeWrittenLines('Write', 'not-an-object', CODE, DOC).added.code).toBe(0);
  });

  it('unclassified extensions count toward neither metric', () => {
    const d = countClaudeWrittenLines('Write', { file_path: 'data.bin', content: 'a\nb' }, CODE, DOC);
    expect(d.added.code).toBe(0);
    expect(d.added.doc).toBe(0);
  });
});
