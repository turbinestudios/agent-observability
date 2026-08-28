/**
 * A Keep a Changelog document, turned into something React can render.
 *
 * The app shows its own `CHANGELOG.md` in the What's new dialog, and that file
 * has to stay a normal changelog: readable in the repo, diffable in review, and
 * the same format the extension already uses. So the markdown is the source of
 * truth and this reads it, rather than the release notes being duplicated into
 * a data file that would quietly drift from the one people actually edit.
 *
 * It parses only the shape that file has — `## [version] - date`, `### Group`,
 * `- item` — and returns structured spans rather than HTML, so the dialog can
 * render real elements and never has to inject markup into the page.
 */

/** One run of formatted text inside a changelog line. */
export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** One `### Added` / `### Fixed` group within a release. */
export interface ChangelogSection {
  title: string;
  items: Span[][];
}

/** One `## [1.0.2] - 2026-08-28` release, newest first in the parsed list. */
export interface ChangelogRelease {
  version: string;
  /** As written in the heading; absent when the heading carries no date. */
  date?: string;
  sections: ChangelogSection[];
}

const RELEASE_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
/** `**bold**`, `` `code` ``, `[text](href)` — the only inline markup used. */
const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Releases in document order (newest first, as the file is written). Anything
 * above the first `##` is preamble and is dropped: it explains the file to
 * people reading the repo, not to people reading the dialog.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | undefined;
  let section: ChangelogSection | undefined;
  let pending: string | undefined;

  const flush = (): void => {
    if (pending !== undefined && section !== undefined) {
      section.items.push(parseInline(pending));
    }
    pending = undefined;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const asRelease = RELEASE_RE.exec(line);
    if (asRelease !== null) {
      flush();
      section = undefined;
      release = { version: asRelease[1], date: asRelease[2], sections: [] };
      releases.push(release);
      continue;
    }
    if (release === undefined) {
      continue;
    }

    const asSection = SECTION_RE.exec(line);
    if (asSection !== null) {
      flush();
      section = { title: asSection[1], items: [] };
      release.sections.push(section);
      continue;
    }

    // A bullet starts at the margin; anything indented under one continues it,
    // which is how every multi-line entry in the file is wrapped.
    if (line.startsWith('- ') || line.startsWith('* ')) {
      flush();
      pending = line.slice(2).trim();
    } else if (line.trim() === '') {
      flush();
    } else if (pending !== undefined) {
      pending = `${pending} ${line.trim()}`;
    }
  }
  flush();

  return releases;
}

/** Split one line into text/bold/code/link runs, in order. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0;
    if (at > cursor) {
      spans.push({ kind: 'text', text: text.slice(cursor, at) });
    }
    if (match[1] !== undefined) {
      spans.push({ kind: 'strong', text: match[1] });
    } else if (match[2] !== undefined) {
      spans.push({ kind: 'code', text: match[2] });
    } else {
      spans.push({ kind: 'link', text: match[3], href: match[4] });
    }
    cursor = at + match[0].length;
  }
  if (cursor < text.length) {
    spans.push({ kind: 'text', text: text.slice(cursor) });
  }
  return spans;
}
