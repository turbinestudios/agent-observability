import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RetrospectiveCounts } from '@agent-observability/core/src/analysis/retrospective';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { LiveSessionRow, SessionRow } from '../../shared/rpc';
import { IndexDb } from '../indexer/indexDb';
import type { SessionAnalysis } from '../analysis/sessionAnalyzer';
import { buildRepoDigestInput, buildRepoHub, buildRepositoryCards, type RepoHubDeps } from './repoHub';

/**
 * The hub over a seeded index and a fixture checkout. Dates are built relative
 * to an injected `now`, never from literals, so the window arithmetic (local
 * midnights) comes out the same in every time zone.
 */

const REPO = 'https://github.com/o/repo';
const OTHER = 'https://github.com/o/other';
const DAY = 86_400_000;

let dbPath: string;
let db: IndexDb;
let checkout: string;
let now: number;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: REPO,
    title: `Session ${over.sessionId}`,
    startedAtMs: now - DAY,
    endedAtMs: now - DAY,
    durationMs: 60_000,
    interactionCount: 5,
    llmCalls: 3,
    toolCalls: 2,
    inputTokens: 1_000,
    outputTokens: 100,
    cachedTokens: 0,
    model: 'claude-opus',
    agentModes: ['agent'],
    indexedAtMs: 5_000,
    costMicros: 1_000_000,
    ...over,
  };
}

function counts(over: Partial<RetrospectiveCounts> = {}): RetrospectiveCounts {
  return {
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
    ...over,
  };
}

function analysis(over: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return { deviationCount: 0, errorCount: 0, findings: [], contextFiles: [], ...over };
}

function live(over: Partial<LiveSessionRow>): LiveSessionRow {
  return {
    source: 'claude',
    sessionId: 'live',
    repository: REPO,
    status: 'working',
    lastEvent: 'user-prompt',
    startedAtMs: now,
    lastActivityMs: now,
    pendingTools: [],
    inputTokens: 0,
    outputTokens: 0,
    countsIndexedAtMs: 0,
    ...over,
  };
}

function deps(over: Partial<RepoHubDeps> = {}): RepoHubDeps {
  return {
    db,
    hiddenKeys: () => [],
    decorate: (rows) => rows,
    liveRows: () => [],
    plans: () => [],
    analysisStatus: () => ({ analyzed: 0, total: 0, running: false }),
    sources: { get: () => undefined },
    now: () => now,
    inventorySeams: { resolveRepository: () => REPO },
    ...over,
  };
}

