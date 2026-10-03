import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AggregationRow } from '@agent-observability/core/src/aggregate/aggregator';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import { validateTeamShard } from '@agent-observability/core/src/team/teamShardValidator';
import type { TeamShard } from '@agent-observability/core/src/team/teamShardModels';
import type { RetrospectiveCounts } from '@agent-observability/core/src/analysis/retrospective';
import type { SessionRow } from '../../shared/rpc';
import { DesktopSettingsReader } from '../drivers/desktopConfig';
import { IndexDb } from '../indexer/indexDb';
import type { SessionAnalysis } from '../analysis/sessionAnalyzer';
import {
  TEAM_CONSENTED_AT_KEY,
  TEAM_FOLDER_KEY,
  TEAM_REPOSITORIES_KEY,
  TEAM_REPOSITORY_MODE_KEY,
  TEAM_SHARE_ENABLED_KEY,
  exportTeamShard,
  previewTeamShard,
  type TeamExportDeps,
} from './teamExport';
import { collectContextObservations, repoRelativePosix } from './teamShardSource';
import { TeamStateStore } from './teamState';

/**
 * The export against a temp index, a temp config and a temp folder. The
 * "gate off" case is the one that matters most: nothing may be gathered,
 * let alone written, unless sharing is on AND consent was recorded.
 */

const REPO = 'https://github.com/o/repo';
const OTHER = 'https://github.com/o/other';
const DEV = `dev_${'7'.repeat(32)}`;
const DAY = 86_400_000;

let dir: string;
let dbPath: string;
let db: IndexDb;
let settings: DesktopSettingsReader;
let folder: string;
let checkout: string;
let now: number;
let rowRequests: number;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: REPO,
    title: 'A secret title that must never leave',
    startedAtMs: now - 2 * DAY,
    endedAtMs: now - 2 * DAY + 60_000,
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
    costMicros: 2_000_000,
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

function aggregationRow(over: Partial<AggregationRow> = {}): AggregationRow {
  return {
    startTimeMs: now - 2 * DAY,
    sessionKey: 'a',
    repository: REPO,
    model: 'claude-opus',
    agentMode: 'agent',
    operation: 'chat',
    durationMs: 1200,
    statusCode: 1,
    inputTokens: 1_000,
    outputTokens: 100,
    cachedTokens: 0,
    ...over,
  };
}

function fakeSource(rows: AggregationRow[]): SessionDataSource {
  return {
    id: 'claude',
    label: 'Claude Code',
    costMode: 'usd',
    iconId: 'sparkle',
    isEnabled: () => true,
    getAggregationRows: () => {
      rowRequests += 1;
      return { ok: true, value: rows };
    },
  } as unknown as SessionDataSource;
}

function deps(over: Partial<TeamExportDeps> = {}): TeamExportDeps {
  const source = fakeSource([aggregationRow(), aggregationRow({ sessionKey: 'hidden-one' }), aggregationRow({ sessionKey: 'b', repository: OTHER })]);
  return {
    db,
    settings,
    sources: { enabled: () => [source], get: () => source },
    hidden: { all: () => ['claude:hidden-one'], isHidden: (_s, id) => id === 'hidden-one' },
    state: new TeamStateStore(path.join(dir, 'team-state.json')),
    developerId: () => DEV,
    toolVersion: () => '1.17.0',
    now: () => now,
    repoRootSeams: { resolveRepository: () => REPO },
    ...over,
  };
}

