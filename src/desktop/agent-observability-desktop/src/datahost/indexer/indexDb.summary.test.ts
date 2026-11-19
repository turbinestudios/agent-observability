import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRow } from '../../shared/rpc';
import type { AnalyzedFileEdit, SessionAnalysis } from '../analysis/sessionAnalyzer';
import type { RetrospectiveCounts } from '@agent-observability/core/src/analysis/retrospective';
import { IndexDb } from './indexDb';

/**
 * Evidence > Summary in the index: one scope across every figure. Dates are
 * built from the local calendar (`new Date(y, m, d, h)`) and compared the same
 * way, and paths through `path.join`, so nothing depends on the machine.
 */

let dir: string;
let db: IndexDb;
const R1 = 'https://github.com/o/one';
const R2 = 'https://github.com/o/two';
const FILE_A = path.join(path.sep, 'checkout', 'src', 'a.ts');
const FILE_B = path.join(path.sep, 'checkout', 'src', 'b.ts');

const now = new Date();
/** Today's local midnight: always in the past, and always today. */
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
/** Far enough back to fall outside every window and past the day-column cap. */
const longAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 400, 12).getTime();

function localIso(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  const endedAtMs = over.endedAtMs ?? todayStart;
  return {
    source: 'claude',
    repository: R1,
    title: `Session ${over.sessionId}`,
    startedAtMs: endedAtMs - 60_000,
    endedAtMs,
    durationMs: 60_000,
    interactionCount: 3,
    llmCalls: 2,
    toolCalls: 4,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 5,
    model: 'claude-opus',
    agentModes: ['agent'],
    indexedAtMs: endedAtMs,
    ...over,
  };
}

function retro(verdict: RetrospectiveCounts['verdict']): RetrospectiveCounts {
  return {
    verdict,
    outcome: 'unclear',
    correctionTurns: 0,
    repeatedPromptTurns: 0,
    interruptions: 0,
    errorStreaks: 0,
    maxErrorStreak: 0,
    longTailTurns: 0,
    compactions: 0,
    churnRatioPct: 0,
    planModeUsed: false,
    tipCount: 0,
  };
}

function edit(over: Partial<AnalyzedFileEdit> = {}): AnalyzedFileEdit {
  return { file: FILE_A, editCalls: 1, editTurns: 1, linesAdded: 10, linesRemoved: 2, reworkedLines: 0, outsideRepo: false, ...over };
}

