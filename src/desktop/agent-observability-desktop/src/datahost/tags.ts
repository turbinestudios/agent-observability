import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRow, TagCount } from '../shared/rpc';
import { sessionKey } from '../shared/rpc';

/**
 * User labels for sessions — "experiment-A", "baseline", "bad-run".
 *
 * Where a rename holds one fact about a session, tags hold its membership in
 * many sets at once, which is what makes a labelled corpus possible: the ten
 * runs with the old prompt against the ten with the new one.
 *
 * Kept in its own file rather than in `index.db`, for the same reason as the
 * renames and the hidden list: the index is a disposable cache that is dropped
 * whenever the schema changes or the user rebuilds it, and losing someone's
 * labels to a cache invalidation would be indefensible. Nothing here is ever
 * written back to a Claude transcript or Copilot's stores, and nothing here
 * goes near the aggregate/sync path or the AI backends — a tag is raw content
 * the user wrote, and the consent notices on those paths enumerate what they
 * carry.
 *
 * The file is small (one line per tagged session), so it is rewritten whole
 * through a temp file and a rename, which cannot leave a half-written file
 * behind if the process dies mid-save.
 */

/** `{ "<source>:<sessionId>": ["experiment-A", "baseline"] }` */
type TagMap = Record<string, string[]>;

/** Long enough for a sentence fragment, short enough to sit in a list row. */
export const MAX_TAG_LENGTH = 40;

/** A session with more labels than this is not being labelled, it is being pasted into. */
export const MAX_TAGS_PER_SESSION = 20;

export class TagStore {
  private tags: TagMap;

  constructor(private readonly file: string = resolveTagsPath()) {
    this.tags = read(this.file);
  }

  /** A session's tags in the case the user typed, or an empty array. */
  get(source: string, sessionId: string): string[] {
    return this.tags[sessionKey(source, sessionId)] ?? [];
  }

  /** How many sessions carry at least one tag. */
  size(): number {
    return Object.keys(this.tags).length;
  }

  /**
   * Replace a session's tags, or clear them with an empty list. Returns the
   * tags as stored, which is not necessarily what was passed: they are
   * normalized here so no caller has to remember to.
   */
  set(source: string, sessionId: string, tags: readonly string[]): string[] {
    const key = sessionKey(source, sessionId);
    const clean = normalizeTags(tags);
    if (clean.length === 0) {
      if (this.tags[key] === undefined) {
        return [];
      }
      const { [key]: _removed, ...rest } = this.tags;
      this.tags = rest;
    } else {
      this.tags = { ...this.tags, [key]: clean };
    }
    write(this.file, this.tags);
    return clean;
  }

  /**
   * The `source:sessionId` keys carrying a tag, matched case-insensitively.
   *
   * Handed to the index so a tag filter runs inside the SQL query rather than
   * over its results — filtering a page after the fact would make it silently
   * short and paging past it incorrect.
   */
  keysFor(tag: string): string[] {
    const needle = normalizeKey(tag);
    if (needle.length === 0) {
      return [];
    }
    return Object.entries(this.tags)
      .filter(([, tags]) => tags.some((t) => normalizeKey(t) === needle))
      .map(([key]) => key);
  }

  /**
   * Every tag in use with its session count, most used first.
   *
   * Counting is case-insensitive but the label is not: a tag written
   * "Experiment-A" once and "experiment-a" nine times is one tag, shown the way
   * it is usually written rather than the way it was first written.
   *
   * `excludeKeys` drops sessions the user has taken out of their list, for the
   * same reason the group counts and the overview totals do: a chip promising
   * three sessions that then shows two reads as a bug.
   */
  list(excludeKeys: readonly string[] = []): TagCount[] {
    const excluded = new Set(excludeKeys);
    const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
    for (const [key, tags] of Object.entries(this.tags)) {
      if (excluded.has(key)) {
        continue;
      }
      for (const tag of tags) {
        const id = normalizeKey(tag);
        const entry = byKey.get(id) ?? { count: 0, spellings: new Map<string, number>() };
        entry.count += 1;
        entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1);
        byKey.set(id, entry);
      }
    }
    return [...byKey.values()]
      .map((entry) => ({ tag: dominant(entry.spellings), count: entry.count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Overlay tags onto rows read from the index. */
  apply(rows: SessionRow[]): SessionRow[] {
    if (this.size() === 0) {
      return rows;
    }
    return rows.map((row) => {
      const tags = this.get(row.source, row.sessionId);
      return tags.length === 0 ? row : { ...row, tags };
    });
  }
}

export function resolveTagsPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'tags.json');
}

/**
 * Trim, drop blanks, cap the length of each and the number of them, and
 * de-duplicate case-insensitively keeping the first spelling seen — so typing
 * "Bad-Run" onto a session already tagged "bad-run" is a no-op rather than a
 * second tag that filters as one and displays as two.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim().slice(0, MAX_TAG_LENGTH).trim();
    const key = normalizeKey(trimmed);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    clean.push(trimmed);
    if (clean.length === MAX_TAGS_PER_SESSION) {
      break;
    }
  }
  return clean;
}

/** The identity two spellings of one tag share. */
function normalizeKey(tag: string): string {
  return tag.trim().toLowerCase();
}

/** The most-used spelling; ties go to the alphabetically first, so it is stable. */
function dominant(spellings: Map<string, number>): string {
  return [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function read(file: string): TagMap {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // A hand-edited or truncated file degrades to "no tags" for the entries it
    // broke, rather than putting junk on a row.
    const clean: TagMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const tags = normalizeTags(value.filter((v): v is string => typeof v === 'string'));
      if (tags.length > 0) {
        clean[key] = tags;
      }
    }
    return clean;
  } catch {
    return {}; // absent on first run, or unreadable
  }
}

function write(file: string, tags: TagMap): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tags, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
