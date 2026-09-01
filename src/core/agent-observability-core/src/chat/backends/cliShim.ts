/**
 * Running npm's Windows `.cmd` shims. Since Node's CVE-2024-27980 hardening,
 * spawning a `.cmd`/`.bat` file with `shell: false` throws **EINVAL
 * synchronously** — which is how a `copilot.cmd`-only install wedged every
 * `isAvailable()` probe. The sanctioned way is an explicit cmd.exe line:
 * `spawn(buildCmdShimLine(...), { shell: true })` (the STRING form), because
 * Node then passes the line verbatim inside `cmd /d /s /c "…"` and the
 * quoting stays fully ours.
 *
 * RULE FOR CALLERS: free-form user content (a chat prompt) must NEVER ride a
 * shimmed command line — cmd.exe expands `%VAR%` even inside double quotes.
 * Route prompts through stdin (Claude) or the payload file (Copilot); only
 * fixed flags, sanitized model ids, and app-generated paths may appear here,
 * and {@link buildCmdShimLine} refuses anything else outright.
 */

/** Whether this command must be run through cmd.exe rather than spawned directly. */
export function needsCmdShim(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim());
}

/**
 * One cmd.exe-ready line: every token double-quoted and space-joined. Tokens
 * that cmd.exe could reinterpret even inside quotes (`%`, `"`, newlines) are
 * refused — with our callers they cannot occur, so a throw here means a bug
 * upstream, never a user-facing path.
 */
export function buildCmdShimLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteForCmd).join(' ');
}

function quoteForCmd(token: string): string {
  if (/["\r\n%]/.test(token)) {
    throw new Error(
      `Unsafe token for a cmd.exe command line (starts "${token.slice(0, 20)}") — ` +
        'free-form content must travel via stdin or a payload file, never argv.',
    );
  }
  return `"${token}"`;
}
