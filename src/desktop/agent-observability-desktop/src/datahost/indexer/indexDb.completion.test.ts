import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RetrospectiveCounts } from '@agent-observability/core/src/analysis/retrospective';
import type { CompletionCounts } from '@agent-observability/core/src/analysis/completionCheck';
import type { SessionRow } from '../../shared/rpc';
import type { SessionAnalysis } from '../analysis/sessionAnalyzer';
import { ANALYSIS_VERSION, IndexDb } from './indexDb';

/**
 * The completion check's projection through the index: stored as enums,
 * counts and booleans, read back on the row, filterable, and summarised with
 * its denominator. Dates are built from local parts, never ISO literals.
 */

let dbPath: string;
let db: IndexDb;
const DAY = new Date(2026, 4, 10, 12).getTime();

function row(sessionId: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'claude',
    sessionId,
    repository: 'https://github.com/o/repo',
    startedAtMs: DAY,
    endedAtMs: DAY,
    durationMs: 1_000,
    interactionCount: 3,
    llmCalls: 2,
    toolCalls: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    model: 'claude-sonnet',
    agentModes: ['agent'],
    indexedAtMs: 5_000,
    ...over,
  };
}

function completion(over: Partial<CompletionCounts> = {}): CompletionCounts {
  return {
    completionStatus: 'unverified',
    completionClaim: 'done',
    verifyRuns: 0,
    verifyFailures: 0,
    verifiedAfterLastEdit: false,
    lastVerifyFailed: false,
    endedOnFailedTool: false,
    filesEdited: 2,
    filesOutsideRepo: 0,
    ...over,
  };
}

function analysis(counts?: CompletionCounts): SessionAnalysis {
  const retro: RetrospectiveCounts = {
    verdict: 'smooth',
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
    ...(counts !== undefined ? { completion: counts } : {}),
  };
  return { deviationCount: 0, errorCount: 0, findings: [], contextFiles: [], retro };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `ao-completion-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
  db.upsertSessions([row('done-unverified'), row('failed'), row('verified'), row('partial'), row('docs'), row('unchecked'), row('other', { repository: 'https://github.com/o/else' })]);
  db.putAnalysis('claude', 'done-unverified', analysis(completion()), 5_000, DAY);
  db.putAnalysis('claude', 'failed', analysis(completion({ completionStatus: 'contradicted', verifyRuns: 1, verifyFailures: 1, lastVerifyClass: 'test', lastVerifyFailed: true, verifiedAfterLastEdit: true })), 5_000, DAY);
  db.putAnalysis('claude', 'verified', analysis(completion({ completionStatus: 'verified', verifyRuns: 2, lastVerifyClass: 'test', verifiedAfterLastEdit: true })), 5_000, DAY);
  db.putAnalysis('claude', 'partial', analysis(completion({ completionStatus: 'incomplete', completionClaim: 'partial' })), 5_000, DAY);
  db.putAnalysis('claude', 'docs', analysis(completion({ completionStatus: 'not-applicable', completionNaReason: 'docs-only', completionClaim: 'done' })), 5_000, DAY);
  db.putAnalysis('claude', 'unchecked', analysis(), 5_000, DAY);
  db.putAnalysis('claude', 'other', analysis(completion({ completionClaim: 'none' })), 5_000, DAY);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('completion check in the index', () => {
  it('is on analysis version 2, so existing analyses are redone once', () => {
    expect(ANALYSIS_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('puts the status on the row only for a real status, and the done claim beside it', () => {
    expect(db.getRow('claude', 'done-unverified')).toMatchObject({ completion: 'unverified', claimedDone: true });
    expect(db.getRow('claude', 'failed')).toMatchObject({ completion: 'contradicted', claimedDone: true });
    expect(db.getRow('claude', 'partial')?.completion).toBe('incomplete');
    expect(db.getRow('claude', 'partial')?.claimedDone).toBeUndefined();
    expect(db.getRow('claude', 'docs')?.completion).toBeUndefined();
    expect(db.getRow('claude', 'unchecked')?.completion).toBeUndefined();
  });

  it('filters by one status, several, and the done claim', () => {
    const ids = (params: Parameters<IndexDb['listSessions']>[0]): string[] => db.listSessions(params).map((r) => r.sessionId).sort();
    expect(ids({ completion: 'verified' })).toEqual(['verified']);
    expect(ids({ completionIn: ['unverified', 'contradicted'], claimedDone: true })).toEqual(['done-unverified', 'failed']);
    expect(ids({ completionIn: ['unverified', 'contradicted'] })).toEqual(['done-unverified', 'failed', 'other']);
    expect(ids({ claimedDone: true })).toEqual(['docs', 'done-unverified', 'failed', 'verified']);
    expect(db.countSessions({ completion: 'incomplete' })).toBe(1);
  });

  it('summarises with the denominator and excludes unchecked and not-applicable sessions', () => {
    expect(db.completionSummary({}, [])).toEqual({
      verified: 1,
      unverified: 2,
      contradicted: 1,
      incomplete: 1,
      changedCode: 5,
      reportedDoneUnverified: 2,
    });
    expect(db.completionSummary({ repository: 'https://github.com/o/else' }, []).changedCode).toBe(1);
    expect(db.completionSummary({ source: 'copilot' }, []).changedCode).toBe(0);
    expect(db.completionSummary({}, ['claude:failed']).contradicted).toBe(0);
    expect(db.completionSummary({ endedAfterMs: new Date(2026, 4, 11).getTime() }, []).changedCode).toBe(0);
  });
});

describe('completion data stays local', () => {
  it('is referenced by no team or aggregate module', () => {
    const roots = [
      path.join(__dirname, '..', 'team'),
      path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'agent-observability-core', 'src', 'team'),
      path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'agent-observability-core', 'src', 'aggregate'),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      expect(fs.existsSync(root)).toBe(true);
      for (const name of fs.readdirSync(root)) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) {
          continue;
        }
        const text = fs.readFileSync(path.join(root, name), 'utf8');
        if (/completion_status|completionStatus|completion_claim|verify_runs|CompletionCheck|completionCheck/.test(text)) {
          offenders.push(name);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
