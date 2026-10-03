import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeShards, type MergedTeam, type ParsedShardFile } from '@agent-observability/core/src/team/teamMerge';
import {
  TEAM_SHARD_FILE_PATTERN,
  TEAM_SHARD_MAX_BYTES,
  type ShardProblem,
  type TeamShard,
} from '@agent-observability/core/src/team/teamShardModels';
import { isUnknownShardVersion, validateTeamShard } from '@agent-observability/core/src/team/teamShardValidator';

/**
 * Reading the team folder, and noticing when it changes.
 *
 * Reading is read-only and always on. Every candidate file is validated with
 * the same rules the server applies before anything is merged; what fails is
 * reported, never dropped quietly. The folder is the source of truth: there
 * is no importer-side cache, so a removed shard removes its member.
 *
 * Watching is poll-first. A stat-diff every minute is the correctness path —
 * it works on SMB shares, OneDrive placeholders and anything else `fs.watch`
 * is unreliable on — and `fs.watch`, when the OS grants it, only shortens the
 * latency with a settle delay so a half-synced file is read once, complete.
 */

export type FolderState = 'ok' | 'missing' | 'unreadable';

export interface TeamFileInfo {
  fileName: string;
  bytes: number;
  mtimeMs: number;
}

export interface TeamFolderRead {
  merged: MergedTeam;
  files: TeamFileInfo[];
  problems: ShardProblem[];
  folderState: FolderState;
}

export interface FolderFs {
  statSync(p: string): { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number };
  readdirSync(p: string): string[];
  readFileSync(p: string, encoding: 'utf8'): string;
  watch?: typeof fs.watch;
}

const defaultFolderFs: FolderFs = {
  statSync: (p) => fs.statSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  watch: fs.watch,
};

export function readTeamFolder(folder: string, io: FolderFs = defaultFolderFs): TeamFolderRead {
  let names: string[];
  try {
    if (!io.statSync(folder).isDirectory()) {
      return empty('missing');
    }
    names = io.readdirSync(folder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return empty(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }

  const parsed: ParsedShardFile[] = [];
  const problems: ShardProblem[] = [];
  const files: TeamFileInfo[] = [];
  for (const fileName of names.filter((n) => TEAM_SHARD_FILE_PATTERN.test(n)).sort()) {
    const full = path.join(folder, fileName);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = io.statSync(full);
      if (!stat.isFile()) {
        continue;
      }
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      problems.push({ fileName, reason: 'unreadable' });
      continue;
    }
    files.push({ fileName, bytes: size, mtimeMs });
    if (size > TEAM_SHARD_MAX_BYTES) {
      problems.push({ fileName, reason: 'too-large', detail: `${size} bytes` });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(io.readFileSync(full, 'utf8'));
    } catch {
      // A placeholder or a file still syncing reads as transient: the next
      // poll resolves it, so the wording says "yet".
      problems.push({ fileName, reason: 'unreadable', detail: 'not readable yet' });
      continue;
    }
    if (isUnknownShardVersion(value)) {
      problems.push({ fileName, reason: 'unknown-schema-version' });
      continue;
    }
    const expectedId = fileName.slice(0, -'.json'.length);
    const errors = validateTeamShard(value, expectedId);
    if (errors.length > 0) {
      const idMismatch = errors.some((e) => /developer id|pseudonymousDeveloperId/i.test(e));
      problems.push({ fileName, reason: idMismatch ? 'id-mismatch' : 'invalid', detail: errors[0] });
      continue;
    }
    parsed.push({ fileName, shard: value as TeamShard, fileBytes: size });
  }

  const merged = mergeShards(parsed);
  return { merged, files, problems: [...problems, ...merged.problems], folderState: 'ok' };
}

function empty(folderState: FolderState): TeamFolderRead {
  return { merged: { members: new Map(), problems: [] }, files: [], problems: [], folderState };
}

/** Injectable timers so tests drive the watcher deterministically. */
export interface WatcherTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: WatcherTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export const TEAM_POLL_MS = 60_000;
export const TEAM_SETTLE_MS = 1_500;

export interface TeamFolderWatcherDeps {
  folder: () => string;
  onChange: () => void;
  io?: FolderFs;
  timers?: WatcherTimers;
  pollMs?: number;
  settleMs?: number;
}

export class TeamFolderWatcher {
  private readonly io: FolderFs;
  private readonly timers: WatcherTimers;
  private poll: unknown;
  private settle: unknown;
  private native: fs.FSWatcher | undefined;
  private fingerprint = '';
  private mode: 'events+poll' | 'poll' | 'off' = 'off';

  constructor(private readonly deps: TeamFolderWatcherDeps) {
    this.io = deps.io ?? defaultFolderFs;
    this.timers = deps.timers ?? defaultTimers;
  }

  watchMode(): 'events+poll' | 'poll' | 'off' {
    return this.mode;
  }

  start(): void {
    this.stop();
    const folder = this.deps.folder();
    if (folder.length === 0) {
      return;
    }
    this.fingerprint = this.snapshot(folder);
    this.poll = this.timers.setInterval(() => this.check(), this.deps.pollMs ?? TEAM_POLL_MS);
    this.mode = 'poll';
    this.armNative(folder);
  }

  stop(): void {
    if (this.poll !== undefined) {
      this.timers.clearInterval(this.poll);
      this.poll = undefined;
    }
    if (this.settle !== undefined) {
      this.timers.clearTimeout(this.settle);
      this.settle = undefined;
    }
    if (this.native !== undefined) {
      try {
        this.native.close();
      } catch {
        // best-effort
      }
      this.native = undefined;
    }
    this.mode = 'off';
  }

  /** Re-stat now (after our own export, say) and fire on a difference. */
  check(): void {
    const folder = this.deps.folder();
    if (folder.length === 0) {
      return;
    }
    const next = this.snapshot(folder);
    if (next !== this.fingerprint) {
      this.fingerprint = next;
      this.deps.onChange();
    }
    // The folder may have appeared since the last attempt.
    if (this.native === undefined && this.mode === 'poll') {
      this.armNative(folder);
    }
  }

  private armNative(folder: string): void {
    if (this.io.watch === undefined) {
      return;
    }
    try {
      const watcher = this.io.watch(folder, { persistent: false }, () => {
        if (this.settle !== undefined) {
          this.timers.clearTimeout(this.settle);
        }
        this.settle = this.timers.setTimeout(() => {
          this.settle = undefined;
          this.check();
        }, this.deps.settleMs ?? TEAM_SETTLE_MS);
      });
      watcher.on('error', () => {
        // ENOSPC, EPERM on a share, ENOENT after removal: fall back to polling.
        try {
          watcher.close();
        } catch {
          // best-effort
        }
        this.native = undefined;
        this.mode = 'poll';
      });
      this.native = watcher;
      this.mode = 'events+poll';
    } catch {
      this.native = undefined;
      this.mode = 'poll';
    }
  }

  /** Names, sizes and mtimes of the candidate files, or the folder's absence. */
  private snapshot(folder: string): string {
    try {
      if (!this.io.statSync(folder).isDirectory()) {
        return 'missing';
      }
      const parts: string[] = [];
      for (const name of this.io.readdirSync(folder).filter((n) => TEAM_SHARD_FILE_PATTERN.test(n)).sort()) {
        try {
          const stat = this.io.statSync(path.join(folder, name));
          parts.push(`${name}:${stat.size}:${stat.mtimeMs}`);
        } catch {
          parts.push(`${name}:?`);
        }
      }
      return parts.join('|');
    } catch {
      return 'missing';
    }
  }
}
