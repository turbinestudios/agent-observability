/**
 * File-based durable sink for the Copilot (Cloud) source, under
 * `~/.agent-observability/copilot-cloud/` (Claude-pattern, not SQLite — volumes
 * are low and raw retention lets us re-parse when the preview format drifts):
 *
 *   tasks/<taskId>.json   raw REST task-detail payload
 *   logs/<sessionId>.sse  raw CAPI SSE, immutable once the session is terminal
 *   repos.json            repoId → owner/repo cache (ids are immutable)
 *   index.json            watermark + poller status + parsed-summary cache (versioned)
 *   writer.lock           the WriterLease file (owned by the poller)
 *
 * Pure IO over a directory — no `vscode`, no network. `index.json` is written
 * atomically (tmp + rename) so a reader window's `fs.watch` never sees a partial
 * JSON. A parser-version bump ({@link CLOUD_PARSER_VERSION}) invalidates only the
 * derived index; the raw files persist and are re-parsed.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ARCHIVE_DIR_NAME, ArchiveEnv } from '../otel/archivePaths';
import {
  CLOUD_PARSER_VERSION,
  CLOUD_SINK_INDEX_VERSION,
  CloudRepoRef,
  CloudTaskIndexEntry,
  SinkIndex,
} from './cloudTypes';

const defaultEnv: ArchiveEnv = {
  homedir: () => os.homedir(),
  env: process.env,
};

/**
 * Resolve the sink directory: `$AGENT_OBSERVABILITY_HOME/copilot-cloud/` if the
 * env var is set, else `~/.agent-observability/copilot-cloud/`. Returns
 * `undefined` only when no home can be determined (source then stays inert).
 * Mirrors {@link ../otel/archivePaths.resolveArchiveDbPath}.
 */
export function resolveCloudSinkDir(env: ArchiveEnv = defaultEnv): string | undefined {
  const base = env.env.AGENT_OBSERVABILITY_HOME;
  if (base !== undefined && base.length > 0) {
    return path.join(base, 'copilot-cloud');
  }
  const home = env.homedir();
  if (home.length > 0) {
    return path.join(home, ARCHIVE_DIR_NAME, 'copilot-cloud');
  }
  return undefined;
}

/** A fresh, empty index at the current schema/parser versions. */
export function freshIndex(): SinkIndex {
  return {
    version: CLOUD_SINK_INDEX_VERSION,
    parserVersion: CLOUD_PARSER_VERSION,
    watermarkMs: 0,
    poller: { lastPollAtMs: 0, firstPollCompleted: false, accounts: [] },
    tasks: {},
  };
}

export class CloudSink {
  constructor(private readonly rootDir: string) {}

  dir(): string {
    return this.rootDir;
  }
  lockPath(): string {
    return path.join(this.rootDir, 'writer.lock');
  }
  indexPath(): string {
    return path.join(this.rootDir, 'index.json');
  }
  private tasksDir(): string {
    return path.join(this.rootDir, 'tasks');
  }
  private logsDir(): string {
    return path.join(this.rootDir, 'logs');
  }
  private reposPath(): string {
    return path.join(this.rootDir, 'repos.json');
  }

  /** Create the directory tree. Safe to call repeatedly. */
  ensureDirs(): void {
    mkdirSync(this.tasksDir(), { recursive: true });
    mkdirSync(this.logsDir(), { recursive: true });
  }

  // ---- raw task payloads ----

  writeTaskRaw(taskId: string, json: string): void {
    this.ensureDirs();
    writeFileSync(path.join(this.tasksDir(), `${safeName(taskId)}.json`), json, 'utf8');
  }
  readTaskRaw(taskId: string): string | undefined {
    return readIfExists(path.join(this.tasksDir(), `${safeName(taskId)}.json`));
  }

  // ---- raw session SSE logs ----

  writeSessionLog(sessionId: string, sse: string): void {
    this.ensureDirs();
    writeFileSync(path.join(this.logsDir(), `${safeName(sessionId)}.sse`), sse, 'utf8');
  }
  readSessionLog(sessionId: string): string | undefined {
    return readIfExists(path.join(this.logsDir(), `${safeName(sessionId)}.sse`));
  }
  hasSessionLog(sessionId: string): boolean {
    return existsSync(path.join(this.logsDir(), `${safeName(sessionId)}.sse`));
  }

