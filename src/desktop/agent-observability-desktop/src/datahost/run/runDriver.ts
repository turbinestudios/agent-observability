import type { RunPermissionDecision } from '../../shared/runTypes';
import type { SessionScope } from './permissionScope';

/**
 * The seam between the run host and whatever actually talks to the agent.
 *
 * `sdkDriver.ts` is the one implementation and the only file that imports the
 * Copilot SDK. Everything else — the controller, the tests, a future driver —
 * sees only these driver-neutral shapes, so the SDK can change or move to
 * another process without touching the RPC surface.
 *
 * A driver never decides a permission by itself. It hands each request up and
 * waits for `respondPermission`. The one wholesale switch is `setAllowAll`,
 * which turns the runtime's own allow-all mode on or off for one session and
 * is only ever called on the user's explicit choice for that session.
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
  /** The web address, for a `url` request. */
  url?: string;
  canAllowSession: boolean;
  /** What a session-wide approval of this request covers; absent when it can only be approved once. */
  sessionScope?: SessionScope;
  /**
   * True when the request must be put to the user whatever the session's mode:
   * an organisation policy requires approval, or the agent asks to leave its
   * sandbox.
   */
  mustAsk: boolean;
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
  /** `disconnected`: the runtime behind the session is gone, and with it every mode set on it. */
  | { type: 'error'; message: string; disconnected?: true }
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
  /**
   * Turn the runtime's own allow-all mode on or off for one session: what
   * `copilot --allow-all` turns on, scoped to this session. Resolves `false`
   * when the runtime did not take the change, for example because a policy
   * turns allow-all off.
   */
  setAllowAll(sessionId: string, enabled: boolean): Promise<boolean>;
  /** `undefined` cancels the question. */
  respondInput(sessionId: string, requestId: string, answer: string | undefined): void;
  /** Stop the runtime and every session. Safe to call twice. */
  dispose(): Promise<void>;
}
