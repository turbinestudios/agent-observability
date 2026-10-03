/**
 * Single source of truth for the consent disclosure copy.
 *
 * Both the `toggleConsent` command (modal) and the Sync view (tree summary)
 * render the same WHAT-IS-SHARED vs WHAT-IS-NOT statement, so the privacy promise
 * the user agrees to and the one the UI displays can never drift. The wording
 * mirrors `aggregate-payload-schema-v1.md` (§2, §3, §7) and the forbidden-fields
 * list there.
 */

/** What an aggregate batch DOES contain (non-sensitive measures only). */
export const WHAT_IS_SHARED =
  'Aggregate counts, token totals and latency buckets per 30-minute bin, ' +
  'grouped by repository, model, agent mode and tool, under a pseudonymous ' +
  'developer id.';

/** What is NEVER uploaded (raw content / identity / paths). */
export const WHAT_IS_NOT_SHARED =
  'No prompts, no responses, no file contents, no source-file paths (the only ' +
  'paths are the repo-relative names of context files such as AGENTS.md or a ' +
  'skill file), and no email or personal identity.';

/** A one-line condensed summary for compact UI (tree-item tooltip). */
export const DISCLOSURE_SUMMARY =
  `Shared: ${WHAT_IS_SHARED} Not shared: ${WHAT_IS_NOT_SHARED}`;

/**
 * Build the modal body shown when toggling consent. `turningOn` selects the
 * leading sentence (enabling vs disabling) but the shared/not-shared disclosure
 * is identical either way.
 */
export function consentModalDetail(turningOn: boolean): string {
  const lead = turningOn
    ? 'Enable cloud sharing? Only aggregated, non-sensitive statistics will be uploaded to your organization dashboard.'
    : 'Disable cloud sharing? No aggregates will be uploaded.';
  return (
    `${lead}\n\n` +
    `What IS shared: ${WHAT_IS_SHARED}\n\n` +
    `What is NOT shared: ${WHAT_IS_NOT_SHARED}`
  );
}

/**
 * What the desktop app's TEAM SHARD contains: the cloud-sharing aggregates plus
 * the one block the shard adds, per-day session outcomes. Nothing else.
 */
export const TEAM_WHAT_IS_SHARED =
  WHAT_IS_SHARED +
  ' Also, per day and repository: how many sessions ran, how they went (smooth, ' +
  'bumpy, struggled, abandoned or not judged) and their estimated cost.';

/**
 * The body of the dialog shown when team sharing is turned on. Names the
 * folder, what is written there and for whom, both halves of the disclosure,
 * and the repositories the shard would cover.
 */
export function teamConsentDetail(folder: string, repositories: readonly string[]): string {
  const list = repositories.length === 0 ? 'none yet' : repositories.join(', ');
  const nl = String.fromCharCode(10);
  return [
    `Share with the team folder ${folder}?`,
    'One file named after your anonymous id will be written there and rewritten ' +
      'on each export. Anyone with access to the folder can read it.',
    `What IS shared: ${TEAM_WHAT_IS_SHARED}`,
    `What is NOT shared: ${WHAT_IS_NOT_SHARED}`,
    `Repositories included: ${list}`,
  ].join(nl + nl);
}
