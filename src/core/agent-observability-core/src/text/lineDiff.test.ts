import { describe, it, expect } from 'vitest';
import { diffLines, foldContext } from './lineDiff';

describe('diffLines', () => {
  it('marks unchanged, removed, and added lines', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });

  it('handles pure additions, pure removals, and identical inputs', () => {
    expect(diffLines('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
    expect(diffLines('a\nb', '')).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
    ]);
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
  });

  it('normalizes CRLF and ignores a trailing newline', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
  });
});

describe('foldContext', () => {
  it('folds long unchanged runs, keeping context around changes', () => {
    const lines = diffLines(
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n'),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'changed'].join('\n'),
    );
    const folded = foldContext(lines, 2);
    // Head run: 9 same lines with no change before them → fold all but 2.
    expect(folded[0]).toEqual({ kind: 'fold', count: 7 });
    expect(folded.slice(1, 3)).toEqual([
      { kind: 'same', text: '8' },
      { kind: 'same', text: '9' },
    ]);
    expect(folded.slice(3)).toEqual([
      { kind: 'del', text: '10' },
      { kind: 'add', text: 'changed' },
    ]);
  });

  it('leaves short runs and change lines untouched', () => {
    const lines = diffLines('a\nb', 'a\nc');
    expect(foldContext(lines, 3)).toEqual(lines);
  });
});