beforeEach(() => {
  now = Date.now();
  rowRequests = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-export-'));
  folder = path.join(dir, 'shared');
  fs.mkdirSync(folder);
  checkout = path.join(dir, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'AGENTS.md'), '# a\n');
  dbPath = path.join(dir, 'index.db');
  db = new IndexDb(dbPath);
  settings = new DesktopSettingsReader(path.join(dir, 'config.json'));
  db.putCachedRepository(checkout, REPO, now);
  db.upsertSessions([
    row({ sessionId: 'a' }),
    row({ sessionId: 'hidden-one' }),
    row({ sessionId: 'b', repository: OTHER, costMicros: undefined }),
  ]);
  db.putAnalysis(
    'claude',
    'a',
    analysis({
      retro: counts({ verdict: 'bumpy' }),
      contextFiles: [
        { name: 'AGENTS.md', filePath: path.join(checkout, 'AGENTS.md'), category: 'instruction', status: 'applied', estTokens: 40 },
        { name: 'CLAUDE.md', filePath: path.join(os.homedir(), '.claude', 'CLAUDE.md'), category: 'instruction', status: 'applied', estTokens: 10 },
        { name: 'x.md', filePath: path.join(checkout, 'src', 'x.md'), category: 'instruction', status: 'applied', estTokens: 10 },
      ],
    }),
    5_000,
    now,
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function consent(): void {
  settings.update({ [TEAM_FOLDER_KEY]: folder, [TEAM_SHARE_ENABLED_KEY]: true, [TEAM_CONSENTED_AT_KEY]: now });
}

describe('exportTeamShard', () => {
  it('refuses before gathering anything when sharing is off, and when consent was never recorded', () => {
    settings.update({ [TEAM_FOLDER_KEY]: folder });
    expect(exportTeamShard(deps())).toMatchObject({ ok: false, error: expect.stringContaining('turned off') });
    settings.update({ [TEAM_SHARE_ENABLED_KEY]: true });
    expect(exportTeamShard(deps()).ok).toBe(false);
    expect(rowRequests).toBe(0);
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('refuses without a folder, or with a missing one, as an error value', () => {
    settings.update({ [TEAM_SHARE_ENABLED_KEY]: true, [TEAM_CONSENTED_AT_KEY]: now });
    expect(exportTeamShard(deps()).error).toContain('No team folder');
    settings.update({ [TEAM_FOLDER_KEY]: path.join(dir, 'gone') });
    const result = exportTeamShard(deps());
    expect(result.error).toContain('does not exist');
    expect(deps().state.get().lastExportError).toContain('does not exist');
  });

  it('writes a valid shard named after the member, leaving no temp file, excluding hidden sessions', () => {
    consent();
    const result = exportTeamShard(deps());
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(folder, `${DEV}.json`));
    expect(fs.readdirSync(folder)).toEqual([`${DEV}.json`]);

    const text = fs.readFileSync(result.path as string, 'utf8');
    const shard = JSON.parse(text) as TeamShard;
    expect(validateTeamShard(shard, DEV)).toEqual([]);
    expect(shard.toolVersion).toBe('1.17.0');
    expect(text).not.toContain('secret title');
    expect(text).not.toContain(checkout);
    expect(text).not.toContain(os.homedir());
    // Two visible sessions → outcomes for two repositories; the hidden one is absent.
    expect(shard.outcomes.map((o) => o.repository).sort()).toEqual([OTHER, REPO]);
    expect(shard.outcomes.reduce((n, o) => n + o.sessionCount, 0)).toBe(2);
    expect(shard.aggregate.buckets.reduce((n, b) => n + b.distinctSessionCount, 0)).toBe(2);
    // Only the context file inside the verified checkout AND on the allowlist survives.
    expect(shard.contextInsights.rows.map((r) => r.contextFile)).toEqual(['AGENTS.md']);
    expect(deps().state.get()).toMatchObject({ lastExportBytes: result.bytes, lastExportDeveloperId: DEV });
  });

  it('honours an exclude policy across all three parts', () => {
    consent();
    settings.update({ [TEAM_REPOSITORY_MODE_KEY]: 'exclude', [TEAM_REPOSITORIES_KEY]: [OTHER] });
    const result = exportTeamShard(deps());
    const shard = JSON.parse(fs.readFileSync(result.path as string, 'utf8')) as TeamShard;
    const text = JSON.stringify(shard);
    expect(text).not.toContain(OTHER);
    expect(shard.outcomes.map((o) => o.repository)).toEqual([REPO]);
    expect(shard.aggregate.buckets.every((b) => b.repository === REPO)).toBe(true);
  });

  it('refuses to write a shard that fails validation', () => {
    consent();
    const result = exportTeamShard(deps({ developerId: () => 'not-an-id' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid team file');
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});

describe('previewTeamShard', () => {
  it('shows the exact JSON and its summary whether or not sharing is on', () => {
    settings.update({ [TEAM_FOLDER_KEY]: folder });
    const preview = previewTeamShard(deps());
    expect(preview.shareEnabled).toBe(false);
    expect(preview.developerId).toBe(DEV);
    expect(preview.repositories).toEqual([OTHER, REPO]);
    expect(preview.outcomeRowCount).toBe(2);
    expect(preview.contextRowCount).toBe(1);
    expect(preview.bytes).toBe(Buffer.byteLength(preview.json, 'utf8'));
    expect(JSON.parse(preview.json)).toMatchObject({ schemaVersion: '1.0', pseudonymousDeveloperId: DEV });
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});

describe('collectContextObservations', () => {
  it('drops files outside the checkout and off the allowlist', () => {
    const observations = collectContextObservations(
      {
        db,
        sources: { enabled: () => [], get: () => undefined },
        hidden: { all: () => [], isHidden: () => false },
        policy: { mode: 'all', repositories: new Set() },
        repoRootSeams: { resolveRepository: () => REPO },
      },
      0,
      now + DAY,
    );
    expect(observations.map((o) => o.contextFile)).toEqual(['AGENTS.md']);
    expect(observations[0]).toMatchObject({ repository: REPO, applied: true, estTokens: 40, hadError: false });
  });
});

describe('repoRelativePosix', () => {
  it('relativizes inside the root with forward slashes and refuses anything else', () => {
    const root = path.join(os.tmpdir(), 'r');
    expect(repoRelativePosix(path.join(root, '.claude', 'rules', 'a.md'), root)).toBe('.claude/rules/a.md');
    expect(repoRelativePosix(path.join(os.tmpdir(), 'elsewhere', 'a.md'), root)).toBeUndefined();
    expect(repoRelativePosix(root, root)).toBeUndefined();
    expect(repoRelativePosix('relative/a.md', root)).toBeUndefined();
  });
});
