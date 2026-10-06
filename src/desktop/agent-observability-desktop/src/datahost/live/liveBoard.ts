import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import {
  classifyTranscriptFile,
  defaultFs,
  discoverClaudeSessions,
  resolveClaudeProjectsDirs,
  type ClaudeFs,
} from '@agent-observability/core/src/claude/paths';
import { readTranscriptTail, type TranscriptTail } from '@agent-observability/core/src/claude/transcriptTail';
import {
  LIVE_FINISHED_MS,
  LIVE_IDLE_MS,
  LIVE_STATUS_ORDER,
  deriveLiveStatus,
  deriveTailFacts,
  type LiveTailFacts,
} from '@agent-observability/core/src/live/liveStatus';
import { ClaudeWatcher, type FileWatchFactory, type WatchHandle } from '@agent-observability/core/src/live/claudeWatcher';
import { LiveUpdateController } from '@agent-observability/core/src/live/liveUpdateController';
import type { LiveSource } from '@agent-observability/core/src/live/liveSource';
import type { LiveBoardSnapshot, LiveSessionRow, LiveStatus, RpcEvent, RunLiveState, SessionRow } from '../../shared/rpc';
import { sessionKey } from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import { pickCopilotDatabases } from '../indexer/copilotIndexer';
import { readCliEventsTail, readWorkspaceYaml, type CliEventsTail } from '@agent-observability/core/src/copilotCli/events';
import { deriveCliLive, resolveCliRepository } from '@agent-observability/core/src/copilotCli/mapper';
import {
  copilotHelperCwd,
  copilotSessionStateDir,
  discoverCopilotCliSessions,
  type CopilotCliSessionFiles,
} from '@agent-observability/core/src/copilotCli/paths';
import { fsWatchFactory } from './fsWatchFactory';

/**
 * The live board: which sessions are active on this machine right now and
 * what each is doing, derived from the TAIL of its own transcript. Nothing is
 * installed into Claude Code or Copilot (no hooks, no exporters): the agents
 * already write these files, so watching them is enough.
 *
 * Two clocks drive it. A file watch (core's `ClaudeWatcher` behind
 * {@link fsWatchFactory}) debounces bursts into one recompute, so a card flips
 * within about a second of the agent writing. A slow tick re-derives statuses
 * that change with time alone (working → idle → finished), since no file
 * write marks a session going quiet.
 *
 * The same events also drive a quiet-period re-index, so the list and the
 * dashboard pick up the changed transcript without the user pressing Refresh.
 * The re-index is REQUESTED, never awaited: the board's own status comes from
 * the tail read and needs no index pass.
 *
 * Status is heuristic and hook-free. A tool call waiting for permission looks
 * exactly like a tool call running; the renderer hints at that after
 * `PENDING_TOOL_HINT_MS`, and the proposal documents the limit.
 */

/** Settings key for the renderer's notification toggle (OFF by default). */
export const LIVE_NOTIFICATIONS_KEY = 'workspace.notifications';

/** Coalesce a burst of file events into one recompute. */
export const LIVE_DEBOUNCE_MS = 750;
/** Re-derive time-based statuses this often even with no file activity. */
export const LIVE_TICK_MS = 30_000;
/** Ask for an index pass once a transcript has been quiet this long. */
export const LIVE_REINDEX_QUIET_MS = 10_000;
/** A finished session leaves the board this long after its last activity. */
export const LIVE_DROP_MS = 60 * 60_000;
/** Copilot rows the board considers; the index is the only signal for them. */
const COPILOT_LIVE_LIMIT = 100;

interface Candidate {
  sessionId: string;
  path: string;
}

interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Injectable timers so tests drive the board deterministically. */
export interface LiveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LiveBoardDeps {
  db: Pick<IndexDb, 'getRow' | 'getCachedRepository' | 'listSessions'>;
  config: Configuration;
  hidden: { all(): string[]; isHidden(source: string, sessionId: string): boolean };
  renames: { apply(rows: SessionRow[]): SessionRow[] };
  emit: (event: RpcEvent) => void;
  /** Ask the indexer for a pass; idempotent and coalescing on the caller's side. */
  requestIndex: () => void;
  // ── seams ──
  claudeFs?: ClaudeFs;
  readTail?: (file: string) => TranscriptTail | undefined;
  statFile?: (file: string) => FileStat | undefined;
  now?: () => number;
  factories?: { transcripts: FileWatchFactory; databases: FileWatchFactory };
  timers?: LiveTimers;
  /** Copilot database files to watch; defaults to the indexer's own picks. */
  copilotDatabases?: () => string[];
  /**
   * Sessions the app itself is hosting (Run). Their status comes from the
   * session's own events rather than from the tail of a file, so it replaces
   * the disk-inferred row for the same session id and is exact.
   */
  hosted?: () => RunLiveState[];
  /** Copilot CLI seams: session discovery, events tail, workspace reader, watch root. */
  copilotCliSessions?: () => CopilotCliSessionFiles[];
  readCliTail?: (file: string) => CliEventsTail | undefined;
  readCliWorkspace?: (file: string) => Record<string, string>;
  copilotCliRoot?: () => string;
  copilotCliHelperCwd?: () => string;
}

