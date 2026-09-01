import { exec, execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as os from 'node:os';
import { Configuration } from '../../config/configuration';
import { FriendlyError } from '../lmErrors';
import type { CancellationToken } from './cancellation';
import { BackendAvailability, ChatBackend, ChatRequest, ModelChoice } from './chatBackend';
import {
  buildClaudeArgs,
  claudeCommandCandidates,
  sanitizeClaudeEnv,
  serializeMessagesForCli,
  CLAUDE_MODEL_CHOICES,
} from './claudeCliArgs';
import { buildCmdShimLine, needsCmdShim } from './cliShim';
import { ClaudeStreamParser, ClaudeEvent } from './claudeStreamParser';
import {
  ClaudeCliError,
  ClaudeCliHints,
  VSCODE_CLI_HINTS,
  cliMissingMessage,
  describeClaudeError,
} from './claudeErrors';

/** Timeout for the `--version` availability probe. */
const PROBE_TIMEOUT_MS = 5000;

/** How much trailing stderr to keep for error messages. */
const STDERR_TAIL_LIMIT = 4096;

/**
 * The Claude Code backend: answers AI Helper chats by spawning the user's
 * locally installed `claude` CLI in non-interactive print mode, streaming
 * NDJSON back. Runs under the user's own Claude login — no API key involved.
 *
 * Privacy/behavior guarantees baked into the invocation (see `claudeCliArgs.ts`):
 * all tools disabled, one turn max, no session transcript written (so AI Helper
 * runs never show up in the extension's own Claude Code telemetry), spawned in
 * the home directory so workspace `.claude` settings don't apply.
 */
export class ClaudeCodeBackend implements ChatBackend {
  readonly id = 'claude-code' as const;
  readonly label = 'Claude Code';

  /** Cached probe result; failures re-probe so installing the CLI mid-session recovers. */
  private probed: { command: string } | undefined;

  private readonly hints: ClaudeCliHints;

  constructor(
    private readonly config: Pick<
      Configuration,
      'getAiHelperClaudeModel' | 'getAiHelperClaudeEffort' | 'getAiHelperClaudeCliPath'
    >,
    options?: { hints?: ClaudeCliHints },
  ) {
    this.hints = options?.hints ?? VSCODE_CLI_HINTS;
  }

  async isAvailable(): Promise<BackendAvailability> {
    const command = await this.resolveCommand();
    if (command === undefined) {
      return { available: false, reason: cliMissingMessage(this.hints) };
    }
    return { available: true };
  }

  async listModels(): Promise<ModelChoice[]> {
    return [...CLAUDE_MODEL_CHOICES];
  }

  async streamChat(
    request: ChatRequest,
    onDelta: (text: string) => void,
    token: CancellationToken,
  ): Promise<void> {
    const command = await this.resolveCommand();
    if (command === undefined) {
      throw new ClaudeCliError('Claude Code CLI was not found', { code: 'ENOENT' });
    }
    const prompt = serializeMessagesForCli(request.messages);
    const args = buildClaudeArgs(this.config.getAiHelperClaudeModel(), this.config.getAiHelperClaudeEffort());

    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnCli(command, args);
      } catch (err) {
        // Modern Node throws EINVAL synchronously for a bare .cmd spawn; the
        // shim wrapper avoids that, but a throw here must reject, not escape.
        reject(new ClaudeCliError(err instanceof Error ? err.message : String(err)));
        return;
      }

      const parser = new ClaudeStreamParser();
      let stderrTail = '';
      let sawDelta = false;
      let result: Extract<ClaudeEvent, { kind: 'result' }> | undefined;
      let cancelled = false;
      let spawnError: NodeJS.ErrnoException | undefined;

      const subscription = token.onCancellationRequested(() => {
        cancelled = true;
        child.kill();
      });

      const handleEvents = (events: ClaudeEvent[]): void => {
        for (const event of events) {
          if (event.kind === 'text') {
            sawDelta = true;
            onDelta(event.text);
          } else if (event.kind === 'result') {
            result = event;
          }
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => handleEvents(parser.push(chunk)));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        // Surfaced via 'close', which fires even after a failed spawn.
        spawnError = err;
      });

      // stdin errors (e.g. EPIPE when the process dies early) must not crash the host.
      child.stdin?.on('error', () => undefined);
      child.stdin?.write(prompt, 'utf8');
      child.stdin?.end();

      child.on('close', (exitCode) => {
        subscription.dispose();
        handleEvents(parser.flush());

        if (cancelled) {
          reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
          return;
        }
        if (spawnError) {
          reject(
            new ClaudeCliError(spawnError.message, { code: spawnError.code, stderrTail }),
          );
          return;
        }
        if ((exitCode !== null && exitCode !== 0) || result?.isError) {
          const trimmedTail = stderrTail.trim();
          const detail = result?.errorMessage ?? (trimmedTail.length > 0 ? trimmedTail : 'Claude Code CLI failed');
          reject(new ClaudeCliError(detail, { exitCode: exitCode ?? undefined, stderrTail }));
          return;
        }
        // Older CLIs without --include-partial-messages emit only the final result.
        if (!sawDelta && result !== undefined && result.resultText.length > 0) {
          onDelta(result.resultText);
        }
        resolve();
      });
    });
  }

  describeError(err: unknown): FriendlyError {
    return describeClaudeError(err, this.hints);
  }

  /**
   * Resolve the working CLI executable, probing `--version` over the candidate
   * list (base path, plus `.cmd` on Windows npm-shim installs). Success is
   * cached; failure is retried on the next call.
   */
  private async resolveCommand(): Promise<string | undefined> {
    if (this.probed) {
      return this.probed.command;
    }
    for (const candidate of claudeCommandCandidates(this.config.getAiHelperClaudeCliPath(), process.platform)) {
      if (await probeVersion(candidate)) {
        this.probed = { command: candidate };
        return candidate;
      }
    }
    return undefined;
  }
}

/**
 * Spawn the CLI — directly, or through cmd.exe when the command is an npm
 * `.cmd` shim (a direct spawn of one throws EINVAL on modern Node; see
 * `cliShim.ts`). The prompt travels via stdin either way — cmd.exe forwards
 * stdin to its child — so no argv-safety concern arises from wrapping.
 */
function spawnCli(command: string, args: string[]): ChildProcess {
  const options: SpawnOptions = {
    windowsHide: true,
    cwd: os.homedir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizeClaudeEnv(process.env),
  };
  return needsCmdShim(command, process.platform)
    ? spawn(buildCmdShimLine(command, args), { ...options, shell: true })
    : spawn(command, args, { ...options, shell: false });
}

/** Whether `<command> --version` exits 0 within the probe timeout. */
function probeVersion(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (err: unknown): void => resolve(err === null);
    try {
      if (needsCmdShim(command, process.platform)) {
        exec(buildCmdShimLine(command, ['--version']), { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, done);
      } else {
        execFile(command, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, done);
      }
    } catch {
      // A probe may never wedge availability: a synchronous spawn refusal
      // (EINVAL and friends) reads as "this candidate does not work".
      resolve(false);
    }
  });
}
