import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoredAttention } from '@agent-observability/core/src/inbox/attention';
import type { LiveLastEvent } from '@agent-observability/core/src/live/liveStatus';

/**
 * What the user has done with their inbox: which items they have seen,
 * dismissed or snoozed. User-created state, so it lives in a JSON store beside
 * `renames.json` and survives an index rebuild.
 *
 * It holds session keys, reason and state enums, and timestamps ONLY — never a
 * title, a repository, a path, a branch or any transcript text. Titles and
 * repositories are joined from the index when the inbox is read.
 */

/** How a session's transcript ended, remembered while the board still reads its tail. */
export interface TerminalFacts {
  event: LiveLastEvent;
  failed: boolean;
  atMs: number;
}

export interface InboxFile {
  version: 1;
  /** First run. Sessions that ended before this never enter the inbox. */
  createdAtMs: number;
  lastVisitMs: number;
  items: Record<string, StoredAttention>;
  /** Keyed by `source:sessionId`. */
  terminals: Record<string, TerminalFacts>;
}

const STATES: ReadonlySet<string> = new Set(['new', 'seen', 'dismissed', 'snoozed']);
const EVENTS: ReadonlySet<string> = new Set([
  'tool-pending',
  'assistant-text',
  'turn-ended',
  'user-prompt',
  'tool-result',
  'interruption',
  'unknown',
]);

export class InboxStore {
  private data: InboxFile;

  constructor(
    private readonly file: string = resolveInboxPath(),
    now: () => number = () => Date.now(),
  ) {
    const existing = read(file);
    if (existing === undefined) {
      const at = now();
      this.data = { version: 1, createdAtMs: at, lastVisitMs: at, items: {}, terminals: {} };
      // Persist the floor immediately: without it every launch would be a
      // "first run" and nothing that finished while the app was closed would show.
      this.flush();
    } else {
      this.data = existing;
    }
  }

  get createdAtMs(): number {
    return this.data.createdAtMs;
  }

  get lastVisitMs(): number {
    return this.data.lastVisitMs;
  }

  items(): Record<string, StoredAttention> {
    return { ...this.data.items };
  }

  terminals(): Record<string, TerminalFacts> {
    return { ...this.data.terminals };
  }

  /** Replace the stored state; writes only when something actually changed. */
  save(next: { items?: Record<string, StoredAttention>; terminals?: Record<string, TerminalFacts>; lastVisitMs?: number }): void {
    const updated: InboxFile = {
      ...this.data,
      ...(next.items !== undefined ? { items: next.items } : {}),
      ...(next.terminals !== undefined ? { terminals: next.terminals } : {}),
      ...(next.lastVisitMs !== undefined ? { lastVisitMs: next.lastVisitMs } : {}),
    };
    if (JSON.stringify(updated) === JSON.stringify(this.data)) {
      return;
    }
    this.data = updated;
    this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // The inbox still works for this run; the state just does not persist.
    }
  }
}

export function resolveInboxPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'inbox.json');
}

/** A hand-edited or truncated file must not take the inbox down: bad entries are dropped. */
function read(file: string): InboxFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.createdAtMs !== 'number' || !Number.isFinite(raw.createdAtMs)) {
    return undefined;
  }
  const items: Record<string, StoredAttention> = {};
  for (const [key, value] of Object.entries(asRecord(raw.items))) {
    const item = asRecord(value);
    if (typeof item.state !== 'string' || !STATES.has(item.state) || !isNumber(item.episodeMs) || !isNumber(item.firstSeenMs)) {
      continue;
    }
    items[key] = {
      state: item.state as StoredAttention['state'],
      episodeMs: item.episodeMs,
      firstSeenMs: item.firstSeenMs,
      ...(isNumber(item.snoozedUntilMs) ? { snoozedUntilMs: item.snoozedUntilMs } : {}),
      ...(typeof item.terminalEvent === 'string' && EVENTS.has(item.terminalEvent)
        ? { terminalEvent: item.terminalEvent as LiveLastEvent }
        : {}),
    };
  }
  const terminals: Record<string, TerminalFacts> = {};
  for (const [key, value] of Object.entries(asRecord(raw.terminals))) {
    const facts = asRecord(value);
    if (typeof facts.event !== 'string' || !EVENTS.has(facts.event) || !isNumber(facts.atMs)) {
      continue;
    }
    terminals[key] = { event: facts.event as LiveLastEvent, failed: facts.failed === true, atMs: facts.atMs };
  }
  return {
    version: 1,
    createdAtMs: raw.createdAtMs,
    lastVisitMs: isNumber(raw.lastVisitMs) ? raw.lastVisitMs : raw.createdAtMs,
    items,
    terminals,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
