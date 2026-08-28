import { FriendlyError } from '../lmErrors';

/**
 * Pure mapping of Claude Code CLI failures to friendly, user-facing messages —
 * the Claude-backend counterpart of `lmErrors.ts`. Matching is by lowercased
 * substring of `code`/`message`/`stderrTail`, so it survives wording drift
 * across CLI versions.
 *
 * Cancellation is deliberately NOT mapped here: the backend throws an error
 * named `Canceled`, which the provider routes through the shared
 * `isCancellation()` before ever reaching this function.
 */

/**
 * Host-specific phrasing for where a custom CLI path can be configured. The
 * install hint is universal; where the "or point at it here" clause sends the
 * user differs per host (a VS Code setting id versus the desktop Settings view).
 */
export interface ClaudeCliHints {
  /** Imperative clause, e.g. "set `agentObservability.aiHelper.claudeCliPath`". */
  cliPathHint: string;
}

/** Default hints: the VS Code extension's setting id. */
export const VSCODE_CLI_HINTS: ClaudeCliHints = {
  cliPathHint: 'set `agentObservability.aiHelper.claudeCliPath`',
};

/**
 * The one "CLI missing" sentence, shared by `isAvailable()` and the ENOENT
 * error mapping so the two can never drift apart.
 */
export function cliMissingMessage(hints: ClaudeCliHints): string {
  return (
    'Claude Code CLI not found — install it (`npm install -g @anthropic-ai/claude-code`) ' +
    `or ${hints.cliPathHint}.`
  );
}

/** Structured failure thrown by the Claude backend around a CLI run. */
export class ClaudeCliError extends Error {
  code?: string;
  exitCode?: number;
  stderrTail?: string;

  constructor(message: string, options?: { code?: string; exitCode?: number; stderrTail?: string }) {
    super(message);
    this.name = 'ClaudeCliError';
    this.code = options?.code;
    this.exitCode = options?.exitCode;
    this.stderrTail = options?.stderrTail;
  }
}

/** Map any thrown Claude CLI error to a friendly message + recoverability. */
export function describeClaudeError(err: unknown, hints: ClaudeCliHints = VSCODE_CLI_HINTS): FriendlyError {
  const { code, message, stderrTail } = read(err);
  const probe = `${code} ${message} ${stderrTail}`;

  if (probe.includes('enoent')) {
    return {
      message: `${cliMissingMessage(hints)} Then try again.`,
      recoverable: false,
    };
  }
  if (
    probe.includes('log in') ||
    probe.includes('login') ||
    probe.includes('logged out') ||
    probe.includes('authentication') ||
    probe.includes('api key') ||
    probe.includes('unauthorized') ||
    probe.includes('401')
  ) {
    return {
      message: 'You are not signed in to Claude Code. Run `claude` in a terminal and complete `/login`, then try again.',
      recoverable: true,
    };
  }
  if (
    probe.includes('rate limit') ||
    probe.includes('overloaded') ||
    probe.includes('429') ||
    probe.includes('usage limit')
  ) {
    return {
      message: 'Claude is rate-limited or your usage limit was reached. Try again later.',
      recoverable: true,
    };
  }
  // Checked before the effort/model branches: an outdated CLI rejecting
  // "unknown option '--effort'" is a version problem, not an effort problem.
  if (probe.includes('unknown option') || probe.includes('unrecognized')) {
    return {
      message:
        'Your Claude Code CLI version doesn’t support the options the AI Helper uses. ' +
        'Update Claude Code (`claude update`) and try again.',
      recoverable: true,
    };
  }
  if (probe.includes('effort')) {
    return {
      message: 'The selected reasoning effort isn’t supported by this model. Pick a different effort level and try again.',
      recoverable: true,
    };
  }
  if (probe.includes('model') && (probe.includes('not found') || probe.includes('invalid') || probe.includes('unknown'))) {
    return {
      message: 'The selected Claude model is unavailable. Pick a different model and try again.',
      recoverable: true,
    };
  }
  const detail = message.length > 0 ? message : stderrTail.length > 0 ? stderrTail : 'an unexpected error occurred';
  return { message: `The AI Helper could not complete the request — ${detail}.`, recoverable: false };
}

/** Read the lowercased `code`/`message`/`stderrTail` of an error-like value. */
function read(err: unknown): { code: string; message: string; stderrTail: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
    stderrTail?: unknown;
  };
  return {
    code: typeof e.code === 'string' ? e.code.toLowerCase() : '',
    message: typeof e.message === 'string' ? e.message.toLowerCase() : '',
    stderrTail: typeof e.stderrTail === 'string' ? e.stderrTail.toLowerCase() : '',
  };
}