const defaultTimers: LiveTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function defaultStat(file: string): FileStat | undefined {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

export class LiveBoardService {
  private readonly candidates = new Map<string, Candidate>();
  private readonly timers: LiveTimers;
  private readonly now: () => number;
  private readonly readTail: (file: string) => TranscriptTail | undefined;
  private readonly statFile: (file: string) => FileStat | undefined;
  private readonly factories: { transcripts: FileWatchFactory; databases: FileWatchFactory };
  private controller: LiveUpdateController | undefined;
  private tick: unknown;
  private quiet: unknown;
  private last: LiveBoardSnapshot | undefined;
  private fingerprint = '';
  private watching = false;
  private watchedDirs = 0;
  private note: string | undefined;
  private started = false;

  constructor(private readonly deps: LiveBoardDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.now = deps.now ?? (() => Date.now());
    this.readTail = deps.readTail ?? ((file) => readTranscriptTail(file));
    this.statFile = deps.statFile ?? defaultStat;
    this.factories = deps.factories ?? {
      transcripts: fsWatchFactory({ recursive: true, extension: '.jsonl' }),
      databases: fsWatchFactory({ recursive: false }),
    };
  }

  /** Idempotent: the first index pass to settle starts the board. */
  ensureStarted(): void {
    if (!this.started) {
      this.start();
    }
  }

  start(): void {
    this.started = true;
    this.candidates.clear();
    this.watching = false;
    this.watchedDirs = 0;
    this.note = undefined;

    const controller = new LiveUpdateController({
      debounceMs: LIVE_DEBOUNCE_MS,
      onRefresh: () => this.recompute(),
      onError: () => undefined,
    });
    this.controller = controller;

    if (this.deps.config.isClaudeEnabled()) {
      this.seedCandidates();
      const transcripts: FileWatchFactory = {
        watch: (dir, onEvent) =>
          this.factories.transcripts.watch(dir, (changed) => {
            this.noteTranscriptEvent(dir, changed);
            onEvent(changed);
          }),
      };
      controller.register(
        new ClaudeWatcher({
          resolveDirs: () => resolveClaudeProjectsDirs(this.deps.config, this.deps.claudeFs ?? defaultFs),
          factory: transcripts,
          signal: () => controller.signal(),
          onWatching: (dirs) => {
            this.watchedDirs = dirs.length;
            this.watching = dirs.length > 0;
          },
          onError: (err) => {
            this.note = `Live updates are degraded: ${err instanceof Error ? err.message : String(err)}`;
          },
        }),
      );
    } else {
      this.note = 'Claude Code is turned off in Settings, so no live transcripts are watched.';
    }

    if (this.deps.config.isLocalTelemetryEnabled()) {
      controller.register(this.copilotSource(controller));
    }
    if (this.deps.config.isCopilotCliEnabled()) {
      controller.register(this.copilotCliSource(controller));
    }

    void controller.start();
    this.tick = this.timers.setInterval(() => this.recompute(), LIVE_TICK_MS);
    this.recompute();
  }

  stop(): void {
    this.started = false;
    this.controller?.stop();
    this.controller = undefined;
    if (this.tick !== undefined) {
      this.timers.clearInterval(this.tick);
      this.tick = undefined;
    }
    if (this.quiet !== undefined) {
      this.timers.clearTimeout(this.quiet);
      this.quiet = undefined;
    }
  }

  /** Sources or paths changed in Settings: watch the new set. */
  restart(): void {
    this.stop();
    this.start();
  }

  /** A hosted session changed status: reflect it now rather than at the next tick. */
  onHostedChanged(): void {
    if (this.started) {
      this.recompute();
    }
  }

  /** The index just settled: token and cost figures may have moved. */
  onIndexSettled(): void {
    if (this.started) {
      this.recompute();
    }
  }

  snapshot(): LiveBoardSnapshot {
    return this.last ?? this.recompute();
  }

  // ── internals ──

  private seedCandidates(): void {
    const now = this.now();
    let sessions;
    try {
      sessions = discoverClaudeSessions(this.deps.config, this.deps.claudeFs ?? defaultFs);
    } catch {
      return;
    }
    for (const session of sessions) {
      if (session.mainFile === undefined || now - session.mtimeMs >= LIVE_DROP_MS) {
        continue;
      }
      this.candidates.set(path.normalize(session.mainFile), {
        sessionId: session.sessionId,
        path: session.mainFile,
      });
    }
  }

  private noteTranscriptEvent(root: string, changed: string): void {
    const classified = classifyTranscriptFile(root, changed);
    if (classified === undefined) {
      return;
    }
    if (classified.kind === 'main') {
      const key = path.normalize(changed);
      if (!this.candidates.has(key)) {
        this.candidates.set(key, { sessionId: classified.sessionId, path: changed });
      }
    }
    this.armReindex();
  }

  /** One index pass once the transcript has been quiet for a moment. */
  private armReindex(): void {
    if (this.quiet !== undefined) {
      this.timers.clearTimeout(this.quiet);
    }
    this.quiet = this.timers.setTimeout(() => {
      this.quiet = undefined;
      this.deps.requestIndex();
    }, LIVE_REINDEX_QUIET_MS);
  }

  private copilotSource(controller: LiveUpdateController): LiveSource {
    const handles: WatchHandle[] = [];
    const files = (): string[] => {
      const picked = this.deps.copilotDatabases?.() ?? pickCopilotDatabases(this.deps.config).map((c) => c.path);
      return picked.flatMap((p) => [p, `${p}-wal`]);
    };
    return {
      label: 'Copilot database watcher',
      start: () => {
        for (const file of files()) {
          if (this.statFile(file) === undefined) {
            continue;
          }
          try {
            handles.push(
              this.factories.databases.watch(file, () => {
                this.armReindex();
                controller.signal();
              }),
            );
          } catch {
            // A database that cannot be watched still updates on the tick.
          }
        }
      },
      stop: () => {
        for (const handle of handles) {
          try {
            handle.dispose();
          } catch {
            // best-effort
          }
        }
        handles.length = 0;
      },
    };
  }

  /** Watches the Copilot CLI's session store; its events files end in `.jsonl` too. */
  private copilotCliSource(controller: LiveUpdateController): LiveSource {
    let handle: WatchHandle | undefined;
    return {
      label: 'Copilot CLI session watcher',
      start: () => {
        try {
          handle = this.factories.transcripts.watch(this.deps.copilotCliRoot?.() ?? copilotSessionStateDir(), () => {
            this.armReindex();
            controller.signal();
          });
        } catch {
          // No store yet, or it cannot be watched: the tick still covers it.
        }
      },
      stop: () => {
        try {
          handle?.dispose();
        } catch {
          // best-effort
        }
        handle = undefined;
      },
    };
  }

  /** Copilot CLI sessions written to recently, with status from the events tail. */
  private copilotCliRows(now: number): LiveSessionRow[] {
    let sessions: CopilotCliSessionFiles[];
    try {
      sessions = this.deps.copilotCliSessions?.() ?? discoverCopilotCliSessions();
    } catch {
      return [];
    }
    const helperCwd = normalizeDir(this.deps.copilotCliHelperCwd?.() ?? copilotHelperCwd());
    const rows: LiveSessionRow[] = [];
    for (const files of sessions) {
      if (now - files.mtimeMs >= LIVE_DROP_MS || this.deps.hidden.isHidden('copilot-cli', files.sessionId)) {
        continue;
      }
      const workspace = (this.deps.readCliWorkspace ?? readWorkspaceYaml)(files.workspaceFile);
      // The app's own helper runs share this store; they are not sessions.
      if (workspace.cwd !== undefined && normalizeDir(workspace.cwd) === helperCwd) {
        continue;
      }
      const tail = (this.deps.readCliTail ?? ((file: string) => readCliEventsTail(file)))(files.eventsFile);
      if (tail === undefined) {
        continue;
      }
      const { facts, status, awaitingApproval } = deriveCliLive(tail.events, files.mtimeMs, now);
      const indexed = this.deps.db.getRow('copilot-cli', files.sessionId);
      const [row] = indexed === undefined ? [undefined] : this.deps.renames.apply([indexed]);
      const title = row?.title ?? workspace.name ?? workspace.summary;
      rows.push({
        source: 'copilot-cli',
        sessionId: files.sessionId,
        repository: row?.repository ?? resolveCliRepository(workspace, []),
        ...(title !== undefined ? { title } : {}),
        status,
        lastEvent: facts.lastEvent,
        startedAtMs: row?.startedAtMs ?? facts.lastActivityMs,
        lastActivityMs: facts.lastActivityMs,
        ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
        pendingTools: facts.pendingTools,
        ...(facts.model !== undefined ? { model: facts.model } : {}),
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        ...(row?.costMicros !== undefined ? { costMicros: row.costMicros } : {}),
        countsIndexedAtMs: row?.indexedAtMs ?? 0,
        ...(facts.lastToolFailed === true ? { lastToolFailed: true } : {}),
        ...(awaitingApproval ? { exactPermission: true } : {}),
      });
    }
    return rows;
  }

  private recompute(): LiveBoardSnapshot {
    const now = this.now();
    const rows: LiveSessionRow[] = [];
    if (this.deps.config.isCopilotCliEnabled()) {
      rows.push(...this.copilotCliRows(now));
    }

    for (const [key, candidate] of [...this.candidates]) {
      if (this.deps.hidden.isHidden('claude', candidate.sessionId)) {
        continue;
      }
      const stat = this.statFile(candidate.path);
      if (stat === undefined || now - stat.mtimeMs >= LIVE_DROP_MS) {
        this.candidates.delete(key);
        continue;
      }
      if (now - stat.mtimeMs >= LIVE_FINISHED_MS) {
        rows.push(
          this.claudeRow(
            candidate,
            { lastActivityMs: stat.mtimeMs, lastEvent: 'unknown', pendingTools: [] },
            'finished',
          ),
        );
        continue;
      }
      const tail = this.readTail(candidate.path);
      if (tail === undefined) {
        continue;
      }
      const facts = deriveTailFacts(tail.records, stat.mtimeMs);
      rows.push(this.claudeRow(candidate, facts, deriveLiveStatus(facts, now)));
    }

    if (this.deps.config.isLocalTelemetryEnabled()) {
      let copilot: SessionRow[] = [];
      try {
        copilot = this.deps.db.listSessions(
          { source: 'copilot', endedAfterMs: now - LIVE_DROP_MS, limit: COPILOT_LIVE_LIMIT },
          this.deps.hidden.all(),
        );
      } catch {
        copilot = [];
      }
      for (const row of this.deps.renames.apply(copilot)) {
        const age = now - row.endedAtMs;
        const status: LiveStatus = age < LIVE_IDLE_MS ? 'working' : age < LIVE_FINISHED_MS ? 'idle' : 'finished';
        rows.push({
          source: row.source,
          sessionId: row.sessionId,
          repository: row.repository,
          ...(row.title !== undefined ? { title: row.title } : {}),
          status,
          lastEvent: 'unknown',
          startedAtMs: row.startedAtMs,
          lastActivityMs: row.endedAtMs,
          pendingTools: [],
          ...(row.model !== 'unknown' ? { model: row.model } : {}),
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          ...(row.costMicros !== undefined ? { costMicros: row.costMicros } : {}),
          countsIndexedAtMs: row.indexedAtMs,
        });
      }
    }

    applyHosted(rows, this.deps.hosted?.() ?? []);

    rows.sort((a, b) => {
      const order = LIVE_STATUS_ORDER.indexOf(a.status) - LIVE_STATUS_ORDER.indexOf(b.status);
      return order !== 0 ? order : b.lastActivityMs - a.lastActivityMs;
    });

    const snapshot: LiveBoardSnapshot = {
      rows,
      generatedAtMs: now,
      watching: this.watching,
      watchedDirs: this.watchedDirs,
      idleMs: LIVE_IDLE_MS,
      finishedMs: LIVE_FINISHED_MS,
      ...(this.note !== undefined ? { note: this.note } : {}),
    };
    this.last = snapshot;

    // Emit only on a real change: the tick fires every 30 s whether or not
    // anything moved, and the renderer must not re-render for nothing.
    const fingerprint = JSON.stringify(
      rows.map((r) => [sessionKey(r.source, r.sessionId), r.status, r.lastActivityMs, r.lastEvent, r.inputTokens, r.outputTokens, r.pendingTools]),
    ) + `|${this.watching}|${this.note ?? ''}`;
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.deps.emit({ event: 'workspace.live', snapshot });
    }
    return snapshot;
  }

  private claudeRow(candidate: Candidate, facts: LiveTailFacts, status: LiveStatus): LiveSessionRow {
    const indexed = this.deps.db.getRow('claude', candidate.sessionId);
    const [row] = indexed === undefined ? [undefined] : this.deps.renames.apply([indexed]);
    const title = row?.title ?? facts.aiTitle;
    const repository =
      row?.repository ??
      (facts.cwd !== undefined ? this.deps.db.getCachedRepository(facts.cwd) : undefined) ??
      'unknown';
    const model = facts.model ?? (row !== undefined && row.model !== 'unknown' ? row.model : undefined);
    return {
      source: 'claude',
      sessionId: candidate.sessionId,
      repository,
      ...(title !== undefined ? { title } : {}),
      status,
      lastEvent: facts.lastEvent,
      startedAtMs: row?.startedAtMs ?? facts.lastActivityMs,
      lastActivityMs: facts.lastActivityMs,
      ...(facts.gitBranch !== undefined ? { branch: facts.gitBranch } : {}),
      pendingTools: facts.pendingTools,
      ...(model !== undefined ? { model } : {}),
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      ...(row?.costMicros !== undefined ? { costMicros: row.costMicros } : {}),
      countsIndexedAtMs: row?.indexedAtMs ?? 0,
      ...(facts.lastToolFailed === true ? { lastToolFailed: true } : {}),
    };
  }
}

