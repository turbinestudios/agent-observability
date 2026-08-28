import type { Configuration } from '@agent-observability/core/src/config/configuration';
import { ChatBackendRegistry, type ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import { ClaudeCodeBackend } from '@agent-observability/core/src/chat/backends/claudeCodeBackend';
import type { ClaudeCliHints } from '@agent-observability/core/src/chat/backends/claudeErrors';

/**
 * The desktop's AI backend wiring — the one place a chat backend is
 * constructed, shared by the deep retrospective and the AI Helper so the two
 * share a single CLI probe cache.
 */

/** Desktop phrasing: the CLI path is edited in the Settings view, not a VS Code setting id. */
export const DESKTOP_CLI_HINTS: ClaudeCliHints = {
  cliPathHint: 'set the Claude CLI path in Settings',
};

/**
 * Holds the registry behind an accessor so a settings change can rebuild it:
 * `ClaudeCodeBackend` caches a successful `--version` probe for its lifetime,
 * so a changed `claudeCliPath` would otherwise be ignored until app restart.
 *
 * A future CopilotCliBackend (GitHub's standalone `copilot` CLI) is one more
 * entry in {@link build} plus its `BackendId` — nothing else changes.
 */
export class AiBackendHolder {
  private registry: ChatBackendRegistry;

  constructor(private readonly config: Configuration) {
    this.registry = this.build();
  }

  /**
   * The backend the config selects, falling back to the first registered one:
   * core's default `aiHelper.backend` is `copilot`, which the desktop does not
   * carry (it needs `vscode.lm`), and the helper must not be dead on a default
   * config.
   */
  active(): ChatBackend {
    return this.registry.get(this.config.getAiHelperBackend()) ?? this.registry.all()[0];
  }

  /** Drop every backend (and its probe cache) after an AI settings change. */
  reload(): void {
    this.registry = this.build();
  }

  private build(): ChatBackendRegistry {
    return new ChatBackendRegistry([new ClaudeCodeBackend(this.config, { hints: DESKTOP_CLI_HINTS })]);
  }
}
