/**
 * Privacy-critical repository URL sanitizer (SHARED with Phase 5 aggregation).
 *
 * A raw git remote can embed credentials (`https://user:token@host/...`,
 * `https://x-access-token:ghp_...@host/...`), query strings, fragments, or a
 * `.git` suffix — any of which would leak a PAT/credential or extra metadata
 * to the cloud. This module normalizes a raw remote to the canonical
 * `https://{host}/{owner}/{repo}` form and otherwise returns the literal
 * `'unknown'`.
 *
 * The output MUST satisfy the aggregate batch schema `repository` pattern
 * (`aggregate-batch.schema.json`):
 *
 *   ^(unknown|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$
 *
 * i.e. no `@`, `?`, `#`, or whitespace may survive — a credential-bearing
 * remote structurally cannot pass validation, so the whole batch is rejected
 * if sanitization is skipped. This sanitizer is the single chokepoint enforcing
 * that contract on the producer side.
 */

/** Literal returned for empty / unparseable input. */
export const UNKNOWN_REPOSITORY = 'unknown';

/**
 * The schema-mandated repository pattern. Kept here (and asserted in tests) so
 * every batch the producer emits passes the schema.
 */
export const REPOSITORY_PATTERN = /^(unknown|https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[^\s@?#]+)$/;

/**
 * Normalize a raw git remote URL to canonical `https://{host}/{owner}/{repo}`.
 *
 * Handles:
 * - HTTP(S) remotes — strips userinfo, query, fragment, trailing `.git`.
 * - SCP-style SSH (`git@host:owner/repo(.git)`) → `https://host/owner/repo`.
 * - URL-style SSH/git (`ssh://git@host/owner/repo`, `git://host/...`) → https.
 *
 * Returns {@link UNKNOWN_REPOSITORY} for null/blank/unparseable input, or any
 * result that would not match {@link REPOSITORY_PATTERN}.
 */
export function sanitizeRepositoryUrl(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return UNKNOWN_REPOSITORY;
  }

  let value = raw.trim();
  if (value.length === 0) {
    return UNKNOWN_REPOSITORY;
  }

  // Strip an explicit fragment/query early (they can appear before the path is
  // parsed for SCP-style remotes too).
  value = stripAfter(value, '#');
  value = stripAfter(value, '?');
  value = value.trim();
  if (value.length === 0) {
    return UNKNOWN_REPOSITORY;
  }

  const parsed = parse(value);
  if (parsed === null) {
    return UNKNOWN_REPOSITORY;
  }

  const host = parsed.host.toLowerCase();
  const path = normalizePath(parsed.path);
  if (host.length === 0 || path.length === 0) {
    return UNKNOWN_REPOSITORY;
  }

  const candidate = `https://${host}${parsed.port}/${path}`;
  return REPOSITORY_PATTERN.test(candidate) ? candidate : UNKNOWN_REPOSITORY;
}

/** A bare `owner/repo` GitHub slug: exactly one slash, no host, no scheme. */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Normalize a repository reported as a bare `owner/repo` slug to canonical
 * `https://github.com/owner/repo`.
 *
 * Autonomous Copilot CLI agents report their repository on
 * `github.copilot.git.repository` as a slug (no scheme, no host), where VS Code
 * Copilot Chat reports a full git remote on `copilot_chat.repo.remote_url`. A
 * slug carries no host, so `github.com` is assumed — the attribute lives in the
 * `github.copilot.*` namespace, which only GitHub-hosted agents emit.
 *
 * A value that already looks like a remote (`scheme://…`, `git@host:…`) is
 * handed to {@link sanitizeRepositoryUrl} unchanged, so a GHES-hosted agent that
 * reports a full URL still resolves. Anything else returns
 * {@link UNKNOWN_REPOSITORY}. Every path funnels through
 * {@link sanitizeRepositoryUrl}, so this adds no new way for a credential-bearing
 * value to escape.
 */
export function sanitizeRepositorySlug(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return UNKNOWN_REPOSITORY;
  }
  const value = raw.trim();
  if (value.length === 0) {
    return UNKNOWN_REPOSITORY;
  }
  // Already a remote (URL-style or SCP-style) — the URL sanitizer owns it.
  if (value.includes('://') || value.includes('@') || value.includes(':')) {
    return sanitizeRepositoryUrl(value);
  }
  return SLUG_PATTERN.test(value)
    ? sanitizeRepositoryUrl(`https://github.com/${value}`)
    : UNKNOWN_REPOSITORY;
}

interface ParsedRemote {
  host: string;
  /** Port suffix including the leading colon, or empty string. */
  port: string;
  /** Path WITHOUT leading slash, before normalization. */
  path: string;
}

/** Everything before the first occurrence of `marker`. */
function stripAfter(value: string, marker: string): string {
  const idx = value.indexOf(marker);
  return idx === -1 ? value : value.slice(0, idx);
}

/** Drop any `user:token@` userinfo segment from an authority component. */
function stripUserinfo(authority: string): string {
  const at = authority.lastIndexOf('@');
  return at === -1 ? authority : authority.slice(at + 1);
}

/**
 * Parse a remote into host/port/path, covering URL-style and SCP-style SSH.
 * Returns null when the remote cannot be confidently parsed.
 */
function parse(value: string): ParsedRemote | null {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (schemeMatch) {
    // URL-style: scheme://[user@]host[:port]/path
    const rest = value.slice(schemeMatch[0].length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      return null;
    }
    const authority = stripUserinfo(rest.slice(0, slash));
    const path = rest.slice(slash + 1);
    return splitAuthority(authority, path);
  }

  // SCP-style SSH: [user@]host:owner/repo
  // Distinguished from a Windows path by requiring a non-drive host and a
  // colon that is NOT immediately followed by a digit-only port + slash form
  // we already handle above.
  const scpMatch = /^([^/@]*@)?([^/:]+):(.+)$/.exec(value);
  if (scpMatch) {
    const host = scpMatch[2];
    const path = scpMatch[3];
    // Reject obvious non-host single letters (e.g. Windows drive "C:") — a git
    // host always has a dot or is at least longer than one char.
    if (host.length <= 1 || !host.includes('.')) {
      return null;
    }
    return splitAuthority(host, path);
  }

  return null;
}

/** Split an authority (host[:port]) and pair it with a path. */
function splitAuthority(authority: string, path: string): ParsedRemote | null {
  const cleaned = stripUserinfo(authority);
  const colon = cleaned.indexOf(':');
  if (colon === -1) {
    return { host: cleaned, port: '', path };
  }
  const host = cleaned.slice(0, colon);
  const portRaw = cleaned.slice(colon + 1);
  if (!/^[0-9]+$/.test(portRaw)) {
    return null;
  }
  return { host, port: `:${portRaw}`, path };
}

/** Trim slashes, drop a trailing `.git`, and collapse the path. */
function normalizePath(rawPath: string): string {
  let path = rawPath.trim();
  // Remove any leading/trailing slashes.
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  // Drop a trailing ".git" (case-insensitive) on the final segment.
  path = path.replace(/\.git$/i, '');
  // Re-trim a trailing slash that a ".git" strip might have exposed.
  path = path.replace(/\/+$/, '');
  return path;
}
