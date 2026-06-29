/**
 * A minimal, `vscode`-free logging seam.
 *
 * The rest of the extension keeps `vscode` behind interfaces so units run headless
 * under vitest (see vitest.config.ts — the `vscode` module is unavailable outside
 * the Extension Host). This interface is that seam for diagnostic logging: services
 * depend on {@link Logger}, and the extension wires the concrete
 * {@link OutputChannelLogger} (which owns a VS Code LogOutputChannel) at activation.
 *
 * PRIVACY: this log is for DIAGNOSTICS, not telemetry, and it stays on the machine.
 * Callers MUST pass only non-sensitive, content-free metadata — counts, ids,
 * statuses, durations, ports, error messages. NEVER pass raw prompts/completions/
 * tool I/O, file contents, repository-relative paths beyond what is necessary, the
 * organization API key, or the pseudonym salt. This mirrors the rule the sync path
 * already follows ("the API key and request body are NEVER logged").
 */
export interface Logger {
  /** Verbose diagnostic detail (hidden unless the user lowers the log level). */
  debug(message: string): void;
  /** Normal lifecycle events (activation, sync outcome, live-pipeline state). */
  info(message: string): void;
  /** Recoverable problems worth surfacing in the log. */
  warn(message: string): void;
  /** Failures. Pass the thrown value as `err` to append its (content-free) message. */
  error(message: string, err?: unknown): void;
}

/** A {@link Logger} that drops everything — the default when no channel is wired. */
export class NoopLogger implements Logger {
  debug(_message: string): void {}
  info(_message: string): void {}
  warn(_message: string): void {}
  error(_message: string, _err?: unknown): void {}
}

/** Normalize an unknown thrown value to a short message for logging. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
