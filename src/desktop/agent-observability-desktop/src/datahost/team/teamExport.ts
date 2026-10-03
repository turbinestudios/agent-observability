import * as fs from 'node:fs';
import * as path from 'node:path';
import { floorToBucketMs } from '@agent-observability/core/src/aggregate/aggregator';
import { buildRepoSyncPolicy } from '@agent-observability/core/src/aggregate/repoSyncPolicy';
import { buildTeamShard } from '@agent-observability/core/src/team/teamShardBuilder';
import { TEAM_SHARD_MAX_WINDOW_DAYS, TEAM_SHARD_TEMP_SUFFIX, type TeamShard } from '@agent-observability/core/src/team/teamShardModels';
import { validateTeamShard } from '@agent-observability/core/src/team/teamShardValidator';
import type { TeamExportResult, TeamPreview } from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import type { DesktopSettingsReader } from '../drivers/desktopConfig';
import type { RepoRootSeams } from '../improve/repoRoot';
import { collectAggregationRows, collectContextObservations, collectOutcomes, type ShardSourceDeps } from './teamShardSource';
import type { TeamStateStore } from './teamState';

/**
 * Writing this member's shard, and previewing exactly what that would write.
 *
 * The gate is checked FIRST, before a single row is gathered: like the deep
 * retrospective and the improvement plan, the datahost refuses on its own
 * when sharing is off or was never consented to, whatever the renderer asked.
 * The built shard is then validated against the same rules the importer
 * applies before a byte reaches the folder, so a producer bug can never
 * write a file a teammate's app would reject — or worse, accept.
 */

export const TEAM_FOLDER_KEY = 'team.folder';
export const TEAM_SHARE_ENABLED_KEY = 'team.shareEnabled';
export const TEAM_AUTO_EXPORT_KEY = 'team.autoExport';
export const TEAM_REPOSITORY_MODE_KEY = 'team.repositoryMode';
export const TEAM_REPOSITORIES_KEY = 'team.repositories';
export const TEAM_CONSENTED_AT_KEY = 'team.consentedAtMs';

/** A shard this large is still written, but the status warns about it. */
export const TEAM_SHARD_WARN_BYTES = 8 * 1024 * 1024;

export interface TeamExportDeps {
  db: IndexDb;
  settings: DesktopSettingsReader;
  sources: ShardSourceDeps['sources'];
  hidden: ShardSourceDeps['hidden'];
  state: TeamStateStore;
  developerId: () => string;
  toolVersion: () => string;
  now?: () => number;
  repoRootSeams?: RepoRootSeams;
  /** Filesystem seam for tests. */
  fs?: Pick<typeof fs, 'existsSync' | 'statSync' | 'writeFileSync' | 'renameSync' | 'accessSync' | 'rmSync'>;
}

/** The team folder as configured, or '' when unset. */
export function teamFolder(settings: DesktopSettingsReader): string {
  const value = settings.get<unknown>(TEAM_FOLDER_KEY, '');
  return typeof value === 'string' ? value.trim() : '';
}

export function teamSharingOn(settings: DesktopSettingsReader): boolean {
  return (
    settings.get<unknown>(TEAM_SHARE_ENABLED_KEY, false) === true &&
    typeof settings.get<unknown>(TEAM_CONSENTED_AT_KEY, undefined) === 'number'
  );
}

export function teamAutoExportOn(settings: DesktopSettingsReader): boolean {
  return settings.get<unknown>(TEAM_AUTO_EXPORT_KEY, true) !== false;
}

export function teamPolicy(settings: DesktopSettingsReader) {
  const mode = settings.get<unknown>(TEAM_REPOSITORY_MODE_KEY, 'all');
  const list = settings.get<unknown>(TEAM_REPOSITORIES_KEY, []);
  return buildRepoSyncPolicy(typeof mode === 'string' ? mode : 'all', Array.isArray(list) ? (list as string[]) : []);
}

/** The window every export covers: the last 90 days of COMPLETED 30-minute bins. */
export function exportWindow(nowMs: number): { startMs: number; endMs: number } {
  const endMs = floorToBucketMs(nowMs);
  return { startMs: endMs - TEAM_SHARD_MAX_WINDOW_DAYS * 86_400_000, endMs };
}

interface BuiltShard {
  shard: TeamShard;
  json: string;
  repositories: string[];
}

