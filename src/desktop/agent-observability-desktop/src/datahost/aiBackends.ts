import type { Configuration } from '@agent-observability/core/src/config/configuration';
import { ChatBackendRegistry, type ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import { ClaudeCodeBackend } from '@agent-observability/core/src/chat/backends/claudeCodeBackend';
import type { ClaudeCliHints } from '@agent-observability/core/src/chat/backends/claudeErrors';
import { CopilotCliBackend } from '@agent-observability/core/src/chat/backends/copilotCliBackend';
import type { CopilotCliHints } from '@agent-observability/core/src/chat/backends/copilotCliErrors';

/**
 * The desktop's AI backend wiring — the one place chat backends are
 * constructed, shared by the deep retrospective, the AI Helper, and the
 * improvement-plan runner so they all share the CLI probe caches.
 */

/** Desktop phrasing: the CLI path is edited in the Settings view, not a VS Code setting id. */
export const DESKTOP_CLI_HINTS: ClaudeCliHints = {
  cliPathHint: 'set the Claude CLI path in Settings',
};

/** The same, for the Copilot CLI's path field. */
export const DESKTOP_COPILOT_CLI_HINTS: CopilotCliHints = {
  cliPathHint: 'set the Copilot CLI path in Settings',
};

/**
 * The vendor a backend's sends go to — consent dialogs name the company, not
 * the product, because that is the fact the privacy invariant turns on.
 */
export function backendVendor(id: string): string {
  return id === 'claude-code' ? 'Anthropic' : 'GitHub';
}

/**
 * Holds the registry behind an accessor so a settings change can rebuild it:
 * both backends cache a successful `--version` probe for their lifetime, so a
 * changed CLI path would otherwise be ignored until app restart.
 */
export class AiBackendHolder {
  private registry: ChatBackendRegistry;

  constructor(private readonly config: Configuration) {
    this.registry = this.build();
  }

  /**
   * The backend the config selects, falling back to the first registered one:
   * core's default `aiHelper.backend` is `copilot` — the VS Code `vscode.lm`
   * backend, which the desktop does not carry — and the helper must not be
   * dead on a default config. Claude Code stays first, so that default keeps
   * resolving exactly as it always has; the Copilot CLI answers only when the
   * user selects it in Settings.
   */
  active(): ChatBackend {
    return this.registry.get(this.config.getAiHelperBackend()) ?? this.registry.all()[0];
  }

  /** Every registered backend, in display order — for the Settings picker. */
  all(): readonly ChatBackend[] {
    return this.registry.all();
  }

  /** Drop every backend (and its probe caches) after an AI settings change. */
  reload(): void {
    this.registry = this.build();
  }

  private build(): ChatBackendRegistry {
    return new ChatBackendRegistry([
      new ClaudeCodeBackend(this.config, { hints: DESKTOP_CLI_HINTS }),
      new CopilotCliBackend(this.config, { hints: DESKTOP_COPILOT_CLI_HINTS }),
    ]);
  }
}
