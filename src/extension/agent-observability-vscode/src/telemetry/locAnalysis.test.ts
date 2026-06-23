import { describe, it, expect } from 'vitest';
import {
  classifyExtension,
  countWrittenLines,
  normalizeExtensions,
  sumWrittenLines,
} from './locAnalysis';

/**
 * Unit tests for the LOCAL-ONLY Lines-of-Code / Lines-of-Documentation parser.
 * Pure function tests — no DB, no vscode. Cover every file-writing tool shape,
 * extension classification, and defensive handling of malformed input.
 */

const CODE = ['.ts', '.tsx', '.py'];
const DOC = ['.md', '.txt'];

describe('normalizeExtensions', () => {
  it('lowercases, dot-prefixes, trims, dedupes, and drops non-strings/blanks', () => {
    expect(normalizeExtensions(['TS', '.md', 'tsx', ' .PY ', '', 5, '.ts', null])).toEqual([
      '.ts',
      '.md',
      '.tsx',
      '.py',
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeExtensions(undefined)).toEqual([]);
    expect(normalizeExtensions('.ts')).toEqual([]);
    expect(normalizeExtensions({})).toEqual([]);
  });
});

describe('classifyExtension', () => {
  it('classifies by extension, code list first, neither otherwise', () => {
    expect(classifyExtension('src/a.ts', CODE, DOC)).toBe('code');
    expect(classifyExtension('c:\\proj\\README.md', CODE, DOC)).toBe('doc');
    expect(classifyExtension('img/logo.png', CODE, DOC)).toBeUndefined();
  });

  it('is case-insensitive on the path extension and handles both separators', () => {
    expect(classifyExtension('SRC/A.TS', CODE, DOC)).toBe('code');
    expect(classifyExtension('a/b\\c/d.Md', CODE, DOC)).toBe('doc');
  });

  it('treats dotfiles and extension-less paths as unclassified', () => {
    expect(classifyExtension('.gitignore', CODE, DOC)).toBeUndefined();
    expect(classifyExtension('Makefile', CODE, DOC)).toBeUndefined();
  });
});

describe('countWrittenLines — per tool', () => {
  it('create_file counts the whole content as added', () => {
    const d = countWrittenLines(
      'create_file',
      JSON.stringify({ filePath: 'a.ts', content: 'line1\nline2\nline3' }),
      CODE,
      DOC,
    );
    expect(d).toEqual({ added: { code: 3, doc: 0 }, removed: { code: 0, doc: 0 } });
  });

  it('insert_edit_into_file counts the code block as added', () => {
    const d = countWrittenLines(
      'insert_edit_into_file',
      JSON.stringify({ filePath: 'notes.md', code: 'a\nb\n' }),
      CODE,
      DOC,
    );
    expect(d).toEqual({ added: { code: 0, doc: 2 }, removed: { code: 0, doc: 0 } });
  });

  it('replace_string_in_file counts newString added and oldString removed', () => {
    const d = countWrittenLines(
      'replace_string_in_file',
      JSON.stringify({ filePath: 'a.ts', oldString: 'x\ny', newString: 'p\nq\nr' }),
      CODE,
      DOC,
    );
    expect(d).toEqual({ added: { code: 3, doc: 0 }, removed: { code: 2, doc: 0 } });
  });

  it('multi_replace_string_in_file sums replacements, honoring per-edit filePath', () => {
    const d = countWrittenLines(
      'multi_replace_string_in_file',
      JSON.stringify({
        filePath: 'a.ts',
        replacements: [
          { oldString: 'a', newString: 'a1\na2' },
          { filePath: 'r.md', oldString: 'd1\nd2', newString: 'd1' },
        ],
      }),
      CODE,
      DOC,
    );
    // a.ts: +2 code, -1 code; r.md: +1 doc, -2 doc
    expect(d).toEqual({ added: { code: 2, doc: 1 }, removed: { code: 1, doc: 2 } });
  });

  it('apply_patch counts +/- lines per Add/Update file, excluding markers and Delete bodies', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+const a = 1;',
      '+const b = 2;',
      '*** Update File: docs/readme.md',
      '+added doc line',
      '-removed doc line',
      ' context line',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n');
    const d = countWrittenLines('apply_patch', JSON.stringify({ input: patch }), CODE, DOC);
    expect(d).toEqual({ added: { code: 2, doc: 1 }, removed: { code: 0, doc: 1 } });
  });

  it('ignores files matching neither list', () => {
    const d = countWrittenLines(
      'create_file',
      JSON.stringify({ filePath: 'logo.png', content: 'a\nb\nc' }),
      CODE,
      DOC,
    );
    expect(d).toEqual({ added: { code: 0, doc: 0 }, removed: { code: 0, doc: 0 } });
  });
});

describe('countWrittenLines — defensive', () => {
  const ZERO = { added: { code: 0, doc: 0 }, removed: { code: 0, doc: 0 } };

  it('returns all-zero for malformed JSON', () => {
    expect(countWrittenLines('create_file', '{not json', CODE, DOC)).toEqual(ZERO);
  });

  it('returns all-zero for unknown tools', () => {
    expect(
      countWrittenLines('run_in_terminal', JSON.stringify({ command: 'ls' }), CODE, DOC),
    ).toEqual(ZERO);
  });

  it('returns all-zero for missing/typed-wrong fields', () => {
    expect(countWrittenLines('create_file', JSON.stringify({ filePath: 'a.ts' }), CODE, DOC)).toEqual(
      ZERO,
    );
    expect(countWrittenLines('create_file', JSON.stringify({ content: 'x' }), CODE, DOC)).toEqual(
      ZERO,
    );
    expect(countWrittenLines('apply_patch', JSON.stringify({ input: 42 }), CODE, DOC)).toEqual(ZERO);
  });
});

describe('sumWrittenLines', () => {
  it('aggregates added/removed across many spans', () => {
    const total = sumWrittenLines(
      [
        { toolName: 'create_file', argumentsJson: JSON.stringify({ filePath: 'a.ts', content: 'x\ny' }) },
        {
          toolName: 'replace_string_in_file',
          argumentsJson: JSON.stringify({ filePath: 'r.md', oldString: 'd', newString: 'd1\nd2' }),
        },
        { toolName: 'unknown', argumentsJson: '{}' },
      ],
      CODE,
      DOC,
    );
    expect(total).toEqual({ added: { code: 2, doc: 2 }, removed: { code: 0, doc: 1 } });
  });
});
