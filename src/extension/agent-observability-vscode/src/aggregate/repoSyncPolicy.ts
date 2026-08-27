import { sanitizeRepositorySlug, UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';

/**
 * Per-repository sync scoping policy.
 *
 * Cloud sync reads the MERGED local telemetry, which spans every repository the
 * developer has used Copilot in — not just the open workspace. This module is
 * the single source of truth for deciding which of those repositories' aggregate
 * rows are allowed to leave the machine. It is intentionally `vscode`-free and
 * pure so it unit-tests headless and can be shared by the sync engine, the
 * preview command, and the Sync view's scope summary.
 *
 * Privacy note: scoping only ever uploads LESS. The default mode is `include`
 * with an empty repository list, so a fresh install uploads NOTHING until the
 * user explicitly picks repositories to share. `all` is the opt-in escape hatch
 * for uploading every repository. An unrecognized (hand-edited) mode fails safe
 * to `all` rather than silently dropping uploads.
 */

/** Which repositories are uploaded. `include` (the default) = only listed repos. */
export type RepoSyncMode = 'all' | 'include' | 'exclude';

/** The three valid modes, exported for validation at the config boundary. */
export const REPO_SYNC_MODES: readonly RepoSyncMode[] = ['all', 'include', 'exclude'];

/**
 * A resolved policy: the mode plus the set of sanitized repository identifiers it
 * applies to. The set is empty for `all`. Entries are the same canonical
 * `https://{host}/{owner}/{repo}` form (or the literal `unknown`) that
 * {@link AggregationRow.repository} carries, so membership tests are exact.
 */
export interface RepoSyncPolicy {
  mode: RepoSyncMode;
  repositories: ReadonlySet<string>;
}

/** A policy that uploads everything — the opt-in `all` mode. */
export const ALL_REPOSITORIES_POLICY: RepoSyncPolicy = {
  mode: 'all',
  repositories: new Set<string>(),
};

/**
 * Normalize a raw (possibly hand-edited) repository list into the canonical set
 * membership tests use. Every entry passes through {@link sanitizeRepositorySlug}
 * — the SAME chokepoint the row values pass through — so a hand-typed
 * `org/repo`, a trailing `.git`, an SCP-style remote, or odd casing all converge
 * with the canonical row form and match as expected. The literal `unknown` token
 * is passed through verbatim so users can scope sessions with no detected git
 * remote; an entry that fails to sanitize is DROPPED — mapping it to `unknown`
 * would silently scope the whole no-remote bucket on a typo. Shared by the sync
 * scope and the local `excludedRepositories` filter.
 */
export function normalizeRepositoryList(raw: readonly string[]): Set<string> {
  const repositories = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      continue;
    }
    if (entry.trim() === UNKNOWN_REPOSITORY) {
      repositories.add(UNKNOWN_REPOSITORY);
      continue;
    }
    const sanitized = sanitizeRepositorySlug(entry);
    if (sanitized !== UNKNOWN_REPOSITORY) {
      repositories.add(sanitized);
    }
  }
  return repositories;
}

/**
 * Build a policy from a (possibly hand-edited) settings value.
 *
 * The raw list is normalized through {@link normalizeRepositoryList}. An
 * unrecognized mode falls back to `all` rather than silently dropping uploads.
 */
export function buildRepoSyncPolicy(mode: string, raw: readonly string[]): RepoSyncPolicy {
  const resolvedMode: RepoSyncMode = (REPO_SYNC_MODES as readonly string[]).includes(mode)
    ? (mode as RepoSyncMode)
    : 'all';
  if (resolvedMode === 'all') {
    return ALL_REPOSITORIES_POLICY;
  }
  return { mode: resolvedMode, repositories: normalizeRepositoryList(raw) };
}

/**
 * Whether a single sanitized `repository` is allowed to sync under `policy`.
 * `include` admits only listed repositories; `exclude` admits all but the
 * listed; `all` admits everything.
 */
export function isRepositoryIncluded(repository: string, policy: RepoSyncPolicy): boolean {
  if (policy.mode === 'all') {
    return true;
  }
  const listed = policy.repositories.has(repository);
  return policy.mode === 'include' ? listed : !listed;
}

/** Filter aggregation-shaped rows by their `repository` under `policy`. */
export function filterRowsByPolicy<T extends { repository: string }>(
  rows: readonly T[],
  policy: RepoSyncPolicy,
): T[] {
  if (policy.mode === 'all') {
    return [...rows];
  }
  return rows.filter((r) => isRepositoryIncluded(r.repository, policy));
}
