import * as vscode from 'vscode';
import { Commands } from '../commands';
import type { SessionSummary } from '@agent-observability/core/src/telemetry/models';
import type { Result } from '@agent-observability/core/src/telemetry/telemetryService';
import { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { planChatResponse } from '@agent-observability/core/src/chat/chatResponsePlan';

/**
 * `@obs` chat participant.
 *
 * VS Code does not let an extension inject UI into another extension's chat
 * (the GitHub Copilot chat panel is its own isolated webview). The supported
 * integration point is a chat *participant*: the user invokes `@obs` inside the
 * shared Chat view, and this handler's response renders real buttons via
 * {@link vscode.ChatResponseStream.button} for the most recently active sessions
 * (those with a known repository). Those buttons run the existing
 * `agentObservability.openSession` command, opening the LOCAL session-detail
 * webview.
 *
 * Privacy: the participant only reads local telemetry and renders locally —
 * nothing is uploaded. Session titles shown here are the same LOCAL-ONLY names
 * the Sessions tree already displays. All render decisions live in the pure
 * {@link ./chatResponsePlan} seam; this module only translates them to stream
 * calls.
 */

/** Participant id — MUST match the `chatParticipants` contribution in package.json. */
export const CHAT_PARTICIPANT_ID = 'agentObservability.chat';

/**
 * Register the `@obs` chat participant against the telemetry service.
 *
 * Guarded so hosts without the chat API (older VS Code, or a build with no chat
 * provider installed) skip registration instead of throwing during activation.
 */
export function registerObservabilityChatParticipant(
  context: vscode.ExtensionContext,
  sources: SourceRegistry,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    return;
  }

  const handler: vscode.ChatRequestHandler = (request, _ctx, stream, _token) => {
    const query = request.prompt.trim();
    // @obs is an explicit, on-demand action: re-snapshot so sessions the user
    // just worked in are visible (and titles for new sessions are picked up).
    sources.refresh();
    // Merge sessions across every enabled source (Copilot, Claude Code, Copilot
    // Cloud) so the query path can filter across everything; the plan picks the
    // most recent titled ones and caps the button count. Each summary carries its
    // `source`, so the button routes `openSession` to the right source.
    const result = mergeSessions(sources);

    const plan = planChatResponse(result, query);
    stream.markdown(plan.markdown);
    for (const button of plan.buttons) {
      stream.button({
        command: Commands.openSession,
        arguments: [button.sourceId, button.sessionId],
        title: button.title,
      });
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity-bar.svg');
  context.subscriptions.push(participant);
}

/**
 * Concatenate `listSessions()` across every enabled source into one result,
 * tagging each summary with its `source`. Fails only when EVERY enabled source
 * fails (mirroring the composite-aggregation semantics); an empty-but-ok source
 * never masks another's data.
 */
function mergeSessions(sources: SourceRegistry): Result<SessionSummary[]> {
  const merged: SessionSummary[] = [];
  let anyOk = false;
  let firstFailure: Result<SessionSummary[]> | undefined;
  for (const source of sources.enabled()) {
    const result = source.listSessions(undefined);
    if (result.ok) {
      anyOk = true;
      for (const summary of result.value) {
        merged.push(summary.source === undefined ? { ...summary, source: source.id } : summary);
      }
    } else if (firstFailure === undefined) {
      firstFailure = result;
    }
  }
  if (!anyOk && firstFailure !== undefined) {
    return firstFailure;
  }
  return { ok: true, value: merged };
}
