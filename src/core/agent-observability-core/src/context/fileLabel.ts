import type { ContextFileEntry } from './models';

/**
 * What to call a context file in the list.
 *
 * Every skill's file is named `SKILL.md`, so a session that loaded nine skills
 * shows nine identical rows. The skill's identity is its containing folder, so
 * that is prefixed — `plan/SKILL.md` — which names the skill while keeping the
 * row recognizable as a file. The same applies to any other convention-named
 * file whose folder carries the meaning.
 *
 * The folder comes from the on-disk path, or, for a session imported from
 * someone else, from the repository-relative path the file carries instead.
 * Shared by the Context Analysis view and the shared-session exporter, which
 * keeps this label for files outside the repository in place of their path.
 */
export function contextFileLabel(f: Pick<ContextFileEntry, 'name' | 'filePath' | 'repoPath'>): string {
  if (!FOLDER_NAMED_FILES.has(f.name.toLowerCase())) {
    return f.name;
  }
  const parent = parentFolderName(f.filePath ?? f.repoPath);
  return parent === undefined ? f.name : `${parent}/${f.name}`;
}

/** Files whose folder, not their own name, is what identifies them. */
const FOLDER_NAMED_FILES = new Set(['skill.md', 'index.md', 'readme.md']);

/** The immediate folder of a path, or `undefined` when there is not one. */
function parentFolderName(filePath: string | undefined): string | undefined {
  if (filePath === undefined || filePath.length === 0) {
    return undefined;
  }
  const parts = filePath.split(/[\\/]+/).filter((p) => p.length > 0);
  // parts: [..., folder, file] — a bare filename has no folder to borrow.
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}
