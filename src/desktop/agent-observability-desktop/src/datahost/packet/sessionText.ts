import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSessionRetrospective } from '@agent-observability/core/src/analysis/retrospective';
import { buildReviewPacket, type ReviewPacket } from '@agent-observability/core/src/analysis/reviewPacket';
import { buildHandoffBrief, type HandoffBrief } from '@agent-observability/core/src/analysis/handoffBrief';
import type { RepoPathFn } from '@agent-observability/core/src/analysis/sessionActivity';
import type { CostMode } from '@agent-observability/core/src/telemetry/models';
import type { LiveLastEvent } from '@agent-observability/core/src/live/liveStatus';
import { readWorkspaceYaml } from '@agent-observability/core/src/copilotCli/events';
import type { SessionRef } from '../../shared/rpc';
import type { SessionFacts } from '../detail/detailRenderer';
import { promptSafePath } from '../improve/contextPlan';

/**
 * The datahost side of the review packet, the hand-off brief and "Resume in
 * terminal": three local, user-initiated builders over ONE memoized parse.
 *
 * Nothing here calls a vendor, writes to disk or logs. The packet and the
 * brief leave the app only when the user presses Copy; every quoted string
 * was already passed through core's redaction by the builders, every path is
 * made repo-relative here (or reduced to its file name), and branch names,
 * absolute paths and tool output never appear. None of it touches the
 * aggregate, sync or team paths.
 */

/** Repo-relative POSIX under `root`; a bare file name for anything outside it. */
export function repoPathFn(root: string | undefined): RepoPathFn {
  return (recorded: string) => {
    if (root === undefined) {
      // Without a known checkout nothing can be placed, so nothing is called
      // "outside" either: a name alone, and no false risk flag.
      return { path: baseName(recorded), insideRepo: true };
    }
    if (!path.isAbsolute(recorded)) {
      return { path: recorded.replace(/\\/g, '/'), insideRepo: true };
    }
    const relative = path.relative(root, recorded);
    const inside = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
    return { path: promptSafePath(recorded, root), insideRepo: inside };
  };
}

function baseName(file: string): string {
  const segments = file.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.length === 0 ? file : segments[segments.length - 1];
}

export interface SessionTextDeps {
  /** The memoized parse (`DetailRenderer.sessionFacts`). Throws when the session cannot be read. */
  facts: (source: string, sessionId: string) => SessionFacts;
  /** The index row, renames applied, for repository and title. */
  row: (source: string, sessionId: string) => { repository: string; title?: string } | undefined;
  /** The verified local checkout for a repository, when one is known. */
  resolveRoot: (repository: string) => string | undefined;
  costMode: (source: string) => CostMode;
}

export interface ReviewPacketsResult {
  packets: ReviewPacket[];
  skipped: { source: string; sessionId: string; message: string }[];
  note?: string;
}

export const UNRESOLVED_ROOT_NOTE =
  'No local checkout of this repository is known, so files are listed by name only.';

