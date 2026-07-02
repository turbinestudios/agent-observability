import { CLAUDE_EFFORT_LEVELS } from './claudeCliArgs';
import type { ModelChoice } from './chatBackend';

/**
 * Pure assembly of the AI Helper's selector-row state (backend / model / effort
 * dropdowns). The provider gathers the async inputs (availability, model lists,
 * settings) and this module folds them into the one object the webview renders,
 * so the display rules stay unit-testable.
 */

/** One backend entry for the backend dropdown. */
export interface BackendOption {
  id: string;
  label: string;
  available: boolean;
  /** Why the backend is unavailable (shown against the disabled option). */
  hint?: string;
}

/** Everything the webview needs to render the selector row. */
export interface AiHelperUiState {
  backends: BackendOption[];
  activeBackend: string;
  /** Models for the ACTIVE backend only. */
  models: ModelChoice[];
  /** Selected model id; '' = auto (Copilot's first available). */
  activeModel: string;
  /** Effort choices, or `undefined` to hide the effort dropdown (Copilot). */
  efforts?: readonly string[];
  activeEffort?: string;
}

/** Inputs gathered by the provider for one `uiState` post. */
export interface UiStateInputs {
  backends: BackendOption[];
  activeBackend: string;
  models: ModelChoice[];
  activeModel: string;
  activeEffort: string;
}

/** Fold the gathered inputs into the webview's selector state. */
export function buildUiState(inputs: UiStateInputs): AiHelperUiState {
  const claudeActive = inputs.activeBackend === 'claude-code';
  return {
    backends: inputs.backends,
    activeBackend: inputs.activeBackend,
    models: withConfiguredModel(inputs.models, inputs.activeModel, claudeActive),
    activeModel: inputs.activeModel,
    efforts: claudeActive ? CLAUDE_EFFORT_LEVELS : undefined,
    activeEffort: claudeActive ? inputs.activeEffort : undefined,
  };
}

/**
 * Ensure the configured model is always present in the dropdown. A hand-edited
 * full model id (e.g. `claude-sonnet-5`) is appended as a "(custom)" entry
 * rather than silently rendering an empty selection.
 */
function withConfiguredModel(models: ModelChoice[], activeModel: string, claudeActive: boolean): ModelChoice[] {
  if (activeModel.length === 0 || models.some((m) => m.id === activeModel)) {
    return models;
  }
  if (!claudeActive) {
    // Copilot: an unknown configured id falls back to auto at request time.
    return models;
  }
  return [...models, { id: activeModel, label: `${activeModel} (custom)` }];
}
