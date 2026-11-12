/**
 * Pure helpers for sharing a session as a file and importing one. Kept out
 * of the components so they can be tested without a window.
 */

/** The source imported sessions are listed under. */
export const SHARED_SOURCE = 'shared';

export function isSharedSession(source: string): boolean {
  return source === SHARED_SOURCE;
}

/** File sizes as people read them: `812 bytes`, `14 KB`, `3.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** What the share dialog says the file contains, item by item. */
export const SHARE_CONTAINS: readonly string[] = [
  'every prompt you wrote in the session, and the assistant’s responses',
  'the session title, repository name, models, and tool names',
  'turn timings, token counts, lines changed, files created and modified, and cost',
  'the Context Analysis: which context files were loaded, with their paths inside the repository',
];

/** What the share dialog says the file leaves out. */
export const SHARE_LEAVES_OUT: readonly string[] = [
  'your tags, notes, and hidden sessions',
  'tool inputs and outputs, and any file path outside the repository',
  'anything that identifies you or this computer',
];

/** The redaction line under the dialog's list; always says it is best effort. */
export function shareRedactionNote(count: number): string {
  const lead =
    count <= 0
      ? 'No secret-looking strings were found.'
      : count === 1
        ? '1 secret-looking string was replaced.'
        : `${count} secret-looking strings were replaced.`;
  return `${lead} Redaction is best effort and misses secrets written as plain prose, so read the session before you send it.`;
}

/** The one-line result of an import, for the notice above the list. */
export function importNotice(replaced: boolean): string {
  return replaced
    ? 'Updated the shared session you had imported before.'
    : 'Imported. Tick it and one of your own sessions, then press Compare.';
}

/** The first file a drop carries when it can be a shared session, else `undefined`. */
export function droppedShareFile<T extends { name: string }>(files: readonly T[]): T | undefined {
  return files.find((file) => file.name.toLowerCase().endsWith('.json'));
}
