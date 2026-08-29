import type { CopilotSetupStatus, CopilotSetupTarget } from '../../../shared/rpc';

/**
 * The pure half of the Copilot setup offer, in its own module so the node-only
 * tests can import it without dragging in the data-host client (whose module
 * scope needs `window`).
 */

/**
 * Whether the setup dialog belongs on screen. Pure, and answered for the
 * shell, because only the shell knows the whole overlay picture: the startup
 * overlay must have lifted and the update dialog must not be up. The
 * datahost's `shouldPrompt` verdict carries everything else (fixable targets,
 * persisted dismissal, the app-level Copilot toggle).
 */
export function copilotSetupDialogState(
  status: CopilotSetupStatus | undefined,
  startupDone: boolean,
  otherOverlayUp: boolean,
  dismissedThisRun: boolean,
): { status: CopilotSetupStatus } | undefined {
  if (!startupDone || otherOverlayUp || dismissedThisRun) {
    return undefined;
  }
  if (status === undefined || !status.shouldPrompt) {
    return undefined;
  }
  return { status };
}

/** The fixable subset — what the Enable button will actually write to. */
export function fixableTargets(status: CopilotSetupStatus): CopilotSetupTarget[] {
  return status.targets.filter(
    (t) => t.state === 'unset' || t.state === 'disabled' || t.state === 'no-settings-file',
  );
}