function normalizeDir(dir: string): string {
  const normalized = path.normalize(dir).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Overlay hosted (Run) sessions onto the board's rows, in place.
 *
 * A hosted session is also a Copilot CLI session on disk, so the disk-derived
 * row usually exists already: it keeps its title, repository and token
 * figures and takes the exact status. A session too new to be on disk yet is
 * left for the next index pass rather than invented here.
 */
export function applyHosted(rows: LiveSessionRow[], hosted: readonly RunLiveState[]): void {
  for (const state of hosted) {
    const row = rows.find((r) => r.source === 'copilot-cli' && r.sessionId === state.sessionId);
    if (row === undefined) {
      continue;
    }
    row.hosted = true;
    if (state.status === 'stopped' || state.status === 'error') {
      continue;
    }
    row.lastActivityMs = Math.max(row.lastActivityMs, state.lastActivityMs);
    row.pendingTools = state.pendingTools;
    delete row.exactPermission;
    if (state.status === 'waiting-approval') {
      row.status = 'waiting';
      row.lastEvent = 'tool-pending';
      row.exactPermission = true;
    } else if (state.status === 'waiting-input' || state.status === 'idle') {
      row.status = 'waiting';
      row.lastEvent = 'turn-ended';
    } else {
      row.status = 'working';
    }
  }
}
