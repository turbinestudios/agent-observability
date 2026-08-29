import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRow } from '../shared/rpc';
import { sessionKey } from '../shared/rpc';

/**
 * Free-text notes the user attached to a session.
 *
 * A note preserves the *why* — "went sideways after it ignored the test
 * instruction" — which is exactly what has been forgotten by the time anyone
 * sits down to a retro. A tag says which set a run belongs to; a note says what
 * happened in it.
 *
 * Kept beside the renames and tags in a JSON file rather than in `index.db`,
 * because the index is a disposable cache that a schema change or a rebuild
 * drops. Notes are raw content the user wrote: they never reach the
 * aggregate/sync path, and never the AI backends, whose consent notices
 * enumerate what each request carries.
 *
 * A note is longer than a title but still small, so the whole file is rewritten
 * through a temp file and a rename on every save; a process that dies mid-write
 * cannot leave a half-written note behind.
 */

/** `{ "<source>:<sessionId>": "went sideways after…" }` */
type NoteMap = Record<string, string>;

/**
 * Longer than anyone writes in a research note, short enough that the file
 * stays small and a paste cannot turn one row into a megabyte.
 */
export const MAX_NOTE_LENGTH = 8_000;

export class NoteStore {
  private notes: NoteMap;

  constructor(private readonly file: string = resolveNotesPath()) {
    this.notes = read(this.file);
  }

  /** A session's note, or an empty string when it has none. */
  get(source: string, sessionId: string): string {
    return this.notes[sessionKey(source, sessionId)] ?? '';
  }

  has(source: string, sessionId: string): boolean {
    return this.notes[sessionKey(source, sessionId)] !== undefined;
  }

  /** How many sessions carry a note. */
  size(): number {
    return Object.keys(this.notes).length;
  }

  /**
   * Save a note, or clear it with blank text. Returns the note as stored —
   * trailing whitespace trimmed, capped — which is what the row indicator and
   * the editor should both reflect.
   */
  set(source: string, sessionId: string, note: string): string {
    const key = sessionKey(source, sessionId);
    // Trimmed at the ends only: the blank lines a person put BETWEEN paragraphs
    // are part of what they wrote.
    const clean = note.slice(0, MAX_NOTE_LENGTH).trim();
    if (clean.length === 0) {
      if (this.notes[key] === undefined) {
        return '';
      }
      const { [key]: _removed, ...rest } = this.notes;
      this.notes = rest;
    } else {
      this.notes = { ...this.notes, [key]: clean };
    }
    write(this.file, this.notes);
    return clean;
  }

  /**
   * Mark rows that carry a note.
   *
   * Only the fact, never the text: a list row shows a dot, and shipping every
   * note's body with every page would cost far more than the one the user is
   * about to open.
   */
  apply(rows: SessionRow[]): SessionRow[] {
    if (this.size() === 0) {
      return rows;
    }
    return rows.map((row) =>
      this.has(row.source, row.sessionId) ? { ...row, hasNote: true } : row,
    );
  }
}

export function resolveNotesPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'notes.json');
}

function read(file: string): NoteMap {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Anything that is not usable note text is dropped, so a hand-edited file
    // degrades to "no note" rather than putting an empty editor on screen and
    // an indicator on the row.
    const clean: NoteMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        clean[key] = value.slice(0, MAX_NOTE_LENGTH).trim();
      }
    }
    return clean;
  } catch {
    return {}; // absent on first run, or unreadable
  }
}

function write(file: string, notes: NoteMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