export function buildReviewPackets(refs: readonly SessionRef[], deps: SessionTextDeps): ReviewPacketsResult {
  const packets: ReviewPacket[] = [];
  const skipped: ReviewPacketsResult['skipped'] = [];
  let unresolved = false;
  for (const ref of refs) {
    try {
      const facts = deps.facts(ref.source, ref.sessionId);
      const row = deps.row(ref.source, ref.sessionId);
      const repository = row?.repository ?? facts.detail.summary.repository;
      const root = deps.resolveRoot(repository);
      unresolved = unresolved || (root === undefined && facts.activity.edits.length > 0);
      const retrospective = facts.retro ?? buildSessionRetrospective(facts.detail);
      const packet = buildReviewPacket({
        detail: facts.detail,
        retrospective,
        activity: facts.activity,
        ...(retrospective.completion !== undefined ? { completion: retrospective.completion } : {}),
        repository,
        ...(row?.title !== undefined ? { title: row.title } : {}),
        toRepoPath: repoPathFn(root),
        costMode: deps.costMode(ref.source),
      });
      // The builder knows the session only by its detail; the list knows it by
      // source too, and the renderer needs both to label a multi-session packet.
      packets.push({ ...packet, source: ref.source, sessionId: ref.sessionId });
    } catch (err) {
      skipped.push({
        source: ref.source,
        sessionId: ref.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { packets, skipped, ...(unresolved ? { note: UNRESOLVED_ROOT_NOTE } : {}) };
}

export interface HandoffBriefDeps extends SessionTextDeps {
  /** The session's live-board row, when it is still on the board. */
  live: (source: string, sessionId: string) => { lastEvent: LiveLastEvent; lastToolFailed?: boolean } | undefined;
}

export function buildHandoff(
  source: string,
  sessionId: string,
  deps: HandoffBriefDeps,
): { brief: HandoffBrief; note?: string } {
  const facts = deps.facts(source, sessionId);
  const row = deps.row(source, sessionId);
  const repository = row?.repository ?? facts.detail.summary.repository;
  const root = deps.resolveRoot(repository);
  const toRepoPath = repoPathFn(root);
  const retrospective = facts.retro ?? buildSessionRetrospective(facts.detail);

  // Context files the session actually loaded, by the same path rule as
  // everything else in the brief; files outside the checkout keep their name.
  const contextFiles: string[] = [];
  for (const file of facts.context?.total.loadedFiles ?? []) {
    const shown = file.filePath !== undefined ? toRepoPath(file.filePath).path : file.name;
    if (!contextFiles.includes(shown)) {
      contextFiles.push(shown);
    }
  }

  const live = deps.live(source, sessionId);
  const brief = buildHandoffBrief({
    detail: facts.detail,
    retrospective,
    activity: facts.activity,
    ...(retrospective.completion !== undefined ? { completion: retrospective.completion } : {}),
    contextFiles,
    ...(live !== undefined ? { liveLastEvent: live.lastEvent } : {}),
    ...(live?.lastToolFailed !== undefined ? { lastToolFailed: live.lastToolFailed } : {}),
    repository,
    toRepoPath,
  });
  return {
    brief: { ...brief, source, sessionId },
    ...(root === undefined && facts.activity.edits.length > 0 ? { note: UNRESOLVED_ROOT_NOTE } : {}),
  };
}

// ── Resume in terminal ──────────────────────────────────────────────────────

/** How much of a transcript's head is read to find the working directory. */
export const HANDOFF_HEAD_BYTES = 256 * 1024;

export interface ResumeTarget {
  cwd?: string;
  sessionId: string;
  cli: 'claude' | 'copilot';
  problem?: string;
}

export interface ResumeSeams {
  mainPath: (source: string, sessionId: string) => string | undefined;
  isDirectory?: (p: string) => boolean;
  readHead?: (file: string, maxBytes: number) => string | undefined;
  readWorkspace?: (file: string) => Record<string, string>;
}

/**
 * Where "Resume in terminal" should open, re-read from the session's own
 * files rather than kept in the index: a Claude transcript carries `cwd` on
 * its records, a Copilot CLI session in `workspace.yaml`. The main process
 * builds and validates the command itself from these three plain values.
 */
export function resumeTarget(source: string, sessionId: string, seams: ResumeSeams): ResumeTarget {
  const isDirectory = seams.isDirectory ?? defaultIsDirectory;
  if (source !== 'claude' && source !== 'copilot-cli') {
    return { sessionId, cli: 'claude', problem: 'Only Claude Code and Copilot CLI sessions can be resumed in a terminal.' };
  }
  const cli = source === 'claude' ? 'claude' : 'copilot';
  const mainPath = seams.mainPath(source, sessionId);
  if (mainPath === undefined) {
    return { sessionId, cli, problem: 'The session file is no longer known. Refresh the session list and try again.' };
  }
  let cwd: string | undefined;
  if (source === 'claude') {
    cwd = cwdFromTranscriptHead((seams.readHead ?? defaultReadHead)(mainPath, HANDOFF_HEAD_BYTES));
  } else {
    try {
      cwd = (seams.readWorkspace ?? readWorkspaceYaml)(path.join(path.dirname(mainPath), 'workspace.yaml')).cwd;
    } catch {
      cwd = undefined;
    }
  }
  if (cwd === undefined || cwd.length === 0) {
    return { sessionId, cli, problem: 'The session did not record a working directory.' };
  }
  if (!path.isAbsolute(cwd) || !isDirectory(cwd)) {
    return { sessionId, cli, problem: 'The folder this session ran in no longer exists.' };
  }
  return { cwd, sessionId, cli };
}

/** The first `cwd` any record in the head carries; malformed lines are skipped. */
export function cwdFromTranscriptHead(head: string | undefined): string | undefined {
  if (head === undefined) {
    return undefined;
  }
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes('"cwd"')) {
      continue;
    }
    try {
      const record = JSON.parse(trimmed) as { cwd?: unknown };
      if (typeof record.cwd === 'string' && record.cwd.length > 0) {
        return record.cwd;
      }
    } catch {
      // A line cut by the byte cap, or a partial write: keep looking.
    }
  }
  return undefined;
}

function defaultIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultReadHead(file: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}
