import type {
  RunAvailability,
  RunDoor,
  RunPermissionMode,
  RunPrefill,
  RunSessionInfo,
} from '../../../../shared/runTypes';

/**
 * Pure rules for the Run view and its doors, split from the components so
 * they test under the node-only vitest setup.
 */

/** What another view hands the Run view: a prefill to show in the goal box. */
export interface RunIntent {
  prefill: RunPrefill;
  /** Distinguishes two asks for the same prefill, like every App.tsx intent. */
  at: number;
}

/** The Run rail entry and every door exist only while Run is turned on. */
export function runVisible(runEnabled: boolean | undefined): boolean {
  return runEnabled === true;
}

/** Which door a session of this source may offer. Only Copilot CLI sessions can be continued in the app. */
export function sessionDoor(source: string, runEnabled: boolean | undefined): RunDoor | undefined {
  return runVisible(runEnabled) && source === 'copilot-cli' ? 'continue-session' : undefined;
}

export type RunGate = 'notice' | 'problem' | 'ready';

/** What the view shows first: the notice until acknowledged, then any setup problem. */
export function runGate(availability: RunAvailability | undefined): RunGate | undefined {
  if (availability === undefined) {
    return undefined;
  }
  if (!availability.acknowledged) {
    return 'notice';
  }
  return availability.problem !== undefined || !availability.cliFound || availability.signedIn === false
    ? 'problem'
    : 'ready';
}

/** One sentence on what is wrong and how to fix it. */
export function availabilityProblem(availability: RunAvailability): string | undefined {
  if (availability.problem !== undefined) {
    return availability.problem;
  }
  if (!availability.cliFound) {
    return 'GitHub Copilot CLI was not found. Install it, or set its path under Settings > AI.';
  }
  if (availability.signedIn === false) {
    return 'GitHub Copilot CLI is not signed in. Run "copilot" in a terminal once and sign in, then come back.';
  }
  return undefined;
}

/** Start is possible once there is a goal, a repository, and nothing blocking. */
export function canStart(goal: string, repository: string, busy: boolean): boolean {
  return !busy && goal.trim().length > 0 && repository.length > 0;
}

/** Sessions for the list: running ones first, then most recent activity. */
export function sortRunSessions(sessions: readonly RunSessionInfo[]): RunSessionInfo[] {
  const rank = (s: RunSessionInfo): number => (s.status === 'stopped' || s.status === 'error' ? 1 : 0);
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.lastActivityMs - a.lastActivityMs);
}

/** The reminder under Start; fixed wording, shown on every start. */
export const RUN_START_REMINDER = 'Sends to GitHub through your Copilot login. Every action asks first.';
export const RUN_START_REMINDER_ALLOW_ALL =
  'Sends to GitHub through your Copilot login. Allow all is on: the agent will act without asking.';

/** The reminder for the permission mode the session is about to start in. */
export function startReminder(mode: RunPermissionMode): string {
  return mode === 'allow-all' ? RUN_START_REMINDER_ALLOW_ALL : RUN_START_REMINDER;
}
