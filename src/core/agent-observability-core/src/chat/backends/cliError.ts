/**
 * Structured failure thrown by any CLI-spawning chat backend (Claude Code,
 * GitHub Copilot CLI). Callers that only need to know "this was a CLI failure
 * the backend can describe" — the deep retrospective's error mapping, for one —
 * catch this base rather than a vendor's subclass, so a second vendor is not a
 * second catch site.
 */
export class CliBackendError extends Error {
  code?: string;
  exitCode?: number;
  stderrTail?: string;

  constructor(message: string, options?: { code?: string; exitCode?: number; stderrTail?: string }) {
    super(message);
    this.name = 'CliBackendError';
    this.code = options?.code;
    this.exitCode = options?.exitCode;
    this.stderrTail = options?.stderrTail;
  }
}
