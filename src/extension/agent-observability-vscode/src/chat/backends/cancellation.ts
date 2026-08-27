/**
 * Host-neutral cancellation types for the chat backends.
 *
 * `vscode.CancellationToken` is structurally assignable to {@link CancellationToken},
 * so the extension keeps passing its own tokens straight through and the desktop
 * app can supply its own (e.g. wrapping an `AbortController`) without depending
 * on VS Code. Declared here so no core module needs a `vscode` import at all —
 * not even a type-only one.
 */

/** Anything with a `dispose()` — `vscode.Disposable` satisfies this. */
export interface DisposableLike {
  dispose(): unknown;
}

/** Signals that in-flight work should stop. Mirrors `vscode.CancellationToken`. */
export interface CancellationToken {
  /** Whether cancellation has already been requested. */
  readonly isCancellationRequested: boolean;
  /** Subscribe to cancellation; dispose the result to unsubscribe. */
  onCancellationRequested(listener: (e: unknown) => unknown): DisposableLike;
}

/** A token that is never cancelled — for callers with nothing to cancel. */
export const NEVER_CANCELLED: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};
