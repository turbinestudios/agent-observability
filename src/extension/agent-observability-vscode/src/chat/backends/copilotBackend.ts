import type * as vscode from 'vscode';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { describeLmError, noModelsError, FriendlyError } from '@agent-observability/core/src/chat/lmErrors';
import { listCopilotModels, selectCopilotModel, streamRequest } from '../languageModelClient';
import { BackendAvailability, ChatBackend, ChatRequest, ModelChoice } from '@agent-observability/core/src/chat/backends/chatBackend';

/**
 * The GitHub Copilot backend: the AI Helper's original inference path, wrapped
 * behind the {@link ChatBackend} contract. Uses the VS Code Language Model API
 * (`vscode.lm`) under the user's own Copilot license; the configured model id
 * (or family) narrows the selection, blank means "first available".
 */
export class CopilotBackend implements ChatBackend {
  readonly id = 'copilot' as const;
  readonly label = 'GitHub Copilot';

  constructor(private readonly config: Pick<Configuration, 'getAiHelperCopilotModel'>) {}

  async isAvailable(): Promise<BackendAvailability> {
    const models = await listCopilotModels();
    if (models.length === 0) {
      return { available: false, reason: noModelsError().message };
    }
    return { available: true };
  }

  async listModels(): Promise<ModelChoice[]> {
    const models = await listCopilotModels();
    return models.map((m) => ({ id: m.id, label: m.name }));
  }

  async streamChat(
    request: ChatRequest,
    onDelta: (text: string) => void,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const model = await selectCopilotModel(this.config.getAiHelperCopilotModel());
    if (!model) {
      throw Object.assign(new Error(noModelsError().message), { name: 'NoModels' });
    }
    await streamRequest(model, request.messages, onDelta, token);
  }

  describeError(err: unknown): FriendlyError {
    return describeLmError(err);
  }
}