  // ---- repo cache ----

  readRepos(): CloudRepoRef[] {
    const raw = readIfExists(this.reposPath());
    if (raw === undefined) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as CloudRepoRef[]).filter(isRepoRef) : [];
    } catch {
      return [];
    }
  }
  writeRepos(refs: readonly CloudRepoRef[]): void {
    this.ensureDirs();
    atomicWrite(this.reposPath(), JSON.stringify(refs));
  }

  // ---- versioned index ----

  /** Read the index, or a fresh empty one when missing / corrupt / version-mismatched. */
  readIndex(): SinkIndex {
    const raw = readIfExists(this.indexPath());
    if (raw === undefined) {
      return freshIndex();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SinkIndex>;
      if (parsed.version !== CLOUD_SINK_INDEX_VERSION || parsed.parserVersion !== CLOUD_PARSER_VERSION) {
        // Schema / parser bump: drop the derived cache; raw files persist and are
        // re-derived on the next poll.
        return freshIndex();
      }
      return {
        version: CLOUD_SINK_INDEX_VERSION,
        parserVersion: CLOUD_PARSER_VERSION,
        watermarkMs: typeof parsed.watermarkMs === 'number' ? parsed.watermarkMs : 0,
        poller: parsed.poller ?? freshIndex().poller,
        tasks: parsed.tasks ?? {},
      };
    } catch {
      return freshIndex();
    }
  }
  writeIndex(index: SinkIndex): void {
    this.ensureDirs();
    atomicWrite(this.indexPath(), JSON.stringify(index));
  }
  /** Mtime (ms) of index.json for the source's cheap change detection, or 0. */
  indexMtimeMs(): number {
    try {
      return statSync(this.indexPath()).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Convenience: the parsed-summary task entries, newest first. */
  listTaskEntries(): CloudTaskIndexEntry[] {
    return Object.values(this.readIndex().tasks).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /**
   * Prune task entries (and their raw task/log files) older than `retentionMs`.
   * Returns the number of tasks pruned. The index is rewritten when anything changed.
   */
  prune(retentionMs: number, nowMs: number): number {
    const index = this.readIndex();
    const cutoff = nowMs - retentionMs;
    let pruned = 0;
    for (const [taskId, entry] of Object.entries(index.tasks)) {
      if (entry.updatedAtMs >= cutoff) {
        continue;
      }
      removeIfExists(path.join(this.tasksDir(), `${safeName(taskId)}.json`));
      for (const sessionId of entry.sessionIds) {
        removeIfExists(path.join(this.logsDir(), `${safeName(sessionId)}.sse`));
      }
      delete index.tasks[taskId];
      pruned++;
    }
    if (pruned > 0) {
      this.writeIndex(index);
    }
    // Reclaim ORPHANED raw files older than the retention window — files no longer
    // referenced by ANY index entry (e.g. left behind when the index was reset by a
    // parserVersion bump / corruption). Without this, their raw prompts / diffs /
    // tool I/O would outlive retention on disk. Orphans NEWER than the cutoff are
    // kept — a still-active task will re-reference them on the next poll.
    const referenced = new Set<string>();
    for (const entry of Object.values(index.tasks)) {
      referenced.add(`${safeName(entry.taskId)}.json`);
      for (const sessionId of entry.sessionIds) {
        referenced.add(`${safeName(sessionId)}.sse`);
      }
    }
    this.sweepOrphans(this.tasksDir(), referenced, cutoff);
    this.sweepOrphans(this.logsDir(), referenced, cutoff);
    return pruned;
  }

  /** Delete files in `dir` not referenced by the index and older than `cutoff`. */
  private sweepOrphans(dir: string, referenced: ReadonlySet<string>, cutoff: number): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (referenced.has(name)) {
        continue;
      }
      const full = path.join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) {
        removeIfExists(full);
      }
    }
  }
}

/** A filesystem-safe basename derived from an id (ids are uuids/opaque, but be safe). */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function removeIfExists(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort
  }
}

/** Write atomically (tmp + rename) so a concurrent reader never sees partial JSON. */
function atomicWrite(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

function isRepoRef(value: unknown): value is CloudRepoRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as CloudRepoRef).id === 'number' &&
    typeof (value as CloudRepoRef).owner === 'string' &&
    typeof (value as CloudRepoRef).name === 'string'
  );
}
