import type {
  RunItem,
  RunPermissionDecision,
  RunPermissionMode,
  RunPermissionRequest,
  RunStatus,
} from '../../../../shared/runTypes';

/**
 * Presentation rules for the Run view, split from the components so they test
 * under the node-only vitest setup.
 */

export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting';
    case 'working':
      return 'Working';
    case 'waiting-approval':
      return 'Waiting for your approval';
    case 'waiting-input':
      return 'Waiting for your answer';
    case 'idle':
      return 'Waiting for you';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
  }
}

/**
 * Whether the agent is doing something right now, as opposed to waiting on
 * the user. The view shows a moving spinner for exactly these, so a session
 * that is busy never looks the same as one that has stopped.
 */
export function isBusy(status: RunStatus): boolean {
  return status === 'working' || status === 'starting';
}

/** The line beside the spinner at the end of the transcript. */
export function busyLabel(status: RunStatus): string {
  return status === 'starting' ? 'Starting the session…' : 'The agent is working…';
}

/** Whether the goal box may send right now. */
export function canSend(status: RunStatus): boolean {
  return status === 'idle' || status === 'stopped' || status === 'error';
}

/** Whether Stop does anything right now. */
export function canStop(status: RunStatus): boolean {
  return status === 'working' || status === 'waiting-approval' || status === 'waiting-input' || status === 'starting';
}

/** What the agent is asking to do, in the user's words. */
export function permissionKindLabel(kind: string): string {
  switch (kind) {
    case 'shell':
      return 'Run a command';
    case 'write':
      return 'Change a file';
    case 'read':
      return 'Read a file';
    case 'url':
      return 'Open a web address';
    case 'mcp':
      return 'Use a connected tool';
    case 'custom-tool':
      return 'Use a tool';
    case 'memory':
      return 'Save a memory';
    case 'hook':
      return 'Run a hook';
    default:
      return 'Do something that needs your approval';
  }
}

/** The one thing the user must read before answering: the exact command or file. */
export function permissionSubject(request: RunPermissionRequest): string {
  if (request.commandText !== undefined && request.commandText.length > 0) {
    return request.commandText;
  }
  if (request.fileName !== undefined && request.fileName.length > 0) {
    return request.fileName;
  }
  return request.toolName ?? request.intention ?? '';
}

/** `+12 -3` for a file change; hand-formatted so every machine prints the same. */
export function diffStatLabel(request: RunPermissionRequest): string | undefined {
  return request.diffStat === undefined ? undefined : `+${request.diffStat.added} -${request.diffStat.removed}`;
}

export interface PermissionButton {
  decision: RunPermissionDecision;
  label: string;
  primary: boolean;
}

/**
 * The only three answers there are. "Allow for this session" is offered only
 * when the runtime accepts it, says what it covers, and is never the
 * highlighted choice: the default action is the narrowest one.
 */
export function permissionButtons(request: RunPermissionRequest): PermissionButton[] {
  const buttons: PermissionButton[] = [{ decision: 'allow-once', label: 'Allow once', primary: true }];
  if (request.canAllowSession) {
    buttons.push({
      decision: 'allow-session',
      label:
        request.sessionScopeLabel !== undefined && request.sessionScopeLabel.length > 0
          ? `Allow ${request.sessionScopeLabel} for this session`
          : 'Allow for this session',
      primary: false,
    });
  }
  buttons.push({ decision: 'deny', label: 'Deny', primary: false });
  return buttons;
}

/** "2 more requests are waiting" under the card, or nothing when this is the only one. */
export function permissionQueueLabel(request: RunPermissionRequest): string | undefined {
  const more = request.more ?? 0;
  if (more <= 0) {
    return undefined;
  }
  return more === 1 ? '1 more request is waiting behind this one.' : `${more} more requests are waiting behind this one.`;
}

/** The two permission modes, in the order the picker lists them. The first is the default. */
export const PERMISSION_MODE_OPTIONS: readonly { mode: RunPermissionMode; label: string }[] = [
  { mode: 'default', label: 'Default permissions' },
  { mode: 'allow-all', label: 'Allow all' },
];

/** What the user reads before Allow all is turned on. */
export const ALLOW_ALL_WARNING =
  'Allow all is the same as starting copilot with --allow-all: the agent changes files, runs commands and opens web addresses without asking you first, also outside this repository\'s folder. It applies to this session only and is not remembered. If your Copilot settings or your organisation turn allow-all off, it cannot be turned on here.';

/** One line for a tool row: its name, what it acted on, and how it went. */
export function toolRowSummary(item: Extract<RunItem, { kind: 'tool' }>): string {
  const target = item.summary.length > 0 ? ` ${item.summary}` : '';
  switch (item.state) {
    case 'running':
      return `${item.name}${target} · running`;
    case 'ok':
      return `${item.name}${target} · done${durationSuffix(item.durationMs)}`;
    case 'failed':
      return `${item.name}${target} · failed${durationSuffix(item.durationMs)}`;
  }
}

function durationSuffix(ms: number | undefined): string {
  if (ms === undefined) {
    return '';
  }
  if (ms < 1000) {
    return ` in ${Math.round(ms)} ms`;
  }
  return ` in ${(ms / 1000).toFixed(1)} s`;
}
