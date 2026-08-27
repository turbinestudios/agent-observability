import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionKey } from '../shared/rpc';

/**
 * Sessions the user has taken out of their list.
 *
 * Hiding touches nothing on disk — the transcript or telemetry stays exactly
 * where it was, and unhiding brings the session back complete. It is the safe
 * half of "delete": the reversible one, for clearing noise out of a list.
 *
 * Kept in its own file rather than in `index.db` for the same reason as the
 * renames: the index is a disposable cache that is dropped whenever the schema
 * changes or the user rebuilds it, and a hidden session reappearing because a
 * cache was rebuilt would make the feature untrustworthy.
 */
export class HiddenStore {
  private keys: Set<string>;

  constructor(private readonly file: string = resolveHiddenPath()) {
    this.keys = read(this.file);
  }

  isHidden(source: string, sessionId: string): boolean {
    return this.keys.has(sessionKey(source, sessionId));
  }

  /** Every hidden `source:sessionId`, for excluding them from queries. */
  all(): string[] {
    return [...this.keys];
  }

  size(): number {
    return this.keys.size;
  }

  /** Hide or unhide a session. Returns whether it is hidden afterwards. */
  set(source: string, sessionId: string, hidden: boolean): boolean {
    const key = sessionKey(source, sessionId);
    if (hidden === this.keys.has(key)) {
      return hidden;
    }
    const next = new Set(this.keys);
    if (hidden) {
      next.add(key);
    } else {
      next.delete(key);
    }
    this.keys = next;
    write(this.file, this.keys);
    return hidden;
  }
}

export function resolveHiddenPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'hidden.json');
}

function read(file: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && v.length > 0));
  } catch {
    return new Set(); // absent on first run, or unreadable
  }
}

function write(file: string, keys: ReadonlySet<string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...keys], null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
