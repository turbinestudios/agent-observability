/**
 * Quick-command definitions for the AI Helper webview.
 *
 * Pure (no `vscode` import) so the command catalog and per-command context-file
 * selection are unit-testable headless. The webview renders {@link QUICK_COMMANDS}
 * as buttons in the empty state; the provider dispatches on {@link QuickCommandId}.
 *
 * Context selection is deliberately minimal per command — we never load every
 * context file every turn (token budget). The file names map to `context/*.md`
 * assets bundled with the extension and read by the context loader.
 */

/** The baked-in context files, by base name (under the extension's `context/` dir). */
export const ContextFiles = {
  overview: 'extension-overview.md',
  settingsReference: 'settings-reference.md',
  minimalConfig: 'minimal-config.md',
  workflowDsl: 'workflow-dsl.md',
  telemetryGlossary: 'telemetry-glossary.md',
} as const;

/** Stable ids for the three shipped quick commands. */
export type QuickCommandId = 'generate-workflows' | 'minimal-config' | 'summarize-logs';

/** One quick-command button + its prompt and context selection. */
export interface QuickCommand {
  id: QuickCommandId;
  /** Button title in the empty state. */
  label: string;
  /** One-line description under the title. */
  description: string;
  /** Prompt echoed into the transcript and sent as the user turn. */
  prompt: string;
  /** `context/*.md` files to ground this command (order preserved). */
  contextFiles: string[];
}

/** The shipped quick commands, in display order. */
export const QUICK_COMMANDS: readonly QuickCommand[] = [
  {
    id: 'generate-workflows',
    label: 'Generate workflows',
    description: 'Draft agentObservability.workflows from this project’s telemetry',
    prompt:
      'Generate expected workflow definitions for agentObservability.workflows based on my collected telemetry.',
    contextFiles: [ContextFiles.overview, ContextFiles.workflowDsl],
  },
  {
    id: 'minimal-config',
    label: 'Set up new project',
    description: 'Bare-minimum .vscode/settings.json to get the extension working',
    prompt:
      'Give me the bare-minimum .vscode/settings.json configuration to get this extension working in a new project.',
    contextFiles: [ContextFiles.overview, ContextFiles.minimalConfig, ContextFiles.settingsReference],
  },
  {
    id: 'summarize-logs',
    label: 'Summarize my logs',
    description: 'A detailed summary of the collected telemetry',
    prompt: 'Give me a detailed summary of my collected agent logs and telemetry.',
    contextFiles: [ContextFiles.overview, ContextFiles.telemetryGlossary],
  },
];

/** Look up a quick command by id, or `undefined` for an unknown id. */
export function getQuickCommand(id: string): QuickCommand | undefined {
  return QUICK_COMMANDS.find((c) => c.id === id);
}

/**
 * Context files for a free-text question. Always includes the overview and the
 * settings reference; adds the workflow or telemetry references when the question
 * mentions those topics, so a free-text ask still gets the relevant grounding
 * without loading everything.
 */
export function selectContextForFreeText(text: string): string[] {
  const q = text.toLowerCase();
  const files: string[] = [ContextFiles.overview, ContextFiles.settingsReference];
  if (/workflow|deviation|sequence|predicate/.test(q)) {
    files.push(ContextFiles.workflowDsl);
  }
  if (/log|telemetr|token|aiu|session|summar|cost|model/.test(q)) {
    files.push(ContextFiles.telemetryGlossary);
  }
  return [...new Set(files)];
}
