/**
 * Wire types for Run: Copilot sessions the app hosts through the Copilot SDK.
 *
 * Import-free like `rpc.ts`, which re-exports these. Everything here travels
 * between the data host and the renderer on this machine only; nothing in
 * this file is on an aggregate, sync or team path.
 */

/** What a hosted session is doing. Exact: it comes from the runtime's events. */
export type RunStatus =
  | 'starting'
  | 'working'
  | 'waiting-approval'
  | 'waiting-input'
  | 'idle'
  | 'stopped'
  | 'error';

/** Which view prefilled the goal box. Recorded so a session can say where it began. */
export type RunDoor = 'blank' | 'continue-session' | 'repo-digest' | 'improve-plan' | 'retro-advice' | 'handoff-brief';

/** An editable starting point. Nothing is sent until the user presses Start. */
export interface RunPrefill {
  door: RunDoor;
  goal: string;
  repository?: string;
  /** Set when the door continues an existing Copilot CLI session. */
  resumeSessionId?: string;
}

export interface RunSessionInfo {
  sessionId: string;
  repository: string;
  /** The working directory the session runs in. LOCAL-ONLY display. */
  cwd: string;
  model?: string;
  status: RunStatus;
  startedAtMs: number;
  lastActivityMs: number;
  title?: string;
  door: RunDoor;
}

/** Longest command or intention text carried to the renderer. */
export const RUN_PERMISSION_TEXT_MAX = 4000;

/**
 * One thing the agent wants to do and may not do until the user answers.
 * Carries what the user needs to decide — the exact command or file — and
 * never the full diff body (only how many lines it adds and removes).
 */
export interface RunPermissionRequest {
  requestId: string;
  sessionId: string;
  kind: string;
  toolName?: string;
  fileName?: string;
  commandText?: string;
  intention?: string;
  diffStat?: { added: number; removed: number };
  /** False when the runtime will not accept a session-wide approval for this request. */
  canAllowSession: boolean;
}

/** The only three answers the app can give. Nothing persists beyond the session. */
export type RunPermissionDecision = 'allow-once' | 'allow-session' | 'deny';

export type RunItem =
  | { kind: 'user'; id: string; text: string; atMs: number }
  | { kind: 'assistant'; id: string; html: string; done: boolean }
  | { kind: 'reasoning'; id: string; html: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; summary: string; state: 'running' | 'ok' | 'failed'; durationMs?: number }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string };

export interface RunInputRequest {
  requestId: string;
  sessionId: string;
  question: string;
  choices?: string[];
}

export interface RunAvailability {
  /** The Settings gate. */
  enabled: boolean;
  /** The first-use notice has been acknowledged. */
  acknowledged: boolean;
  cliFound: boolean;
  cliVersion?: string;
  signedIn?: boolean;
  /** A human-readable reason Run cannot start, with the fix. */
  problem?: string;
  models: { id: string; label: string }[];
}

/** One change to a hosted session, pushed as it happens. */
export type RunEventChange =
  | { type: 'status'; status: RunStatus }
  /** Upsert by `item.id`; assistant and reasoning HTML is host-rendered. */
  | { type: 'item'; item: RunItem }
  | { type: 'permission'; request: RunPermissionRequest }
  | { type: 'permission-cleared'; requestId: string }
  | { type: 'input'; request: RunInputRequest }
  | { type: 'input-cleared'; requestId: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; nanoAiu?: number };

/** What `run.transcript` returns: enough to rebuild the view after a remount. */
export interface RunTranscript {
  info: RunSessionInfo;
  items: RunItem[];
  pendingPermission?: RunPermissionRequest;
  pendingInput?: RunInputRequest;
}

/** A hosted session as the live board sees it: exact, not inferred from disk. */
export interface RunLiveState {
  sessionId: string;
  status: RunStatus;
  waitingFor?: 'approval' | 'input';
  lastActivityMs: number;
  /** Names of tools running or awaiting approval. */
  pendingTools: string[];
}
