import { LIVE_STATUS_ORDER, PENDING_TOOL_HINT_MS } from '@agent-observability/core/src/live/liveStatus';
import type { LiveSessionRow, LiveStatus, RetroVerdict } from '../../../../shared/rpc';

/**
 * Presentation rules for the Workspace view, split from the components so they
 * test under the node-only vitest setup like `views/overview/insights.ts`.
 */

export function statusLabel(status: LiveStatus): string {
  switch (status) {
    case 'waiting':
      return 'Waiting for you';
    case 'working':
      return 'Working';
    case 'idle':
      return 'Idle';
    case 'finished':
      return 'Finished';
  }
}

/** One line on what the status was derived from, for the card's tooltip. */
export function statusHint(row: LiveSessionRow): string {
  switch (row.lastEvent) {
    case 'tool-pending':
      return row.pendingTools.length === 1
        ? `A ${row.pendingTools[0]} call has not returned yet`
        : `${row.pendingTools.length} tool calls have not returned yet`;
    case 'assistant-text':
      return 'The agent answered and is waiting for your next prompt';
    case 'turn-ended':
      return 'The turn ended';
    case 'user-prompt':
      return 'Your prompt was sent and the agent is thinking';
    case 'tool-result':
      return 'A tool returned and the agent is continuing';
    case 'interruption':
      return 'You interrupted the agent';
    case 'unknown':
      return 'Derived from the time of the last write';
  }
}

/** Waiting first, then working, idle, finished; most recent activity first within a status. */
export function sortLiveRows(rows: readonly LiveSessionRow[]): LiveSessionRow[] {
  return [...rows].sort((a, b) => {
    const order = LIVE_STATUS_ORDER.indexOf(a.status) - LIVE_STATUS_ORDER.indexOf(b.status);
    return order !== 0 ? order : b.lastActivityMs - a.lastActivityMs;
  });
}

/**
 * A tool call pending for a long time may be a permission prompt the agent is
 * waiting on — the transcript cannot tell the two apart, so this is a hint,
 * never a status.
 */
export function pendingHint(row: LiveSessionRow, nowMs: number): string | undefined {
  if (row.lastEvent !== 'tool-pending' || row.status !== 'working') {
    return undefined;
  }
  const age = nowMs - row.lastActivityMs;
  if (age < PENDING_TOOL_HINT_MS) {
    return undefined;
  }
  const minutes = Math.max(1, Math.floor(age / 60_000));
  const tool = row.pendingTools.length === 1 ? `${row.pendingTools[0]} call` : 'tool call';
  return `${tool} pending for ${minutes} min — may be waiting for your approval`;
}

/** Counts per status, for the board header: `2 working · 1 waiting for you`. */
export function liveSummary(rows: readonly LiveSessionRow[]): string {
  const counts = new Map<LiveStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const parts = LIVE_STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map(
    (s) => `${counts.get(s)} ${statusLabel(s).toLowerCase()}`,
  );
  return parts.length === 0 ? 'Nothing running' : parts.join(' · ');
}

/** `+3`, `-2` or `no change`; formatted by hand so every machine prints the same. */
export function trend(current: number, previous: number): { delta: number; label: string } {
  const delta = current - previous;
  if (delta === 0) {
    return { delta, label: 'no change' };
  }
  return { delta, label: delta > 0 ? `+${delta}` : `-${Math.abs(delta)}` };
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'memory':
      return 'Memory';
    case 'rule':
      return 'Rule';
    case 'instruction':
      return 'Instruction';
    case 'skill':
      return 'Skill';
    case 'agent':
      return 'Agent';
    case 'prompt':
      return 'Prompt';
    default:
      return kind;
  }
}

export function agentLabel(agent: string): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code';
    case 'copilot':
      return 'Copilot';
    case 'shared':
      return 'Both';
    default:
      return agent;
  }
}

export const VERDICT_ORDER: readonly (RetroVerdict | 'unjudged')[] = [
  'smooth',
  'bumpy',
  'struggled',
  'abandoned',
  'unjudged',
];

/** Each verdict's share of the total, in display order; zero-count verdicts included. */
export function verdictShare(
  verdicts: Record<RetroVerdict | 'unjudged', number>,
): { key: RetroVerdict | 'unjudged'; value: number; pct: number }[] {
  const total = VERDICT_ORDER.reduce((sum, key) => sum + verdicts[key], 0);
  return VERDICT_ORDER.map((key) => ({
    key,
    value: verdicts[key],
    pct: total === 0 ? 0 : Math.round((verdicts[key] / total) * 100),
  }));
}
