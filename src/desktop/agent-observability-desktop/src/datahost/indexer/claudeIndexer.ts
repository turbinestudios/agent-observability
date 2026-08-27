import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { discoverClaudeSessions, defaultFs } from '@agent-observability/core/src/claude/paths';
import type { ClaudeFs, ClaudeSessionFiles } from '@agent-observability/core/src/claude/paths';
import { parseTranscriptText } from '@agent-observability/core/src/claude/parser';
import { buildSessionSummary } from '@agent-observability/core/src/claude/mapper';
import { GitRemoteResolver } from '@agent-observability/core/src/claude/gitRemote';
import type { TranscriptRecord } from '@agent-observability/core/src/claude/transcript';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SessionRow } from '../../shared/rpc';
import type { IndexDb } from './indexDb';

/**
 * Builds and maintains the Claude Code slice of the session index.
 *
 * The extension pays the full cost of reading and parsing every recent
 * transcript before it can draw a single list row. This splits that in two:
 *
 *  1. DISCOVERY is a readdir/stat walk that yields ids and mtimes, and is
 *     written straight to the index as placeholder rows. The list can paint a
 *     complete, correctly-ordered set of sessions from this alone.
 *  2. HYDRATION parses transcripts newest-first and replaces each placeholder
 *     with real counts, streaming rows out as they land.
 *
 * Because both stages persist, the second run of the app skips almost all of it:
 * a file whose size, mtime, and head hash are unchanged is never reopened.
 */

/** Bytes hashed from the head of a file to detect rewrite-in-place. */
const HEAD_HASH_BYTES = 1024;

/** Sessions hydrated per batch before results are flushed to the callback. */
const HYDRATE_BATCH = 20;

export interface ClaudeIndexerDeps {
  db: IndexDb;
  config: Configuration;
  /** Called with rows whenever a batch is written, for live UI updates. */
  onRows?: (rows: SessionRow[]) => void;
  /** Called after discovery so the UI can show a total before hydration. */
  onDiscovered?: (total: number) => void;
  /**
   * Filesystem seam used for discovery. Note that a configured projects path is
   * additive rather than exclusive in core — the home directory is always also
   * scanned — so overriding this is the only way to confine a scan.
   */
  fs?: ClaudeFs;
  now?: () => number;
}

export class ClaudeIndexer {
  private readonly gitResolver = new GitRemoteResolver();
  private readonly now: () => number;
  private readonly fs: ClaudeFs;

  constructor(private readonly deps: ClaudeIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fs = deps.fs ?? defaultFs;
  }

