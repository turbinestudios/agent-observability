import * as vscode from 'vscode';
import { AssembledMessage } from '@agent-observability/core/src/chat/conversation';

/**
 * Thin wrapper over the VS Code Language Model API, backed by the user's own
 * GitHub Copilot license.
 *
 * Deliberately minimal: model selection + a streaming send loop. All testable
 * logic (error mapping, prompt assembly, context selection) lives in pure seams
 * (`lmErrors.ts`, `conversation.ts`, `tasks/*`), so this module is exercised
 * manually in the Extension Host rather than by vitest (which has no `vscode`).
 */

/** All Copilot chat models currently available to this user (may be empty). */
export async function listCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  if (typeof vscode.lm?.selectChatModels !== 'function') {
    return [];
  }
  return [...(await vscode.lm.selectChatModels({ vendor: 'copilot' }))];
}

/**
 * Select the user's Copilot chat model: the one matching `preferredId` (by id,
 * then family) when set, else the first available, else `undefined`.
 */
export async function selectCopilotModel(preferredId?: string): Promise<vscode.LanguageModelChat | undefined> {
  const models = await listCopilotModels();
  if (preferredId !== undefined && preferredId.length > 0) {
    const preferred = models.find((m) => m.id === preferredId || m.family === preferredId);
    if (preferred) {
      return preferred;
    }
  }
  return models[0];
}

/**
 * Send an assembled request and stream the response text to `onDelta`.
 *
 * Maps each {@link AssembledMessage} to a `User`/`Assistant`
 * {@link vscode.LanguageModelChatMessage}. Throws on failure (including
 * cancellation) — the caller classifies via `lmErrors.ts`. The first call may
 * trigger VS Code's built-in per-extension Copilot consent prompt.
 */
export async function streamRequest(
  model: vscode.LanguageModelChat,
  messages: readonly AssembledMessage[],
  onDelta: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<void> {
  const lmMessages = messages.map((m) =>
    m.role === 'assistant'
      ? vscode.LanguageModelChatMessage.Assistant(m.text)
      : vscode.LanguageModelChatMessage.User(m.text),
  );
  const response = await model.sendRequest(lmMessages, {}, token);
  for await (const chunk of response.text) {
    onDelta(chunk);
  }
}