beforeEach(() => {
  now = Date.now();
  dbPath = path.join(os.tmpdir(), `ao-hub-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hub-repo-'));
  fs.mkdirSync(path.join(checkout, '.git'));
  fs.mkdirSync(path.join(checkout, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'AGENTS.md'), '# agents\n');
  fs.writeFileSync(path.join(checkout, '.claude', 'rules', 'style.md'), 'rule\n');
  db.putCachedRepository(checkout, REPO, now);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  fs.rmSync(checkout, { recursive: true, force: true });
});

describe('buildRepositoryCards', () => {
  it('groups by repository, folds verdicts, excludes unknown and adds live counts', () => {
    db.upsertSessions([
      row({ sessionId: 'a' }),
      row({ sessionId: 'b', source: 'copilot', costMicros: undefined }),
      row({ sessionId: 'c', repository: OTHER }),
      row({ sessionId: 'u', repository: 'unknown' }),
    ]);
    db.putAnalysis('claude', 'a', analysis({ retro: counts({ verdict: 'bumpy' }) }), 5_000, now);

    const cards = buildRepositoryCards(30, db, [], [live({ status: 'waiting' }), live({ sessionId: 'x', status: 'finished' })]);
    expect(cards.unknownSessions).toBe(1);
    expect(cards.cards.map((c) => c.repository)).toEqual([REPO, OTHER]);
    const [repo] = cards.cards;
    expect(repo.sessions).toBe(2);
    expect(repo.verdicts).toEqual({ smooth: 0, bumpy: 1, struggled: 0, abandoned: 0, unjudged: 1 });
    expect(repo.costSessions).toBe(1);
    expect(repo.live).toBe(1);
    expect(repo.waiting).toBe(1);
    expect(repo.bySource).toEqual([
      { source: 'claude', sessions: 1 },
      { source: 'copilot', sessions: 1 },
    ]);
  });
});

describe('buildRepoHub', () => {
  it('compares this window with the equal-length one before it', () => {
    db.upsertSessions([
      row({ sessionId: 'now1', endedAtMs: now - DAY }),
      row({ sessionId: 'now2', endedAtMs: now - 2 * DAY }),
      row({ sessionId: 'prev', endedAtMs: now - 10 * DAY }),
      row({ sessionId: 'older', endedAtMs: now - 20 * DAY }),
      row({ sessionId: 'elsewhere', repository: OTHER }),
    ]);
    db.putAnalysis(
      'claude',
      'now1',
      analysis({ retro: counts({ verdict: 'struggled' }), findings: [{ id: 'tool-error-streak', severity: 'friction', count: 2 }] }),
      5_000,
      now,
    );
    db.putAnalysis(
      'claude',
      'prev',
      analysis({ retro: counts({ verdict: 'smooth' }), findings: [{ id: 'tool-error-streak', severity: 'friction', count: 1 }] }),
      5_000,
      now,
    );

    const hub = buildRepoHub(REPO, 7, deps({ liveRows: () => [live({}), live({ sessionId: 'o', repository: OTHER })] }));
    expect(hub.totals.sessions).toBe(2);
    expect(hub.previousTotals.sessions).toBe(1);
    expect(hub.verdicts).toEqual({ smooth: 0, bumpy: 0, struggled: 1, abandoned: 0, unjudged: 1 });
    expect(hub.previousVerdicts.smooth).toBe(1);
    expect(hub.themes).toEqual([{ signalId: 'tool-error-streak', sessions: 1, occurrences: 2, previousSessions: 1 }]);
    expect(hub.recent.map((r) => r.sessionId)).toEqual(['now1', 'now2']);
    expect(hub.live.map((r) => r.sessionId)).toEqual(['live']);
    expect(hub.windowDays).toBe(7);
  });

  it('joins the on-disk inventory with usage from the index, by normalized absolute path', () => {
    const agentsFile = path.join(checkout, 'AGENTS.md');
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis(
      'claude',
      'a',
      analysis({
        contextFiles: [
          { name: 'AGENTS.md', filePath: agentsFile, category: 'instruction', status: 'applied', estTokens: 40 },
          { name: 'CLAUDE.md', filePath: path.join(os.homedir(), '.claude', 'CLAUDE.md'), category: 'instruction', status: 'applied', estTokens: 10 },
        ],
      }),
      5_000,
      now,
    );

    const hub = buildRepoHub(REPO, 30, deps());
    if ('error' in hub.inventory) {
      throw new Error(hub.inventory.error);
    }
    expect(hub.inventory.root).toBe(checkout);
    const byPath = new Map(hub.inventory.files.map((f) => [f.relPath, f]));
    expect(byPath.get('AGENTS.md')?.usage).toMatchObject({ file: agentsFile, sessionCount: 1, appliedCount: 1 });
    expect(byPath.get('.claude/rules/style.md')?.kind).toBe('rule');
    expect(byPath.get('.claude/rules/style.md')?.usage).toBeUndefined();
    expect(hub.inventory.outsideRepo.map((r) => r.name)).toEqual(['CLAUDE.md']);
  });

  it('reports the resolver error when no checkout is known', () => {
    const hub = buildRepoHub(OTHER, 30, deps());
    expect('error' in hub.inventory && hub.inventory.error).toContain('No local checkout');
  });
});

describe('buildRepoDigestInput', () => {
  it('ranks tips by how many sessions fire them, relativizes paths and samples tools', () => {
    const agentsFile = path.join(checkout, 'AGENTS.md');
    db.upsertSessions([row({ sessionId: 'a' }), row({ sessionId: 'b' })]);
    for (const id of ['a', 'b']) {
      db.putAnalysis(
        'claude',
        id,
        analysis({
          retro: counts({ verdict: 'bumpy', maxErrorStreak: 4, errorStreaks: 1 }),
          findings: [{ id: 'tool-error-streak', severity: 'friction', count: 1 }],
          contextFiles: [{ name: 'AGENTS.md', filePath: agentsFile, category: 'instruction', status: 'applied', estTokens: 40 }],
        }),
        5_000,
        now,
      );
    }
    const source = {
      getSessionInteractions: () => ({
        ok: true as const,
        value: [
          { operation: 'execute_tool', toolName: 'Bash', success: false },
          { operation: 'execute_tool', toolName: 'Bash', success: true },
          { operation: 'execute_tool', toolName: 'Read', success: true },
          { operation: 'chat', success: true },
        ],
      }),
    } as unknown as SessionDataSource;

    const input = buildRepoDigestInput(REPO, 30, deps({ sources: { get: () => source } }));
    expect(input.sessions.total).toBe(2);
    expect(input.tips[0]).toMatchObject({ id: 'capture-environment-context', sessions: 2 });
    expect(input.hotspots[0].path).toBe('AGENTS.md');
    expect(input.hotspots.every((h) => !path.isAbsolute(h.path))).toBe(true);
    expect(input.tools).toEqual([
      { name: 'Bash', calls: 4, failures: 2, sampledSessions: 2 },
      { name: 'Read', calls: 2, failures: 0, sampledSessions: 2 },
    ]);
    expect(input.contextFiles.find((f) => f.relPath === 'AGENTS.md')?.seenInSessions).toBe(2);
    expect(input.themes[0]).toMatchObject({ signalId: 'tool-error-streak', label: 'tool-error-streak', sessions: 2 });
  });

  it('omits the tools section when no session could be read', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    const input = buildRepoDigestInput(REPO, 30, deps());
    expect(input.tools).toBeUndefined();
  });
});
