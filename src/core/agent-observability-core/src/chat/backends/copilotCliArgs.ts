/**
 * Pure helpers for driving GitHub's standalone `copilot` CLI (npm
 * `@github/copilot`) in non-interactive prompt mode. Kept free of
 * `child_process`/`fs` imports so argv construction, candidate resolution, and
 * env sanitization are unit-testable headless; `copilotCliBackend.ts` owns the
 * spawn and the payload temp file.
 *
 * Everything here was PROBED against CLI v1.0.82 (2026-08-31), not read from
 * docs:
 * - `-p <text>` runs one prompt and exits; the prompt is argv-only — the CLI
 *   reads nothing from stdin in prompt mode, and `--attachment` rejects
 *   markdown ("must be an image or native document"). Large prompts therefore
 *   travel as a payload FILE the model reads with its `view` tool (see
 *   {@link buildCopilotPayloadArgs}); that tool name is the CLI's own.
 * - `--available-tools=` (empty) yields a tool-less run with no permission
 *   prompts and no `--allow-all-tools` required.
 * - `--output-format json --stream on` emits one JSON object per line;
 *   `assistant.message_delta` carries `data.deltaContent`, `assistant.message`
 *   the full `data.content`, and a terminal `result` line carries `exitCode`.
 * - The GitHub MCP server is a built-in that connects even with no tools
 *   available — `--disable-builtin-mcps` keeps helper runs from touching it.
 * - `--no-remote` / `--no-remote-export` keep the session off GitHub web and
 *   mobile; `--no-custom-instructions` keeps AGENTS.md files out of the
 *   prompt (the backend also spawns in the home directory).
 * - The CLI persists its sessions under `~/.copilot` with no opt-out flag;
 *   nothing in this product ingests that store today, but if a Copilot CLI
 *   session source is ever added, helper runs must be excluded from it.
 */

/** Model used when the setting is blank — the CLI picks one itself. */
export const DEFAULT_COPILOT_CLI_MODEL = 'auto';

/**
 * Curated choices; any other configured string passes through as a custom id.
 * Deliberately short — the CLI's model roster moves faster than releases here.
 */
export const COPILOT_CLI_MODEL_CHOICES: readonly { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto (Copilot picks)' },
];

/**
 * Above this serialized-prompt length the prompt travels as a payload file on
 * every platform: Windows caps the whole command line at ~32,767 chars, and one
 * behavior everywhere beats a per-platform fork nobody tests both sides of.
 */
export const COPILOT_ARGV_PROMPT_LIMIT = 24_000;

/** Flags every helper invocation carries, whatever the transport. */
function baseArgs(model: string): string[] {
  return [
    '--output-format', 'json',
    '--stream', 'on',
    '--model', model,
    '--no-color',
    '--log-level', 'none',
    '--no-auto-update',
    '--no-custom-instructions',
    '--no-remote',
    '--no-remote-export',
    '--no-ask-user',
    '--disable-builtin-mcps',
  ];
}

/** Argv for a prompt small enough to ride the command line: a tool-less run. */
export function buildCopilotArgs(model: string, prompt: string): string[] {
  return ['-p', prompt, ...baseArgs(model), '--available-tools='];
}

/**
 * The pointer prompt for payload-file transport. The payload file holds the
 * real serialized prompt verbatim; this only tells the model where it is.
 */
export function copilotPayloadPointer(payloadPath: string): string {
  return (
    `Read the file at ${payloadPath} with your view tool and treat its entire ` +
    'contents as your instructions and input. Do not mention the file or the tool in your answer.'
  );
}

/**
 * Argv for the payload-file transport: the model gets exactly one tool (`view`)
 * over exactly one directory, which contains only the payload file the backend
 * just wrote. `--allow-tool view` pre-approves it so the non-interactive run
 * cannot stall on a permission prompt.
 */
export function buildCopilotPayloadArgs(model: string, payloadPath: string, payloadDir: string): string[] {
  return [
    '-p', copilotPayloadPointer(payloadPath),
    ...baseArgs(model),
    '--add-dir', payloadDir,
    '--available-tools=view',
    '--allow-tool', 'view',
  ];
}

/**
 * Executable candidates in spawn order — same rationale as the Claude variant:
 * `shell: false` does not resolve npm's Windows `copilot.cmd` shim, so retry
 * with the suffix. Paths already carrying an extension are used as-is.
 */
export function copilotCommandCandidates(cliPath: string, platform: NodeJS.Platform): string[] {
  const trimmed = cliPath.trim();
  const base = trimmed.length > 0 ? trimmed : 'copilot';
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
 * Copy of the environment without the CLI's permission-widening variables:
 * an ambient `COPILOT_ALLOW_ALL=1` in the user's shell must not silently grant
 * a helper run every tool the argv just disabled.
 */
export function sanitizeCopilotEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy.COPILOT_ALLOW_ALL;
  delete copy.COPILOT_ASSISTED_APPROVAL;
  return copy;
}
