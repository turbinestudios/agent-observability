import { AssembledMessage } from '../conversation';

/**
 * Pure helpers for driving the Claude Code CLI in non-interactive print mode.
 *
 * Kept free of `vscode` and `child_process` imports so argv construction, prompt
 * serialization, executable resolution, and env sanitization are unit-testable
 * headless; `claudeCodeBackend.ts` owns the actual spawn.
 */

/** Effort levels accepted by the CLI's `--effort` flag (not every model supports all). */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One reasoning-effort level for the Claude Code CLI. */
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** Model used when the setting is blank. */
export const DEFAULT_CLAUDE_MODEL = 'sonnet';

/** Effort used when the setting is blank or invalid. */
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';

/** Curated model choices; any other configured string passes through as a custom id. */
export const CLAUDE_MODEL_CHOICES: readonly { id: string; label: string }[] = [
  { id: 'sonnet', label: 'Sonnet (default)' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
];

/** Parse a raw setting value into a valid effort, falling back to the default. */
export function parseClaudeEffort(raw: unknown): ClaudeEffort {
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value)) {
      return value as ClaudeEffort;
    }
  }
  return DEFAULT_CLAUDE_EFFORT;
}

/**
 * The exact argv for one chat turn. The prompt goes to stdin — never argv —
 * because assembled preambles can exceed Windows command-line limits. Tools are
 * disabled (pure Q&A), and `--no-session-persistence` keeps AI Helper runs out
 * of `~/.claude/projects`, which this extension itself ingests as telemetry.
 */
export function buildClaudeArgs(model: string, effort: ClaudeEffort): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', effort,
    '--tools', '',
    '--max-turns', '1',
    '--no-session-persistence',
  ];
}

/**
 * Serialize the assembled transcript (preamble-first, per `assembleMessages`)
 * into a single prompt. Multi-turn state is carried by re-sending the whole
 * conversation each turn — stateless by design, since `--resume` is incompatible
 * with `--no-session-persistence`.
 */
export function serializeMessagesForCli(messages: readonly AssembledMessage[]): string {
  if (messages.length === 0) {
    return '';
  }
  const [preamble, ...turns] = messages;
  let out = preamble.text;
  if (turns.length > 0) {
    out += '\n\n# Conversation';
    for (const turn of turns) {
      out += turn.role === 'assistant' ? '\n\n## Assistant\n' : '\n\n## User\n';
      out += turn.text;
    }
  }
  return out;
}

/**
 * Executable candidates in spawn order. We spawn with `shell: false` (a shell
 * would mangle the empty `--tools ""` argument), so an npm-shim install on
 * Windows (`claude.cmd`) is not resolved automatically — retry with the `.cmd`
 * suffix after an ENOENT. Paths that already carry an extension are used as-is.
 */
export function claudeCommandCandidates(cliPath: string, platform: NodeJS.Platform): string[] {
  const trimmed = cliPath.trim();
  const base = trimmed.length > 0 ? trimmed : 'claude';
  if (platform !== 'win32') {
    return [base];
  }
  const lower = base.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.exe') || lower.endsWith('.bat')) {
    return [base];
  }
  return [base, `${base}.cmd`];
}

/**
 * Copy of the environment without `CLAUDECODE`, so a helper spawned from inside
 * a Claude Code-launched VS Code doesn't trip the CLI's nested-session detection.
 */
export function sanitizeClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy.CLAUDECODE;
  return copy;
}
