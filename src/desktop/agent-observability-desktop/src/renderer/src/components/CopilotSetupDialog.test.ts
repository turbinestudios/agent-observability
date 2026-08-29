import { describe, expect, it } from 'vitest';
import type { CopilotSetupStatus } from '../../../shared/rpc';
import { copilotSetupDialogState } from './copilotSetupState';

/**
 * The shell-level decider only: like the update dialog, the view renders
 * whatever the decider hands it, so the on/off logic is what needs pinning.
 */

function promptingStatus(shouldPrompt = true): CopilotSetupStatus {
  return {
    targets: [
      {
        variant: 'Code',
        variantLabel: 'VS Code',
        settingsFile: 'C:/u/Code/User/settings.json',
        state: 'unset',
        dbExists: false,
      },
    ],
    copilotSourceEnabled: true,
    promptDismissed: false,
    shouldPrompt,
  };
}

describe('copilotSetupDialogState', () => {
  it('shows the dialog when startup is done and the datahost says prompt', () => {
    const status = promptingStatus();
    expect(copilotSetupDialogState(status, true, false, false)).toEqual({ status });
  });

  it('stays hidden before the status has loaded', () => {
    expect(copilotSetupDialogState(undefined, true, false, false)).toBeUndefined();
  });

  it('stays hidden when the datahost says not to prompt', () => {
    expect(copilotSetupDialogState(promptingStatus(false), true, false, false)).toBeUndefined();
  });

  it('waits for the startup overlay to lift', () => {
    expect(copilotSetupDialogState(promptingStatus(), false, false, false)).toBeUndefined();
  });

  it('yields to another blocking overlay', () => {
    expect(copilotSetupDialogState(promptingStatus(), true, true, false)).toBeUndefined();
  });

  it('stays away once dismissed this run, whatever the status says', () => {
    expect(copilotSetupDialogState(promptingStatus(), true, false, true)).toBeUndefined();
  });
});
