/**
 * Escape a string for safe interpolation into HTML text/attribute context.
 *
 * Privacy/security-critical: raw `userRequest` prompts and any model/tool/repo
 * strings rendered into the local session-detail webview MUST pass through this
 * first. Prompts can legitimately contain `<`, `>`, `&`, quotes, or full markup
 * (e.g. a pasted `<img src=x onerror=...>`); escaping the five significant
 * characters prevents that content from being parsed as live HTML/markup, so it
 * is displayed verbatim as text rather than executed.
 *
 * No `vscode` import here so the function stays unit-testable headless.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
