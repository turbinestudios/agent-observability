import markdown from '../../../../CHANGELOG.md?raw';
import { parseChangelog } from './parseChangelog';

/**
 * The app's release notes, parsed once at module load.
 *
 * The markdown is inlined by the bundler rather than read at runtime, so the
 * dialog works identically in a packaged build, where the repo's `CHANGELOG.md`
 * is not on disk.
 */
export const RELEASES = parseChangelog(markdown);
