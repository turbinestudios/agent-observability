import { isCommandText, isInterruptionText } from '../analysis/retrospective';
import { contentBlocks, messageText, type TranscriptRecord } from '../claude/transcript';

/**
 * Hook-free live status for a Claude Code session, derived from the tail of
 * its transcript.
 *
 * Claude Code appends a record for every prompt, model reply, tool call and
 * tool result, so the LAST substantive record tells us what the agent is up
 * to: a `tool_use` with no later `tool_result` means a tool is running (or
 * awaiting approval — the transcript cannot tell the two apart), an assistant
 * text with nothing pending means the turn ended and the user's input is
 * next, a bare human prompt means the model is generating. Age of the last
 * activity then grades the session into idle or finished.
 *
 * This file has NO node imports on purpose: the renderer imports the types and
 * thresholds so the board and the data host agree on the vocabulary.
 *
 * LOCAL-ONLY: `gitBranch`, `cwd` and `aiTitle` are display facts for this
 * machine and must never enter any aggregate/sync path.
 */

export type LiveStatus = 'working' | 'waiting' | 'idle' | 'finished';

export type LiveLastEvent =
  | 'tool-pending'
  | 'assistant-text'
  | 'turn-ended'
  | 'user-prompt'
  | 'tool-result'
  | 'interruption'
  | 'unknown';

/** No transcript write for this long → `idle`. */
export const LIVE_IDLE_MS = 3 * 60_000;
/** No transcript write for this long → `finished` (and dropped from the board). */
export const LIVE_FINISHED_MS = 30 * 60_000;
/** A tool call pending at least this long is flagged "may be waiting for approval". UI hint only. */
export const PENDING_TOOL_HINT_MS = 90_000;

/** Board sort order: what needs the user first. */
export const LIVE_STATUS_ORDER: readonly LiveStatus[] = ['waiting', 'working', 'idle', 'finished'];

export interface LiveTailFacts {
  /** `max(file mtime, newest record timestamp that parses)`. */
  lastActivityMs: number;
  lastEvent: LiveLastEvent;
  /** Tool names of `tool_use` blocks without a later `tool_result` (main thread only). */
  pendingTools: string[];
  /** LOCAL-ONLY display; never leaves the machine. */
  gitBranch?: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  aiTitle?: string;
  /**
   * The newest main-thread tool result failed and nothing followed it. Lets
   * the inbox tell "ended on an error" from an ordinary finish.
   */
  lastToolFailed?: boolean;
}

export interface LiveThresholds {
  idleMs: number;
  finishedMs: number;
}

const METADATA_TYPES: ReadonlySet<string> = new Set([
  'ai-title',
  'summary',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'agent-name',
  'attachment',
]);

