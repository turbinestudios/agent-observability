import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { discoverClaudeSessions, defaultFs } from '@agent-observability/core/src/claude/paths';
import type { ClaudeFs } from '@agent-observability/core/src/claude/paths';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { WriterLease } from '@agent-observability/core/src/otel/writerLease';
import type { Configuration } from '@agent-observability/core/src/config/configuration';

/**
 * Permanently removing a session's underlying data.
 *
 * This is the irreversible half of "delete", and the two sources are genuinely
 * different: a Claude session is one transcript file that this app can remove
 * outright, while a Copilot session is rows inside a database another process
 * also writes. So the user is told what will actually happen BEFORE confirming
 * — {@link describeDeletion} produces exactly that — rather than being offered a
 * single "delete" that quietly means different things.
 */

/** What a delete would do, for the confirmation dialog to state plainly. */
export interface DeletionPlan {
  /** Whether anything can be permanently removed at all. */
  supported: boolean;
  /** One line naming the target, e.g. the transcript path. */
  target: string;
  /** The consequence, in the user's terms. */
  consequence: string;
  /** Present when the deletion may not stick, so the dialog can say so. */
  caveat?: string;
}

export interface DeletionResult {
  ok: boolean;
  /** What was actually removed, for the log and the UI. */
  detail: string;
}

export interface DeletionDeps {
  config: Configuration;
  fs?: ClaudeFs;
  /** How long a stale archive write-lock is honoured before being reclaimed. */
  leaseStaleMs?: number;
}

const DEFAULT_LEASE_STALE_MS = 30_000;

/** Describe what deleting this session would remove, without removing it. */
export function describeDeletion(
  source: string,
  sessionId: string,
  deps: DeletionDeps,
): DeletionPlan {
  if (source === 'copilot-cli') {
    // The app only ever reads the Copilot CLI's own store; it never deletes there.
    return {
      supported: false,
      target: 'Stored by the Copilot CLI',
      consequence:
        "This app does not delete from the Copilot CLI's session store. You can hide the session here, or remove it with the Copilot CLI.",
    };
  }
  if (source === 'claude') {
    const files = claudeFilesFor(sessionId, deps);
    if (files.length === 0) {
      return {
        supported: false,
        target: 'No transcript found on disk',
        consequence: 'This session has already been removed from disk. You can hide it instead.',
      };
    }
    const main = files.find((f) => !f.includes('subagents')) ?? files[0];
    const extra = files.length - 1;
    return {
      supported: true,
      target: main + (extra > 0 ? `  (+${extra} sub-agent transcript${extra === 1 ? '' : 's'})` : ''),
      consequence:
        'The transcript is deleted from disk. Claude Code will no longer be able to resume this session, and its history cannot be recovered.',
    };
  }

  if (source === 'copilot') {
    const archive = resolveArchiveDbPath(deps.config);
    if (archive === undefined || !fs.existsSync(archive)) {
      return {
        supported: false,
        target: 'No local Copilot archive found',
        consequence: 'There is nothing here to delete from. You can hide this session instead.',
      };
    }
    return {
      supported: true,
      target: archive,
      consequence:
        "This session's telemetry is deleted from this app's own Copilot archive.",
      caveat:
        'Copilot keeps its own recent history separately. If this session is still there, it will come back the next time the archive is updated — hiding it is the way to keep it out of your list for good.',
    };
  }

  return {
    supported: false,
    target: source,
    consequence: 'Sessions from this source cannot be deleted from here. You can hide it instead.',
  };
}

/** Permanently remove a session's data. Call only after an explicit confirmation. */
export function deleteSession(
  source: string,
  sessionId: string,
  deps: DeletionDeps,
): DeletionResult {
  if (source === 'claude') {
    return deleteClaudeTranscripts(sessionId, deps);
  }
  if (source === 'copilot') {
    return deleteCopilotSpans(sessionId, deps);
  }
  return { ok: false, detail: `Sessions from "${source}" cannot be deleted.` };
}

/** Every file that makes up a Claude session: its transcript and sub-agents. */
function claudeFilesFor(sessionId: string, deps: DeletionDeps): string[] {
  const session = discoverClaudeSessions(deps.config, deps.fs ?? defaultFs).find(
    (s) => s.sessionId === sessionId,
  );
  if (session === undefined) {
    return [];
  }
  const files = [...session.subagentFiles];
  if (session.mainFile !== undefined) {
    files.unshift(session.mainFile);
  }
  return files.filter((f) => fs.existsSync(f));
}

function deleteClaudeTranscripts(sessionId: string, deps: DeletionDeps): DeletionResult {
  const files = claudeFilesFor(sessionId, deps);
  if (files.length === 0) {
    return { ok: false, detail: 'No transcript found for this session.' };
  }

  let removed = 0;
  for (const file of files) {
    try {
      fs.rmSync(file);
      removed += 1;
    } catch (err) {
      return {
        ok: false,
        detail: `Could not delete ${file}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // A sub-agent folder left behind would keep the session half-alive in
  // discovery, which walks it regardless of whether the main file is gone.
  const subagentDir = files.map((f) => path.dirname(f)).find((d) => d.endsWith('subagents'));
  if (subagentDir !== undefined) {
    try {
      fs.rmdirSync(subagentDir);
      fs.rmdirSync(path.dirname(subagentDir));
    } catch {
      // Only removable when empty; a leftover directory is harmless.
    }
  }

  return { ok: true, detail: `Deleted ${removed} transcript file${removed === 1 ? '' : 's'}.` };
}

/**
 * Remove a session's spans from this app's Copilot archive.
 *
 * The archive is swept by whichever process holds its write lease, so the same
 * lease is taken here. Writing without it could interleave with a sweep that is
 * mid-transaction.
 */
function deleteCopilotSpans(sessionId: string, deps: DeletionDeps): DeletionResult {
  const archive = resolveArchiveDbPath(deps.config);
  if (archive === undefined || !fs.existsSync(archive)) {
    return { ok: false, detail: 'No local Copilot archive to delete from.' };
  }

  const lease = new WriterLease(
    path.join(path.dirname(archive), 'writer.lock'),
    deps.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS,
  );
  if (!lease.tryAcquire()) {
    return {
      ok: false,
      detail: 'The Copilot archive is being written to right now. Try again in a moment.',
    };
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(archive, { fileMustExist: true });
    const remove = db.transaction((id: string) => {
      // Attributes reference spans, so they go first.
      const spanIds = db!
        .prepare(
          `SELECT span_id FROM spans WHERE COALESCE(conversation_id, chat_session_id) = ?`,
        )
        .all(id) as { span_id: string }[];
      const dropAttr = db!.prepare('DELETE FROM span_attributes WHERE span_id = ?');
      for (const row of spanIds) {
        dropAttr.run(row.span_id);
      }
      db!
        .prepare('DELETE FROM spans WHERE COALESCE(conversation_id, chat_session_id) = ?')
        .run(id);
      return spanIds.length;
    });
    const count = remove(sessionId);
    return count === 0
      ? { ok: false, detail: 'That session is not in the local archive.' }
      : { ok: true, detail: `Deleted ${count} span${count === 1 ? '' : 's'} from the archive.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
    lease.release();
  }
}
