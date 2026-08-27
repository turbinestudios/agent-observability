/**
 * Path tidying shared by the signals that report context files.
 *
 * Copilot reports the same file through more than one channel — discovery
 * events, tool reads, and the system prompt's own file list — and they do not
 * agree on escaping. The system prompt in particular carries paths that were
 * escaped for JSON and never unescaped, arriving as `c:\\Projects\\…`.
 *
 * That is more than cosmetic. A path escaped in one channel and clean in
 * another does not compare equal, so the same file is listed twice and its size
 * is counted twice against the context budget.
 */

/**
 * Collapse runs of backslashes down to one.
 *
 * A UNC path genuinely begins with two (`\\wsl$\Ubuntu\home`), so the leading
 * pair is preserved and only the rest is collapsed.
 */
export function collapseRepeatedSeparators(filePath: string): string {
  const isUnc = filePath.startsWith('\\\\');
  const body = isUnc ? filePath.slice(2) : filePath;
  return `${isUnc ? '\\\\' : ''}${body.replace(/\\{2,}/g, '\\')}`;
}
