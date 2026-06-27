/**
 * Pure mapping of Language Model failures to friendly, user-facing messages.
 *
 * Kept free of any `vscode` import so it is unit-testable headless: it inspects a
 * structural `{ name?, code?, message? }` shape rather than `instanceof
 * vscode.LanguageModelError`. The provider catches the real error and passes it
 * here. Matching is by lowercased substring of `code`/`name` so it is resilient
 * to the exact `LanguageModelError.code` constants across `@types/vscode`
 * versions (the behavior, not the literal, is what we depend on).
 */

/** A friendly description of an LM failure. */
export interface FriendlyError {
  message: string;
  /** Whether retrying (after the user acts) can plausibly succeed. */
  recoverable: boolean;
}

/** Structural view of a thrown error — what we can read without importing vscode. */
interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

/** Shown when no Copilot model is available (empty `selectChatModels` result). */
export function noModelsError(): FriendlyError {
  return {
    message:
      'No language model is available. Install and sign in to GitHub Copilot, then try again.',
    recoverable: false,
  };
}

/** Whether the thrown error represents a user/host cancellation (not a real failure). */
export function isCancellation(err: unknown): boolean {
  const { name, message } = read(err);
  return (
    name.includes('cancel') ||
    name === 'canceled' ||
    message.includes('canceled') ||
    message.includes('cancelled')
  );
}

/** Map any thrown LM error to a friendly message + recoverability. */
export function describeLmError(err: unknown): FriendlyError {
  const { code, message } = read(err);
  const probe = `${code} ${message}`;

  if (probe.includes('nopermission') || probe.includes('permission') || probe.includes('consent')) {
    return {
      message:
        'GitHub Copilot access was not granted. Allow the AI Helper to use your Copilot model when prompted, then try again.',
      recoverable: true,
    };
  }
  if (probe.includes('blocked') || probe.includes('content filter') || probe.includes('filtered')) {
    return {
      message: 'The request was blocked by the model’s content filter. Try rephrasing it.',
      recoverable: true,
    };
  }
  if (probe.includes('quota') || probe.includes('rate') || probe.includes('limit')) {
    return {
      message: 'Your GitHub Copilot quota or rate limit was reached. Try again later.',
      recoverable: true,
    };
  }
  if (probe.includes('not found') || probe.includes('notfound') || probe.includes('no such model')) {
    return {
      message: 'The selected Copilot model is unavailable. Pick a different model and try again.',
      recoverable: true,
    };
  }
  const detail = message.length > 0 ? message : 'an unexpected error occurred';
  return { message: `The AI Helper could not complete the request — ${detail}.`, recoverable: false };
}

/** Read the lowercased `name`/`code`/`message` of an error-like value. */
function read(err: unknown): { name: string; code: string; message: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  return {
    name: typeof e.name === 'string' ? e.name.toLowerCase() : '',
    code: typeof e.code === 'string' ? e.code.toLowerCase() : '',
    message: typeof e.message === 'string' ? e.message.toLowerCase() : '',
  };
}
