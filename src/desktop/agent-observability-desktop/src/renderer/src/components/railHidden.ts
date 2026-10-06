import type { ViewId } from './ActivityRail';

/**
 * The rail entries of features that are turned off in Settings. Run and Team
 * are both off by default, so a new install shows neither.
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
