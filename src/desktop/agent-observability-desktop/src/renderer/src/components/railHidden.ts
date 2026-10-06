import type { ViewId } from './ActivityRail';

/**
 * The rail entries of features that are turned off in Settings. Run is on by
 * default and Team off, so a new install shows Run but not Team.
 */
export function hiddenRailEntries(on: { run: boolean; team: boolean }): ViewId[] {
  const hidden: ViewId[] = [];
  if (!on.run) {
    hidden.push('run');
  }
  if (!on.team) {
    hidden.push('team');
  }
  return hidden;
}
