import type {
  TeamCostMode,
  TeamMemberInfo,
  TeamStatus,
  TeamViewData,
  TeamWindow,
} from '../../../../shared/rpc';
import { DEFAULT_TEAM_WINDOW, toTeamWindow } from '../../../../shared/rpc';
import { formatRelative } from '../sessions/format';

/**
 * Presentation rules for the Team view, split from the components so they test
 * under the node-only vitest setup like `views/workspace/workspace.ts`.
 * Every figure here is formatted by hand: the view must read the same on every
 * machine locale.
 */

const STORAGE_KEY = 'agent-observability.teamWindow';

export function readStoredTeamWindow(): TeamWindow {
  try {
    return toTeamWindow(Number(window.localStorage.getItem(STORAGE_KEY)));
  } catch {
    return DEFAULT_TEAM_WINDOW;
  }
}

export function persistTeamWindow(value: TeamWindow): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage unavailable; the choice still applies for this run.
  }
}

export function teamWindowLabel(value: TeamWindow): string {
  return `${value}d`;
}

/** `dev_` plus the first eight hex characters: enough to tell members apart. */
export function shortDeveloperId(id: string): string {
  const hex = id.startsWith('dev_') ? id.slice(4) : id;
  return `dev_${hex.slice(0, 8)}…`;
}

/** The members list's freshness note. */
export function staleLabel(member: Pick<TeamMemberInfo, 'generatedAtMs' | 'stale'>, nowMs: number): string {
  const when = formatRelative(member.generatedAtMs, nowMs);
  const shared = when === '' ? 'shared' : when === 'now' ? 'shared just now' : `shared ${when}`;
  return member.stale ? `${shared} · stale` : shared;
}

export function folderStateLabel(status: Pick<TeamStatus, 'folderState' | 'watchMode'>): string {
  switch (status.folderState) {
    case 'unset':
      return 'No team folder chosen';
    case 'missing':
      return 'Team folder not found right now';
    case 'unreadable':
      return 'Team folder could not be read';
    case 'ok':
      return status.watchMode === 'events+poll' ? 'Watching the team folder' : 'Checking the team folder every minute';
  }
}

export type TeamEmptyState = 'no-folder' | 'no-shards' | 'only-me';

/** Which empty state the view shows, or `undefined` when there is a team to draw. */
export function emptyState(
  status: Pick<TeamStatus, 'folderState' | 'memberCount'>,
  data: Pick<TeamViewData, 'members'> | undefined,
): TeamEmptyState | undefined {
  if (status.folderState === 'unset') {
    return 'no-folder';
  }
  if (status.memberCount === 0) {
    return 'no-shards';
  }
  const members = data?.members ?? [];
  if (members.length > 0 && members.every((m) => m.isMe)) {
    return 'only-me';
  }
  return undefined;
}

export function problemLabel(problem: TeamStatus['problems'][number]): string {
  switch (problem.reason) {
    case 'unknown-schema-version':
      return 'Skipped: written by a newer version of the app — update to see this member';
    case 'invalid':
      return 'Skipped: not a valid team file';
    case 'id-mismatch':
      return 'Skipped: file name does not match its id';
    case 'too-large':
      return 'Skipped: file is too large';
    case 'unreadable':
      return 'Could not be read yet';
  }
}

/** `+12%`, `-5%` or `same`, mine against the team's figure. */
export function deltaLabel(mine: number, team: number): string {
  if (team === 0) {
    return mine === 0 ? 'same' : 'n/a';
  }
  const pct = Math.round(((mine - team) / team) * 100);
  if (pct === 0) {
    return 'same';
  }
  return pct > 0 ? `+${pct}%` : `-${Math.abs(pct)}%`;
}

const COST_MODE_NAMES: Record<TeamCostMode, string> = { usd: 'USD', aiu: 'AIU', credits: 'credits' };

/** Says when the cost tiles sum sessions priced on different bases. */
export function costBasisNote(costModes: Record<TeamCostMode, number>): string {
  const used = (Object.keys(costModes) as TeamCostMode[]).filter((mode) => costModes[mode] > 0);
  if (used.length === 0) {
    return 'No priced sessions yet';
  }
  if (used.length === 1) {
    return `All members price in ${COST_MODE_NAMES[used[0]]}`;
  }
  const parts = used.map((mode) => `${costModes[mode]} in ${COST_MODE_NAMES[mode]}`);
  return `Mixed billing bases: ${parts.join(', ')} — totals are summed as US dollars`;
}

/** `MM-DD` from a `YYYY-MM-DD` day, by slicing: no Intl, so every machine agrees. */
export function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5, 10) : day;
}

/** Hand-grouped integer, same on every locale. */
export function groupThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
