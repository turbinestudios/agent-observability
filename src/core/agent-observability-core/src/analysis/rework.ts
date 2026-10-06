import type { ActivityFileEdit } from './sessionActivity';

/**
 * Rework signals: which files a session kept coming back to, and how many of
 * the lines it added it later removed again.
 *
 * A proxy, never a quality score. Rewriting a file three times is sometimes
 * exactly the right way to get somewhere; the signal says where to look, not
 * what to conclude. Pure and node-free: the datahost persists the numbers and
 * the renderer imports the thresholds for its tooltips.
 *
 * `file` is the path as the transcript recorded it (absolute). LOCAL-ONLY, in
 * the same class as a context file's path: it is never placed on the
 * aggregate, sync or team paths, and never in a payload sent to an AI vendor.
 */

/** A file edited in at least this many distinct turns counts as re-edited. */
export const REEDIT_MIN_TURNS = 3;
/** Lines added then removed again in a later turn, across the session, that fire the signal on their own. */
export const REWORKED_LINES_MIN = 30;

export interface FileEditStat {
  /** As recorded by the source. LOCAL-ONLY. */
  file: string;
  editCalls: number;
  /** Distinct turns that edited the file. */
  editTurns: number;
  linesAdded: number;
  linesRemoved: number;
  /** Lines an earlier turn added that a later turn removed. */
  reworkedLines: number;
  outsideRepo: boolean;
  /**
   * How to show the file: repository-relative when it lies inside the
   * repository, its bare name otherwise. Never absolute. Present when the
   * source knew the repository root.
   */
  displayPath?: string;
}

export interface ReworkSummary {
  filesEdited: number;
  filesReedited: number;
  reworkedLines: number;
  filesOutsideRepo: number;
  /** Whether the session crosses either threshold. */
  fired: boolean;
}

export interface FileEditOptions {
  /** Absent means "cannot tell", and every file reads as inside. */
  isInsideRepo?: (path: string) => boolean;
  /** The repository root, for {@link FileEditStat.displayPath}. */
  repoRoot?: string;
  /** Per-file reworked-line counts from the activity chokepoint. */
  reworkedLinesByFile?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
}

/** Fold a session's edit calls into one row per file, most-reworked first. */
export function fileEditStats(edits: readonly ActivityFileEdit[], opts: FileEditOptions = {}): FileEditStat[] {
  const byFile = new Map<string, { stat: FileEditStat; turns: Set<number> }>();
  for (const edit of edits) {
    let entry = byFile.get(edit.path);
    if (entry === undefined) {
      const outsideRepo = opts.isInsideRepo === undefined ? false : !opts.isInsideRepo(edit.path);
      entry = {
        stat: {
          file: edit.path,
          displayPath: displayReworkPath(edit.path, opts.repoRoot, outsideRepo),
          editCalls: 0,
          editTurns: 0,
          linesAdded: 0,
          linesRemoved: 0,
          reworkedLines: reworkedFor(opts.reworkedLinesByFile, edit.path),
          outsideRepo,
        },
        turns: new Set<number>(),
      };
      byFile.set(edit.path, entry);
    }
    entry.stat.editCalls += 1;
    entry.stat.linesAdded += edit.linesAdded;
    entry.stat.linesRemoved += edit.linesRemoved;
    entry.turns.add(edit.turnIndex);
  }
  const stats = [...byFile.values()].map(({ stat, turns }) => ({ ...stat, editTurns: turns.size }));
  return stats.sort(
    (a, b) =>
      b.editTurns - a.editTurns ||
      b.reworkedLines - a.reworkedLines ||
      b.editCalls - a.editCalls ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  );
}

/** Whether one file counts as re-edited. */
export function isReedited(stat: Pick<FileEditStat, 'editTurns'>): boolean {
  return stat.editTurns >= REEDIT_MIN_TURNS;
}

export function summarizeRework(stats: readonly FileEditStat[]): ReworkSummary {
  let filesReedited = 0;
  let reworkedLines = 0;
  let filesOutsideRepo = 0;
  for (const stat of stats) {
    if (isReedited(stat)) {
      filesReedited += 1;
    }
    reworkedLines += stat.reworkedLines;
    if (stat.outsideRepo) {
      filesOutsideRepo += 1;
    }
  }
  return {
    filesEdited: stats.length,
    filesReedited,
    reworkedLines,
    filesOutsideRepo,
    fired: filesReedited > 0 || reworkedLines >= REWORKED_LINES_MIN,
  };
}

/**
 * How a file is shown: repository-relative when it lies under `root`, else its
 * bare name. Pure string work on purpose (no `node:path`), so the detail
 * renderer and the renderer process can both use it; separators and, for
 * Windows drive paths, case are normalised before the prefix test.
 */
export function displayReworkPath(file: string, root: string | undefined, outsideRepo: boolean): string {
  const normalized = file.replace(/\\/g, '/');
  const name = normalized.split('/').filter((s) => s.length > 0).pop() ?? file;
  if (outsideRepo || root === undefined || root.length === 0) {
    return name;
  }
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^[A-Za-z]:/.test(base);
  const left = windows ? normalized.toLowerCase() : normalized;
  const right = windows ? base.toLowerCase() : base;
  return left.startsWith(`${right}/`) ? normalized.slice(base.length + 1) : name;
}

function reworkedFor(source: FileEditOptions['reworkedLinesByFile'], file: string): number {
  if (source === undefined) {
    return 0;
  }
  const value = source instanceof Map ? source.get(file) : (source as Readonly<Record<string, number>>)[file];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
