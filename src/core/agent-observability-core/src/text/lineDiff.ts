/**
 * A minimal line diff for the improvement-plan preview — the repo deliberately
 * carries no diff library, and the inputs here are context files capped at a
 * few thousand characters, so a plain LCS over lines is more than enough.
 * Pure; no node imports.
 */

/** One line of a diff, in display order. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** A folded run of unchanged lines, for compact previews. */
export interface DiffFold {
  kind: 'fold';
  /** How many unchanged lines the fold hides. */
  count: number;
}

/**
 * Diff two texts line by line (classic LCS backtrack): unchanged lines come
 * out `same`, removals `del` (before's order), additions `add` (after's).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // LCS length table, (a.length+1) × (b.length+1).
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Array<number>(rows * cols).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: 'del', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j] });
    j += 1;
  }
  return out;
}

/**
 * Collapse long unchanged runs to folds, keeping `context` lines around every
 * change — the shape a review pane wants. Changes are never folded.
 */
export function foldContext(lines: readonly DiffLine[], context = 3): (DiffLine | DiffFold)[] {
  const out: (DiffLine | DiffFold)[] = [];
  let run: DiffLine[] = [];

  const flushRun = (leading: boolean, trailing: boolean): void => {
    // Keep the tail of the run before a change and the head after one; fold
    // the middle when anything is left.
    const keepHead = leading ? 0 : context;
    const keepTail = trailing ? 0 : context;
    if (run.length <= keepHead + keepTail) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, keepHead));
      out.push({ kind: 'fold', count: run.length - keepHead - keepTail });
      out.push(...run.slice(run.length - keepTail));
    }
    run = [];
  };

  let seenChange = false;
  for (const line of lines) {
    if (line.kind === 'same') {
      run.push(line);
    } else {
      flushRun(!seenChange, false);
      seenChange = true;
      out.push(line);
    }
  }
  flushRun(!seenChange, true);
  return out;
}

/** Split into lines without a phantom trailing entry for a final newline. */
function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
