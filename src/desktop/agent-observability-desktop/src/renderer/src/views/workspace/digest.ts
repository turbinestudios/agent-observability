import {
  buildRepositoryDigest,
  renderRepositoryDigestMarkdown,
} from '@agent-observability/core/src/analysis/repositoryDigest';
import type { RepositoryDigestInput } from '../../../../shared/rpc';
import { themeLabel } from '../sessions/retro';

/**
 * The digest as Markdown. The datahost sends friction themes by signal id
 * only; the renderer owns their wording (`themeLabel`), so the substitution
 * happens here and the datahost never grows a second copy of that table.
 */
export function renderDigest(input: RepositoryDigestInput): string {
  const labelled: RepositoryDigestInput = {
    ...input,
    themes: input.themes.map((theme) => ({ ...theme, label: themeLabel(theme.signalId) })),
  };
  return renderRepositoryDigestMarkdown(buildRepositoryDigest(labelled));
}
