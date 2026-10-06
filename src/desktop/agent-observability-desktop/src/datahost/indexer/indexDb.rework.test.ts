import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRow } from '../../shared/rpc';
import type { AnalyzedFileEdit, SessionAnalysis } from '../analysis/sessionAnalyzer';
import { reworkFileRows } from '../analysis/reworkPaths';
import { IndexDb } from './indexDb';

/**
 * Rework rows in the index: the per-file table, the session-level counts, the
 * Sessions filter and the ranking. Paths are built with `path.join`, and dates
 * are plain numbers, so nothing here depends on the machine.
 */

let dir: string;
let db: IndexDb;
const FILE_A = path.join(path.sep, 'checkout', 'src', 'a.ts');
const FILE_OUT = path.join(path.sep, 'tmp', 'scratch.ts');

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'https://github.com/o/repo',
    title: `Session ${over.sessionId}`,
    startedAtMs: 1_000,
    endedAtMs: 5_000,
    durationMs: 4_000,
    interactionCount: 4,
    llmCalls: 2,
    toolCalls: 2,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    model: 'claude-opus',
    agentModes: ['agent'],
    indexedAtMs: 5_000,
    ...over,
  };
}

function fileEdit(over: Partial<AnalyzedFileEdit> = {}): AnalyzedFileEdit {
  return { file: FILE_A, editCalls: 1, editTurns: 1, linesAdded: 3, linesRemoved: 0, reworkedLines: 0, outsideRepo: false, ...over };
}

function analysis(fileEdits: AnalyzedFileEdit[]): SessionAnalysis {
  return { deviationCount: 0, errorCount: 0, findings: [], contextFiles: [], fileEdits };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rework-'));
  db = new IndexDb(path.join(dir, 'index.db'));
  db.upsertSessions([
    row({ sessionId: 'thrash' }),
    row({ sessionId: 'lines', endedAtMs: 6_000 }),
    row({ sessionId: 'calm' }),
    row({ sessionId: 'noedits' }),
    row({ sessionId: 'hidden' }),
  ]);
  db.putAnalysis('claude', 'thrash', analysis([fileEdit({ editTurns: 4, editCalls: 6, reworkedLines: 5 }), fileEdit({ file: FILE_OUT, outsideRepo: true })]), 5_000, 9_000);
  db.putAnalysis('claude', 'lines', analysis([fileEdit({ editTurns: 2, reworkedLines: 40 })]), 5_000, 9_000);
  db.putAnalysis('claude', 'calm', analysis([fileEdit()]), 5_000, 9_000);
  db.putAnalysis('claude', 'noedits', analysis([]), 5_000, 9_000);
  db.putAnalysis('claude', 'hidden', analysis([fileEdit({ editTurns: 9 })]), 5_000, 9_000);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('rework in the index', () => {
  it('carries the counts onto session rows only when there is rework', () => {
    expect(db.getRow('claude', 'thrash')).toMatchObject({ filesReedited: 1, reworkedLines: 5 });
    expect(db.getRow('claude', 'lines')).toMatchObject({ reworkedLines: 40 });
    expect(db.getRow('claude', 'lines')?.filesReedited).toBeUndefined();
    expect(db.getRow('claude', 'calm')?.filesReedited).toBeUndefined();
    expect(db.getRow('claude', 'calm')?.reworkedLines).toBeUndefined();
  });

  it('filters Sessions to the ones the signal fired for', () => {
    const ids = db.listSessions({ reworked: true }, ['claude:hidden']).map((r) => r.sessionId).sort();
    expect(ids).toEqual(['lines', 'thrash']);
  });

  it('ranks sessions and files, with the rate over sessions that edited files, hidden ones excluded', () => {
    const ranking = db.reworkRanking({}, ['claude:hidden']);
    expect(ranking.editedSessions).toBe(3);
    expect(ranking.reworkedSessions).toBe(2);
    expect(ranking.sessions.map((s) => s.sessionId)).toEqual(['lines', 'thrash']);
    expect(ranking.files).toEqual([
      { file: FILE_A, repository: 'https://github.com/o/repo', sessions: 2, editTurns: 6, reworkedLines: 45, outsideRepo: false },
    ]);
    expect(db.reworkRanking({ repository: 'https://github.com/o/other' }).editedSessions).toBe(0);
  });

  it('replaces a session’s file rows wholesale when it is re-analysed', () => {
    db.putAnalysis('claude', 'thrash', analysis([fileEdit()]), 5_000, 9_500);
    expect(db.getRow('claude', 'thrash')?.filesReedited).toBeUndefined();
    expect(db.reworkRanking({}, ['claude:hidden']).sessions.map((s) => s.sessionId)).toEqual(['lines']);
  });
});

describe('reworkFileRows', () => {
  const rows = [
    { file: FILE_A, repository: 'https://github.com/o/repo', sessions: 1, editTurns: 3, reworkedLines: 2, outsideRepo: false },
    { file: FILE_OUT, repository: 'https://github.com/o/repo', sessions: 1, editTurns: 3, reworkedLines: 0, outsideRepo: true },
    { file: FILE_A, repository: 'https://github.com/o/gone', sessions: 1, editTurns: 3, reworkedLines: 0, outsideRepo: false },
  ];
  const lookups = {
    cwdsForRepository: (repository: string) =>
      repository.endsWith('/repo') ? [{ cwd: path.join(path.sep, 'checkout'), resolvedAtMs: 1 }] : [],
    contextFilePathsForRepository: () => [],
  };
  const seams = {
    findRoot: (start: string) => start,
    resolveRepository: () => 'https://github.com/o/repo',
    exists: () => true,
  };

  it('shows files relative to the verified root, and by bare name outside it or without one', () => {
    const shown = reworkFileRows(rows, lookups, seams);
    expect(shown.map((r) => r.path)).toEqual(['src/a.ts', 'scratch.ts', 'a.ts']);
    expect(shown.every((r) => !path.isAbsolute(r.path))).toBe(true);
    expect(shown[1].outsideRepo).toBe(true);
  });
});
