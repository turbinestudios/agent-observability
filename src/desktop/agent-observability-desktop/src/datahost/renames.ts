import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRow } from '../shared/rpc';
import { sessionKey } from '../shared/rpc';

/**
 * User-chosen names for sessions, layered over whatever the source called them.
 *
 * Kept in its own file rather than in `index.db` on purpose: the index is a
 * disposable cache that gets dropped whenever the schema changes or the user
 * rebuilds it, and losing someone's names to a cache invalidation would be
 * indefensible. Nothing here is ever written back to Copilot's stores or a
 * Claude transcript — those stay read-only, and the original name is always
 * recoverable by clearing the rename.
 *
 * The file is small (one line per renamed session), so it is rewritten whole
 * through a temp file and a rename, which cannot leave a half-written file
 * behind if the process dies mid-save.
 */

/** `{ "<source>:<sessionId>": "New title" }` */
type RenameMap = Record<string, string>;

export class RenameStore {
  private renames: RenameMap;

  constructor(private readonly file: string = resolveRenamesPath()) {
    this.renames = read(this.file);
  }

  /** The user's name for a session, or `undefined` when not renamed. */
  get(source: string, sessionId: string): string | undefined {
    return this.renames[sessionKey(source, sessionId)];
  }

  /** How many sessions carry a user-chosen name. */
  size(): number {
    return Object.keys(this.renames).length;
  }

  /**
   * Set a name, or clear it when `title` is blank so the original comes back.
   * Returns the effective name, which is `undefined` once cleared.
   */
  set(source: string, sessionId: string, title: string): string | undefined {
    const key = sessionKey(source, sessionId);
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      if (this.renames[key] === undefined) {
        return undefined;
      }
      const { [key]: _removed, ...rest } = this.renames;
      this.renames = rest;
    } else {
      this.renames = { ...this.renames, [key]: trimmed };
    }
    write(this.file, this.renames);
    return this.renames[key];
  }

  /**
   * Overlay names onto rows read from the index.
   *
   * A renamed session is never "derived": the user typed it, so it should not
   * be styled as a guessed title.
   */
  apply(rows: SessionRow[]): SessionRow[] {
    if (this.size() === 0) {
      return rows;
    }
    return rows.map((row) => {
      const renamed = this.get(row.source, row.sessionId);
      if (renamed === undefined) {
        return row;
      }
      return { ...row, title: renamed, titleDerived: false, originalTitle: row.title };
    });
  }

  /**
   * Session keys whose user-chosen name matches a search term.
   *
   * The index stores original titles, so a SQL search cannot see renames; the
   * caller unions these keys into its result set. Matching is case-insensitive
   * substring, the same shape as the SQL `LIKE`.
   */
  matchingKeys(query: string): string[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }
    return Object.entries(this.renames)
      .filter(([, title]) => title.toLowerCase().includes(needle))
      .map(([key]) => key);
  }
}

export function resolveRenamesPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'renames.json');
}

function read(file: string): RenameMap {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Drop anything that is not a non-empty string, so a hand-edited or
    // truncated file degrades to "no rename" rather than a blank title.
    const clean: RenameMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        clean[key] = value;
      }
    }
    return clean;
  } catch {
    return {}; // absent on first run, or unreadable
  }
}

function write(file: string, renames: RenameMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(renames, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
