/**
 * File-based durable sink for the **Copilot (Autonomous)** source, under
 * `~/.agent-observability/copilot-agent/`:
 *
 *   raw/<service>/<batchId>.json   raw OTLP/JSON batch, verbatim (re-parseable)
 *   ingest.db                      SQLite spans store ({@link ../otel/ingestStore.IngestStore})
 *   index.json                     watermark + puller status + per-batch cache (versioned)
 *   writer.lock                    the {@link ../otel/writerLease.WriterLease} file (poller-owned)
 *
 * Pure IO over a directory — no `vscode`, no network. The raw batches are kept so
 * a parser-version bump ({@link AGENT_PARSER_VERSION}) can re-derive `ingest.db`
 * without re-pulling. `index.json` is written atomically (tmp + rename) so a
 * reader window's mtime poll never sees partial JSON. The SQLite `ingest.db` is
 * NOT managed here — the puller opens it through `IngestStore` while it holds the
 * writer lease; this class only vends its path and prunes the raw archive.
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
  AGENT_PARSER_VERSION,
  AGENT_SINK_INDEX_VERSION,
  AgentBatchIndexEntry,
  AgentSinkIndex,
} from './agentTypes';

const defaultEnv: ArchiveEnv = {
  homedir: () => os.homedir(),
  env: process.env,
};

/** Home-anchored subdirectory for this source, beside `copilot/` and `copilot-cloud/`. */
const AGENT_SINK_SUBDIR = 'copilot-agent';

/**
 * Resolve the sink directory: `$AGENT_OBSERVABILITY_HOME/copilot-agent/` when the
 * env var is set, else `~/.agent-observability/copilot-agent/`. Returns
 * `undefined` only when no home can be determined (the source then stays inert).
 * Mirrors {@link ../cloud/cloudSink.resolveCloudSinkDir}.
 */
export function resolveAgentSinkDir(env: ArchiveEnv = defaultEnv): string | undefined {
  const base = env.env.AGENT_OBSERVABILITY_HOME;
  if (base !== undefined && base.length > 0) {
    return path.join(base, AGENT_SINK_SUBDIR);
  }
  const home = env.homedir();
  if (home.length > 0) {
    return path.join(home, ARCHIVE_DIR_NAME, AGENT_SINK_SUBDIR);
  }
  return undefined;
}

/** A fresh, empty index at the current schema / parser versions. */
export function freshAgentIndex(): AgentSinkIndex {
  return {
    version: AGENT_SINK_INDEX_VERSION,
    parserVersion: AGENT_PARSER_VERSION,
    watermarkMs: 0,
    puller: { lastPullAtMs: 0, firstPullCompleted: false, lastOutcome: 'ok' },
    batches: {},
  };
}

export class AgentSink {
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
  /** Path of the SQLite spans store the puller writes and the source reads via snapshot. */
  ingestDbPath(): string {
    return path.join(this.rootDir, 'ingest.db');
  }
  private rawDir(): string {
    return path.join(this.rootDir, 'raw');
  }
  private rawServiceDir(service: string): string {
    return path.join(this.rawDir(), safeName(service));
  }
  private rawBatchPath(service: string, batchId: string): string {
    return path.join(this.rawServiceDir(service), `${safeName(batchId)}.json`);
  }

  /** Create the directory tree. Safe to call repeatedly. */
  ensureDirs(): void {
    mkdirSync(this.rawDir(), { recursive: true });
  }

  // ---- raw OTLP batches ----

  writeBatchRaw(service: string, batchId: string, json: string): void {
    mkdirSync(this.rawServiceDir(service), { recursive: true });
    writeFileSync(this.rawBatchPath(service, batchId), json, 'utf8');
  }
  readBatchRaw(service: string, batchId: string): string | undefined {
    return readIfExists(this.rawBatchPath(service, batchId));
  }
  hasBatchRaw(service: string, batchId: string): boolean {
    return existsSync(this.rawBatchPath(service, batchId));
  }

  // ---- versioned index ----

  /** Read the index, or a fresh empty one when missing / corrupt / version-mismatched. */
  readIndex(): AgentSinkIndex {
    const raw = readIfExists(this.indexPath());
    if (raw === undefined) {
      return freshAgentIndex();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AgentSinkIndex>;
      if (parsed.version !== AGENT_SINK_INDEX_VERSION || parsed.parserVersion !== AGENT_PARSER_VERSION) {
        // Schema / parser bump: drop the derived cache; the raw batches persist and
        // are re-pulled/re-derived on the next poll.
        return freshAgentIndex();
      }
      return {
        version: AGENT_SINK_INDEX_VERSION,
        parserVersion: AGENT_PARSER_VERSION,
        watermarkMs: typeof parsed.watermarkMs === 'number' ? parsed.watermarkMs : 0,
        puller: parsed.puller ?? freshAgentIndex().puller,
        batches: parsed.batches ?? {},
      };
    } catch {
      return freshAgentIndex();
    }
  }
  writeIndex(index: AgentSinkIndex): void {
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

  /** The recorded batch entries, newest first. */
  listBatchEntries(): AgentBatchIndexEntry[] {
    return Object.values(this.readIndex().batches).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /**
   * Prune index entries (and their raw batch files) whose landing time is older
   * than `retentionMs`, matching the ingest DB's own span prune so raw prompts /
   * tool I/O never outlive retention on disk. Returns the number of entries
   * pruned; the index is rewritten only when something changed.
   */
  pruneRaw(retentionMs: number, nowMs: number): number {
    const index = this.readIndex();
    const cutoff = nowMs - retentionMs;
    let pruned = 0;
    for (const [batchId, entry] of Object.entries(index.batches)) {
      if (entry.createdAtMs >= cutoff) {
        continue;
      }
      removeIfExists(this.rawBatchPath(entry.service, entry.batchId));
      delete index.batches[batchId];
      pruned++;
    }
    if (pruned > 0) {
      this.writeIndex(index);
    }
    // Reclaim ORPHANED raw files older than the window — files no longer
    // referenced by ANY index entry (left behind when the index was reset by a
    // parserVersion bump / corruption). Orphans NEWER than the cutoff are kept —
    // a still-pending batch may be re-referenced on the next poll.
    const referenced = new Set<string>();
    for (const entry of Object.values(index.batches)) {
      referenced.add(this.rawBatchPath(entry.service, entry.batchId));
    }
    this.sweepOrphans(referenced, cutoff);
    return pruned;
  }

  /** Delete raw files not referenced by the index and older than `cutoff`. */
  private sweepOrphans(referenced: ReadonlySet<string>, cutoff: number): void {
    let services: string[];
    try {
      services = readdirSync(this.rawDir());
    } catch {
      return;
    }
    for (const service of services) {
      const serviceDir = path.join(this.rawDir(), service);
      let files: string[];
      try {
        files = readdirSync(serviceDir);
      } catch {
        continue;
      }
      for (const name of files) {
        const full = path.join(serviceDir, name);
        if (referenced.has(full)) {
          continue;
        }
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
}

/** A filesystem-safe basename derived from an id (ids are opaque, but be safe). */
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