  /**
   * Bring the index up to date. Returns the number of sessions hydrated in this
   * pass — zero means everything was already current.
   */
  run(): { discovered: number; hydrated: number } {
    if (!this.deps.config.isClaudeEnabled()) {
      return { discovered: 0, hydrated: 0 };
    }

    const sessions = discoverClaudeSessions(this.deps.config, this.fs);
    this.deps.onDiscovered?.(sessions.length);

    // Placeholders first: ordering only needs mtime, which discovery already
    // has, so the list is complete and correctly sorted before any parsing.
    this.writePlaceholders(sessions);

    // Sessions gone from disk should leave the list rather than linger.
    const present = new Set(sessions.map((s) => s.sessionId));
    this.deps.db.removeMissing('claude', present);

    const stale = sessions.filter((s) => this.needsHydration(s));
    // Newest first: the sessions a user is most likely to open become real
    // rows soonest, and an interrupted pass still leaves the top of the list good.
    stale.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let hydrated = 0;
    let batch: SessionRow[] = [];
    for (const session of stale) {
      const row = this.hydrate(session);
      if (row === undefined) {
        continue;
      }
      batch.push(row);
      hydrated += 1;
      if (batch.length >= HYDRATE_BATCH) {
        this.flush(batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      this.flush(batch);
    }
    return { discovered: sessions.length, hydrated };
  }

  private flush(batch: SessionRow[]): void {
    this.deps.db.upsertSessions(batch);
    this.deps.onRows?.(batch);
  }

  /** Insert discovery-only rows for sessions the index has never seen. */
  private writePlaceholders(sessions: ClaudeSessionFiles[]): void {
    const rows: SessionRow[] = [];
    for (const session of sessions) {
      if (this.deps.db.getRow('claude', session.sessionId) !== undefined) {
        continue;
      }
      rows.push({
        source: 'claude',
        sessionId: session.sessionId,
        repository: 'unknown',
        // mtime is the last write, which is where the session ended. Good enough
        // to sort by, and replaced with the parsed value on hydration.
        startedAtMs: session.mtimeMs,
        endedAtMs: session.mtimeMs,
        durationMs: 0,
        interactionCount: 0,
        llmCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        model: 'unknown',
        agentModes: [],
        indexedAtMs: this.now(),
        pending: true,
      });
    }
    if (rows.length > 0) {
      this.deps.db.upsertSessions(rows);
      this.deps.onRows?.(rows);
    }
  }

  /**
   * Whether a session's main transcript changed since it was last parsed. A
   * missing fingerprint, a size or mtime difference, or a head-hash mismatch all
   * force a re-read; anything else is already current.
   */
  private needsHydration(session: ClaudeSessionFiles): boolean {
    const existing = this.deps.db.getRow('claude', session.sessionId);
    if (existing === undefined || existing.pending === true) {
      return true;
    }
    if (session.mainFile === undefined) {
      return false;
    }
    const state = this.deps.db.getFileState(session.mainFile);
    if (state === undefined) {
      return true;
    }
    const stat = statOf(session.mainFile);
    if (stat === undefined) {
      return false;
    }
    return stat.size !== state.size || stat.mtimeMs !== state.mtimeMs;
  }

  /** Parse one session and produce its indexed row. */
  private hydrate(session: ClaudeSessionFiles): SessionRow | undefined {
    if (session.mainFile === undefined) {
      return undefined;
    }
    const stat = statOf(session.mainFile);
    if (stat === undefined) {
      return undefined;
    }

    let text: string;
    try {
      text = fs.readFileSync(session.mainFile, 'utf8');
    } catch {
      // Unreadable right now (deleted mid-scan, permissions). Leave whatever
      // the index already holds; the next pass will pick it up.
      return undefined;
    }
    const { records } = parseTranscriptText(text);
    if (records.length === 0) {
      return undefined;
    }

    const cwd = firstCwd(records);
    // Sub-agent transcripts are deliberately not parsed here: a list row needs
    // only the main thread's totals, and skipping them is what keeps indexing
    // proportional to the session rather than its whole tree. The detail view
    // loads them on demand.
    const summary = buildSessionSummary({
      sessionId: session.sessionId,
      mainRecords: records,
      repository: this.resolveRepository(cwd),
      codeExts: this.deps.config.getCodeFileExtensions(),
      docExts: this.deps.config.getDocFileExtensions(),
    });

    this.deps.db.putFileState({
      path: session.mainFile,
      source: 'claude',
      sessionId: session.sessionId,
      kind: 'main',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      headHash: headHash(session.mainFile),
      // The whole file was consumed, so a later append can resume from here.
      parsedBytes: stat.size,
      accState: null,
    });

    return {
      source: 'claude',
      sessionId: summary.sessionId,
      repository: summary.repository,
      title: summary.title,
      titleDerived: summary.titleDerived,
      startedAtMs: summary.startedAtMs,
      endedAtMs: summary.endedAtMs,
      durationMs: summary.durationMs,
      interactionCount: summary.interactionCount,
      llmCalls: summary.llmCalls,
      toolCalls: summary.toolCalls,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cachedTokens: summary.cachedTokens,
      model: summary.model,
      agentModes: [...summary.agentModes],
      stateLabel: summary.stateLabel,
      externalUrl: summary.externalUrl,
      indexedAtMs: this.now(),
      pending: false,
      mainPath: session.mainFile,
    } as SessionRow & { mainPath: string };
  }

  /**
   * Resolve a working directory to a sanitized repository, cached per cwd:
   * resolution walks up to a `.git/config` and can consult ssh config, which is
   * far too expensive to repeat for every session in the same checkout.
   */
  private resolveRepository(cwd: string | undefined): string {
    if (cwd === undefined || cwd.length === 0) {
      return 'unknown';
    }
    const cached = this.deps.db.getCachedRepository(cwd);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = this.gitResolver.resolve(cwd) ?? 'unknown';
    this.deps.db.putCachedRepository(cwd, resolved, this.now());
    return resolved;
  }
}

function statOf(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Hash the head of a file. Size and mtime alone cannot distinguish an append
 * from a rewrite, and resuming a parse at a stale offset in a rewritten file
 * would produce silently wrong counts.
 */
function headHash(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_HASH_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_HASH_BYTES, 0);
    return crypto.createHash('sha1').update(buffer.subarray(0, read)).digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do if the handle will not close.
      }
    }
  }
}

/** First `cwd` seen in a transcript — the session's working directory. */
function firstCwd(records: TranscriptRecord[]): string | undefined {
  for (const record of records) {
    const cwd = (record as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && cwd.length > 0) {
      return cwd;
    }
  }
  return undefined;
}
