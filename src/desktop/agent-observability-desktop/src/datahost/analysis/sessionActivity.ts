import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { SessionDetail } from '@agent-observability/core/src/telemetry/models';
import { emptyActivity, type SessionActivity } from '@agent-observability/core/src/analysis/sessionActivity';

/**
 * The single place the datahost asks for a session's activity (commands run,
 * files edited), the sibling of `./sessionRetrospective.ts`.
 *
 * A source that implements `getSessionActivity` (Claude Code) returns the full
 * picture from the transcript it already has cached. Any other source gets a
 * DEGRADED activity built from the detail's timeline: sub-agent calls by name
 * and whether the session ended on failed tools, with no commands and no
 * files, marked `complete: false` so the review packet and the hand-off brief
 * say what they could not see instead of implying nothing happened.
 *
 * `ActivityCommand.text` and edit paths are raw content. Nothing here persists
 * or logs them; callers quote only through `core/text/redact.ts`.
 */
export function activityFor(
  source: SessionDataSource,
  sessionId: string,
  detail: SessionDetail,
): SessionActivity {
  try {
    const viaSource = source.getSessionActivity?.(sessionId, detail);
    if (viaSource !== undefined && viaSource.ok) {
      return viaSource.value;
    }
  } catch {
    // Fall through to the degraded shape: a packet without file detail is
    // still worth having.
  }
  return degradedActivity(detail);
}

export function degradedActivity(detail: SessionDetail): SessionActivity {
  const activity = emptyActivity(false);
  const agents = new Map<string, number>();
  let trailingFailed = 0;
  for (const turn of detail.turns) {
    for (const event of turn.events) {
      if (event.operation === 'invoke_agent') {
        const name = event.toolName ?? 'agent';
        agents.set(name, (agents.get(name) ?? 0) + 1);
      }
      if (event.operation === 'execute_tool') {
        trailingFailed = event.success ? 0 : trailingFailed + 1;
      }
    }
  }
  activity.subAgents = [...agents.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  activity.trailingFailedTools = trailingFailed;
  activity.endedOnFailedTool = trailingFailed > 0;
  return activity;
}
