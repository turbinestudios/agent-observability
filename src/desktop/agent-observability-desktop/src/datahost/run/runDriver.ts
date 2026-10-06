import type { RunPermissionDecision } from '../../shared/runTypes';

/**
 * The seam between the run host and whatever actually talks to the agent.
 *
 * `sdkDriver.ts` is the one implementation and the only file that imports the
 * Copilot SDK. Everything else — the controller, the tests, a future driver —
 * sees only these driver-neutral shapes, so the SDK can change or move to
 * another process without touching the RPC surface.
 *
 * A driver never decides a permission. It hands the request up and waits for
 * `respondPermission`; there is no "approve everything" path in this
 * interface, by construction.
 */

/** A permission request as the runtime raised it. Text fields are RAW; the controller caps them. */
export interface DriverPermission {
  requestId: string;
  kind: string;
  toolCallId?: string;
  toolName?: string;
  fileName?: string;
  commandText?: string;
  intention?: string;
  /** The unified diff, used only to count lines; never forwarded. */
  diff?: string;
  canAllowSession: boolean;
}

export type DriverEvent =
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'message'; messageId: string; text: string }
  | { type: 'reasoning-delta'; reasoningId: string; text: string }
  | { type: 'reasoning'; reasoningId: string; text: string }
  | { type: 'tool-start'; toolCallId: string; name: string; summary?: string }
  | { type: 'tool-end'; toolCallId: string; success: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; nanoAiu?: number }
  | { type: 'idle' }
  | { type: 'error'; message: string }
  | { type: 'permission'; request: DriverPermission }
  | { type: 'input'; requestId: string; question: string; choices?: string[] };

export type DriverPermissionAnswer =
  | { decision: RunPermissionDecision; feedback?: string }
  /** The user cannot answer: the app is quitting or the turn was aborted. */
  | { decision: 'unavailable' };

export interface DriverSessionOptions {
  sessionId: string;
  cwd: string;
  model?: string;
  onEvent: (event: DriverEvent) => void;
}

export interface DriverProbe {
  ok: boolean;
  cliVersion?: string;
  signedIn?: boolean;
  /** Why the runtime cannot be used, with the fix. */
  problem?: string;
}

export interface RunDriver {
  /** Start the runtime if needed and report whether sessions can run. */
  probe(): Promise<DriverProbe>;
  listModels(): Promise<{ id: string; label: string }[]>;
  start(options: DriverSessionOptions): Promise<void>;
  resume(options: DriverSessionOptions): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  /** Stop the current turn; the session stays resumable. */
  abort(sessionId: string): Promise<void>;
  /** Release the session in memory; it stays on disk. */
  close(sessionId: string): Promise<void>;
  respondPermission(sessionId: string, requestId: string, answer: DriverPermissionAnswer): void;
  /** `undefined` cancels the question. */
  respondInput(sessionId: string, requestId: string, answer: string | undefined): void;
  /** Stop the runtime and every session. Safe to call twice. */
  dispose(): Promise<void>;
}