function analysis(fileEdits: AnalyzedFileEdit[], verdict?: RetrospectiveCounts['verdict']): SessionAnalysis {
  return {
    deviationCount: 0,
    errorCount: 0,
    findings: [],
    contextFiles: [],
    fileEdits,
    ...(verdict !== undefined ? { retro: retro(verdict) } : {}),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-summary-'));
  db = new IndexDb(path.join(dir, 'index.db'));
  db.upsertSessions([
    row({ sessionId: 'a', costMicros: 1_000 }),
    // Unpriced: must add nothing to cost and not count as priced.
    row({ sessionId: 'b', source: 'opencode', model: 'big-pickle' }),
    row({ sessionId: 'c', repository: R2, costMicros: 500 }),
    row({ sessionId: 'old', endedAtMs: longAgo, costMicros: 7 }),
    row({ sessionId: 'hid', costMicros: 99_000 }),
    // A source that records no edits: never counted as zero lines.
    row({ sessionId: 'cp', source: 'copilot-cli', repository: R2, costMicros: 10 }),
  ]);
  db.putAnalysis('claude', 'a', analysis([edit()], 'smooth'), 0, 1);
  db.putAnalysis('opencode', 'b', analysis([edit({ linesAdded: 5, linesRemoved: 1 }), edit({ file: FILE_B, linesAdded: 0, linesRemoved: 0 })], 'struggled'), 0, 1);
  db.putAnalysis('claude', 'hid', analysis([edit({ linesAdded: 1_000 })], 'abandoned'), 0, 1);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('evidence summary', () => {
  it('adds up one repository over the window, leaving hidden sessions out', () => {
    const s = db.evidenceSummary({ window: 7, repository: R1 }, ['claude:hid']);
    expect(s.totals).toMatchObject({
      sessions: 2,
      steps: 6,
      llmCalls: 4,
      toolCalls: 8,
      inputTokens: 200,
      outputTokens: 40,
      cachedTokens: 10,
      costMicros: 1_000,
      costSessions: 1,
      durationMs: 120_000,
      repositories: 1,
      models: 2,
    });
    expect(s.code).toEqual({ linesAdded: 15, linesRemoved: 3, filesEdited: 2, coveredSessions: 2, analyzedSessions: 2 });
    expect(s.verdicts).toEqual({ smooth: 1, bumpy: 0, struggled: 1, abandoned: 0, unjudged: 0 });
    expect(s.bySource.map((r) => [r.source, r.sessions]).sort()).toEqual([
      ['claude', 1],
      ['opencode', 1],
    ]);
    expect(s.windowDays).toBe(7);
    expect(s.dailyCapped).toBeUndefined();
  });

  it('keeps an unpriced model unpriced rather than $0', () => {
    const s = db.evidenceSummary({ window: 7, repository: R1 }, ['claude:hid']);
    const pickle = s.byModel.find((m) => m.model === 'big-pickle');
    expect(pickle).toBeDefined();
    expect(pickle?.costMicros).toBeUndefined();
    expect(s.byModel.find((m) => m.model === 'claude-opus')?.costMicros).toBe(1_000);
  });

  it('puts each day and source in its own point, lines included', () => {
    const s = db.evidenceSummary({ window: 7, repository: R1 }, ['claude:hid']);
    const today = localIso(todayStart);
    expect(s.daily.filter((d) => d.day === today)).toEqual([
      { day: today, source: 'claude', sessions: 1, costMicros: 1_000, linesAdded: 10, linesRemoved: 2 },
      { day: today, source: 'opencode', sessions: 1, costMicros: 0, linesAdded: 5, linesRemoved: 1 },
    ]);
  });

  it('narrows to a tag through its session keys, across repositories', () => {
    const s = db.evidenceSummary({ window: 7, restrictKeys: ['claude:a', 'claude:c'] }, ['claude:hid']);
    expect(s.totals.sessions).toBe(2);
    expect(s.totals.repositories).toBe(2);
    expect(s.topRepositories.map((r) => r.repository).sort()).toEqual([R1, R2]);
    // `c` has no analysis: not judged, never smooth.
    expect(s.verdicts).toMatchObject({ smooth: 1, unjudged: 1 });
    expect(s.code).toMatchObject({ coveredSessions: 2, analyzedSessions: 1 });
  });

  it('counts only edit-recording agents as covered by the code figures', () => {
    const s = db.evidenceSummary({ window: 7, repository: R2 });
    expect(s.totals.sessions).toBe(2);
    // `c` (Claude Code, unanalyzed) could carry lines; `cp` (Copilot CLI) never can.
    expect(s.code).toEqual({ linesAdded: 0, linesRemoved: 0, filesEdited: 0, coveredSessions: 1, analyzedSessions: 0 });
    const copilotOnly = db.evidenceSummary({ window: 7, restrictKeys: ['copilot-cli:cp'] });
    expect(copilotOnly.code.coveredSessions).toBe(0);
  });

  it('treats a tag nobody carries as nothing, not as no filter', () => {
    const s = db.evidenceSummary({ window: 'all', restrictKeys: [] });
    expect(s.totals.sessions).toBe(0);
    expect(s.totals.costMicros).toBe(0);
    expect(s.daily).toEqual([]);
    expect(s.bySource).toEqual([]);
    expect(s.code).toEqual({ linesAdded: 0, linesRemoved: 0, filesEdited: 0, coveredSessions: 0, analyzedSessions: 0 });
  });

  it('reaches back to the oldest session in scope for "all", capped', () => {
    const s = db.evidenceSummary({ window: 'all', repository: R1 }, ['claude:hid']);
    expect(s.totals.sessions).toBe(3);
    expect(s.totals.costMicros).toBe(1_007);
    expect(s.dailyCapped).toBe(true);
    // R2's sessions are all today, so its span is a single day.
    const r2 = db.evidenceSummary({ window: 'all', repository: R2 });
    expect(r2.windowDays).toBe(1);
    expect(r2.dailyCapped).toBeUndefined();
  });
});
