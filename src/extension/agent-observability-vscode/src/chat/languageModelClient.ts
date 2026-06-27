import * as vscode from 'vscode';
import { AssembledMessage } from './conversation';

/**
 * Thin wrapper over the VS Code Language Model API, backed by the user's own
 * GitHub Copilot license.
 *
 * Deliberately minimal: model selection + a streaming send loop. All testable
 * logic (error mapping, prompt assembly, context selection) lives in pure seams
 * (`lmErrors.ts`, `conversation.ts`, `tasks/*`), so this module is exercised
 * manually in the Extension Host rather than by vitest (which has no `vscode`).
 */

/** Select the user's first available Copilot chat model, or `undefined` if none. */
export async function selectCopilotModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (typeof vscode.lm?.selectChatModels !== 'function') {
    return undefined;
  }
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
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