function buildShard(deps: TeamExportDeps, nowMs: number): BuiltShard {
  const { startMs, endMs } = exportWindow(nowMs);
  const sourceDeps: ShardSourceDeps = {
    db: deps.db,
    sources: deps.sources,
    hidden: deps.hidden,
    policy: teamPolicy(deps.settings),
    ...(deps.repoRootSeams !== undefined ? { repoRootSeams: deps.repoRootSeams } : {}),
  };
  const rows = collectAggregationRows(sourceDeps, startMs, endMs);
  const observations = collectContextObservations(sourceDeps, startMs, endMs);
  const outcomes = collectOutcomes(sourceDeps, startMs, endMs);
  const shard = buildTeamShard({
    rows,
    observations,
    outcomes,
    pseudonymousDeveloperId: deps.developerId(),
    toolVersion: deps.toolVersion(),
    windowStartMs: startMs,
    windowEndMs: endMs,
    generatedAtMs: nowMs,
  });
  const repositories = [...new Set(shard.outcomes.map((o) => o.repository))].sort();
  return { shard, json: JSON.stringify(shard, null, 2), repositories };
}

/** The exact file sharing would write. Previewing is not sharing, so no gate. */
export function previewTeamShard(deps: TeamExportDeps): TeamPreview {
  const now = deps.now?.() ?? Date.now();
  const built = buildShard(deps, now);
  const { startMs, endMs } = exportWindow(now);
  return {
    json: built.json,
    bytes: Buffer.byteLength(built.json, 'utf8'),
    developerId: built.shard.pseudonymousDeveloperId,
    windowStartMs: startMs,
    windowEndMs: endMs,
    repositories: built.repositories,
    bucketCount: built.shard.aggregate.buckets.length,
    contextRowCount: built.shard.contextInsights.rows.length,
    outcomeRowCount: built.shard.outcomes.length,
    shareEnabled: teamSharingOn(deps.settings),
  };
}

/** Write this member's shard into the team folder. Error-as-value. */
export function exportTeamShard(deps: TeamExportDeps): TeamExportResult {
  const io = deps.fs ?? fs;
  const now = deps.now?.() ?? Date.now();
  if (!teamSharingOn(deps.settings)) {
    return { ok: false, error: 'Team sharing is turned off in Settings.' };
  }
  const folder = teamFolder(deps.settings);
  if (folder.length === 0) {
    return { ok: false, error: 'No team folder is set. Choose one under Settings > Team.' };
  }
  let isDirectory = false;
  try {
    isDirectory = io.statSync(folder).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return fail(deps, now, 'The team folder does not exist or is not a folder right now.');
  }
  try {
    io.accessSync(folder, fs.constants.W_OK);
  } catch {
    return fail(deps, now, 'The team folder is not writable.');
  }

  let built: BuiltShard;
  try {
    built = buildShard(deps, now);
  } catch (err) {
    return fail(deps, now, `Could not build the team file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems = validateTeamShard(built.shard, deps.developerId());
  if (problems.length > 0) {
    return fail(deps, now, `Refused to write an invalid team file: ${problems[0]}`);
  }

  const target = path.join(folder, `${built.shard.pseudonymousDeveloperId}.json`);
  const temp = `${target}${TEAM_SHARD_TEMP_SUFFIX}`;
  try {
    io.writeFileSync(temp, built.json, 'utf8');
    io.renameSync(temp, target);
  } catch (err) {
    try {
      io.rmSync(temp, { force: true });
    } catch {
      // best-effort cleanup
    }
    return fail(deps, now, `Could not write the team file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bytes = Buffer.byteLength(built.json, 'utf8');
  deps.state.update({
    lastExportAtMs: now,
    lastExportBytes: bytes,
    lastExportError: undefined,
    lastExportDeveloperId: built.shard.pseudonymousDeveloperId,
  });
  return {
    ok: true,
    path: target,
    bytes,
    bucketCount: built.shard.aggregate.buckets.length,
    contextRowCount: built.shard.contextInsights.rows.length,
    outcomeRowCount: built.shard.outcomes.length,
  };
}

function fail(deps: TeamExportDeps, nowMs: number, error: string): TeamExportResult {
  deps.state.update({ lastExportError: error, lastExportAtMs: nowMs });
  return { ok: false, error };
}