/** Derive the facts the board needs from the tail records of one transcript. */
export function deriveTailFacts(records: readonly TranscriptRecord[], fileMtimeMs: number): LiveTailFacts {
  const facts: LiveTailFacts = {
    lastActivityMs: Number.isFinite(fileMtimeMs) ? fileMtimeMs : 0,
    lastEvent: 'unknown',
    pendingTools: [],
  };

  // Opportunistic metadata: the newest value of each wins, so walk from the end.
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (facts.aiTitle === undefined && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) {
      facts.aiTitle = record.aiTitle;
    }
    if (facts.gitBranch === undefined && typeof record.gitBranch === 'string' && record.gitBranch.length > 0) {
      facts.gitBranch = record.gitBranch;
    }
    if (facts.cwd === undefined && typeof record.cwd === 'string' && record.cwd.length > 0) {
      facts.cwd = record.cwd;
    }
    if (facts.sessionId === undefined && typeof record.sessionId === 'string' && record.sessionId.length > 0) {
      facts.sessionId = record.sessionId;
    }
    const model = record.message?.model;
    if (facts.model === undefined && typeof model === 'string' && model.length > 0) {
      facts.model = model;
    }
    const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
    if (Number.isFinite(ts) && ts > facts.lastActivityMs) {
      facts.lastActivityMs = ts;
    }
  }

  // Resolved tool ids seen in user records AFTER the record being classified.
  const resolved = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.isSidechain === true || METADATA_TYPES.has(record.type)) {
      continue;
    }
    if (record.type === 'system') {
      if (record.subtype === 'turn_duration') {
        facts.lastEvent = 'turn-ended';
        return facts;
      }
      continue;
    }
    if (record.type === 'assistant' && record.message !== undefined) {
      const pending = pendingToolsSince(records, i, resolved);
      if (pending.length > 0) {
        facts.lastEvent = 'tool-pending';
        facts.pendingTools = pending;
      } else {
        facts.lastEvent = messageText(record.message).trim().length > 0 ? 'assistant-text' : 'unknown';
      }
      return facts;
    }
    if (record.type === 'user' && record.message !== undefined) {
      const text = messageText(record.message);
      if (isInterruptionText(text)) {
        facts.lastEvent = 'interruption';
        return facts;
      }
      if (isCommandText(text)) {
        // Slash-command bookkeeping is not an event; keep walking.
        continue;
      }
      const blocks = contentBlocks(record.message);
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (record.isMeta !== true && text.trim().length > 0) {
        facts.lastEvent = 'user-prompt';
        return facts;
      }
      if (blocks.length > 0 && results.length === blocks.length) {
        for (const block of results) {
          if (typeof block.tool_use_id === 'string') {
            resolved.add(block.tool_use_id);
          }
        }
        facts.lastEvent = 'tool-result';
        if (results.some((b) => b.is_error === true)) {
          facts.lastToolFailed = true;
        }
        return facts;
      }
      facts.lastEvent = 'unknown';
      return facts;
    }
    if (record.type === 'user' || record.type === 'assistant') {
      facts.lastEvent = 'unknown';
      return facts;
    }
  }
  return facts;
}

/**
 * Tool calls issued by the assistant record at `index` and the assistant
 * records immediately before it (back to the last human prompt), minus the
 * ids resolved by `tool_result` blocks anywhere after `index`.
 */
function pendingToolsSince(
  records: readonly TranscriptRecord[],
  index: number,
  alreadyResolved: ReadonlySet<string>,
): string[] {
  const resolved = new Set<string>(alreadyResolved);
  for (let j = index + 1; j < records.length; j++) {
    const later = records[j];
    if (later.isSidechain === true || later.type !== 'user') {
      continue;
    }
    for (const block of contentBlocks(later.message)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resolved.add(block.tool_use_id);
      }
    }
  }
  const pending: string[] = [];
  for (let k = index; k >= 0; k--) {
    const record = records[k];
    if (record.isSidechain === true || METADATA_TYPES.has(record.type) || record.type === 'system') {
      continue;
    }
    if (record.type === 'assistant') {
      const own: string[] = [];
      for (const block of contentBlocks(record.message)) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && !resolved.has(block.id)) {
          own.push(typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool');
        }
      }
      // Walking backwards, so earlier records' calls go in front.
      pending.unshift(...own);
      continue;
    }
    if (record.type === 'user') {
      const text = messageText(record.message);
      if (isCommandText(text)) {
        continue;
      }
      const blocks = contentBlocks(record.message);
      if (blocks.length > 0 && blocks.every((b) => b.type === 'tool_result')) {
        // Results for earlier calls in this turn: those ids are resolved too.
        for (const block of blocks) {
          if (typeof block.tool_use_id === 'string') {
            resolved.add(block.tool_use_id);
          }
        }
        continue;
      }
      // A human prompt (or interruption) bounds the turn.
      break;
    }
  }
  return pending;
}

/** Grade the session from its facts and the age of its last activity. */
export function deriveLiveStatus(
  facts: LiveTailFacts,
  nowMs: number,
  thresholds: LiveThresholds = { idleMs: LIVE_IDLE_MS, finishedMs: LIVE_FINISHED_MS },
): LiveStatus {
  const age = nowMs - facts.lastActivityMs;
  if (age >= thresholds.finishedMs) {
    return 'finished';
  }
  if (age >= thresholds.idleMs) {
    return 'idle';
  }
  switch (facts.lastEvent) {
    case 'assistant-text':
    case 'turn-ended':
    case 'interruption':
      return 'waiting';
    default:
      return 'working';
  }
}
