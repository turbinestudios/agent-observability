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
  'No prompts, no responses, no file contents, no file paths, and no email ' +
  'or personal identity.';

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
