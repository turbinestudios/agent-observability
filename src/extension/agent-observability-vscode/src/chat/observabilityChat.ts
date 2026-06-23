import * as vscode from 'vscode';
import { Commands } from '../commands';
import { TelemetryService } from '../telemetry/telemetryService';
import { planChatResponse } from './chatResponsePlan';

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
  telemetry: TelemetryService,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    return;
  }

  const handler: vscode.ChatRequestHandler = (request, _ctx, stream, _token) => {
    const query = request.prompt.trim();
    // @obs is an explicit, on-demand action: re-snapshot so sessions the user
    // just worked in are visible (and titles for new sessions are picked up).
    telemetry.refresh();
    // Fetch all sessions so the query path can filter across everything; the
    // plan picks the most recent titled ones and caps the button count.
    const result = telemetry.listSessions(undefined);

    const plan = planChatResponse(result, query);
    stream.markdown(plan.markdown);
    for (const button of plan.buttons) {
      stream.button({
        command: Commands.openSession,
        arguments: [button.sessionId],
        title: button.title,
      });
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity-bar.svg');
  context.subscriptions.push(participant);
}
