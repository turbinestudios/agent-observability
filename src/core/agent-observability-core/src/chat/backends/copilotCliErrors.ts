import { FriendlyError } from '../lmErrors';
import { CliBackendError } from './cliError';

/**
 * Pure mapping of Copilot CLI failures to friendly, user-facing messages — the
 * `claudeErrors.ts` counterpart for the second vendor. Matching is by
 * lowercased substring of `code`/`message`/`stderrTail`, so it survives
 * wording drift across CLI versions.
 *
 * Cancellation is deliberately NOT mapped here: the backend throws an error
 * named `Canceled`, routed through the shared `isCancellation()` before ever
 * reaching this function.
 */

/** Host-specific phrasing for where a custom CLI path can be configured. */
export interface CopilotCliHints {
  /** Imperative clause, e.g. "set the Copilot CLI path in Settings". */
  cliPathHint: string;
}

/** Default hints: the VS Code extension's setting id (unused there today). */
export const VSCODE_COPILOT_CLI_HINTS: CopilotCliHints = {
  cliPathHint: 'set `agentObservability.aiHelper.copilotCliPath`',
};

/**
 * The one "CLI missing" sentence, shared by `isAvailable()` and the ENOENT
 * error mapping so the two can never drift apart.
 */
export function copilotCliMissingMessage(hints: CopilotCliHints): string {
  return (
    'GitHub Copilot CLI not found — install it (`npm install -g @github/copilot`) ' +
    `or ${hints.cliPathHint}.`
  );
}

/** Structured failure thrown by the Copilot CLI backend around a run. */
export class CopilotCliError extends CliBackendError {
  constructor(message: string, options?: { code?: string; exitCode?: number; stderrTail?: string }) {
    super(message, options);
    this.name = 'CopilotCliError';
  }
}

/** Map any thrown Copilot CLI error to a friendly message + recoverability. */
export function describeCopilotCliError(
  err: unknown,
  hints: CopilotCliHints = VSCODE_COPILOT_CLI_HINTS,
): FriendlyError {
  const { code, message, stderrTail } = read(err);
  const probe = `${code} ${message} ${stderrTail}`;

  if (probe.includes('enoent')) {
    return {
      message: `${copilotCliMissingMessage(hints)} Then try again.`,
      recoverable: false,
    };
  }
  if (
    probe.includes('log in') ||
    probe.includes('login') ||
    probe.includes('logged out') ||
    probe.includes('sign in') ||
    probe.includes('authentication') ||
    probe.includes('unauthorized') ||
    probe.includes('401')
  ) {
    return {
      message: 'You are not signed in to GitHub Copilot. Run `copilot login` in a terminal, then try again.',
      recoverable: true,
    };
  }
  if (
    probe.includes('rate limit') ||
    probe.includes('quota') ||
    probe.includes('credit') ||
    probe.includes('429') ||
    probe.includes('usage limit')
  ) {
    return {
      message: 'Copilot is rate-limited or your usage allowance was reached. Try again later.',
      recoverable: true,
    };
  }
  // Before the model branch: an older CLI rejecting a flag is a version
  // problem, not a model problem.
  if (probe.includes('unknown option') || probe.includes('unrecognized')) {
    return {
      message:
        'Your Copilot CLI version doesn’t support the options this app uses. ' +
        'Update it (`copilot update`) and try again.',
      recoverable: true,
    };
  }
  if (probe.includes('model') && (probe.includes('not found') || probe.includes('invalid') || probe.includes('unknown'))) {
    return {
      message: 'The selected Copilot model is unavailable. Pick a different model and try again.',
      recoverable: true,
    };
  }
  const detail = message.length > 0 ? message : stderrTail.length > 0 ? stderrTail : 'an unexpected error occurred';
  return { message: `The request could not be completed — ${detail}.`, recoverable: false };
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
