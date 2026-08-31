import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '../../config/configuration';
import { FriendlyError } from '../lmErrors';
import type { CancellationToken } from './cancellation';
import { BackendAvailability, ChatBackend, ChatRequest, ModelChoice } from './chatBackend';
import { serializeMessagesForCli } from './claudeCliArgs';
import {
  COPILOT_ARGV_PROMPT_LIMIT,
  COPILOT_CLI_MODEL_CHOICES,
  buildCopilotArgs,
  buildCopilotPayloadArgs,
  copilotCommandCandidates,
  sanitizeCopilotEnv,
} from './copilotCliArgs';
import { CopilotEvent, CopilotStreamParser } from './copilotStreamParser';
import {
  CopilotCliError,
  CopilotCliHints,
  VSCODE_COPILOT_CLI_HINTS,
  copilotCliMissingMessage,
  describeCopilotCliError,
} from './copilotCliErrors';

/** Timeout for the `--version` availability probe. */
const PROBE_TIMEOUT_MS = 5000;

/** How much trailing stderr to keep for error messages. */
const STDERR_TAIL_LIMIT = 4096;

/**
 * The GitHub Copilot CLI backend: answers chats by spawning the user's locally
 * installed standalone `copilot` CLI (npm `@github/copilot`) in non-interactive
 * prompt mode, streaming NDJSON back. Runs under the user's own GitHub Copilot
 * login — no API key involved.
 *
 * Privacy/behavior guarantees baked into the invocation (probed against CLI
 * v1.0.82; see `copilotCliArgs.ts`): no tools for argv-sized prompts (a single
 * pre-approved `view` tool over one app-owned temp directory for larger ones),
 * built-in MCP servers disabled, custom instructions not loaded, the session
 * never exported to GitHub web/mobile, spawned in the home directory so
 * repository configuration doesn't apply, and permission-widening environment
 * variables stripped.
 */
export class CopilotCliBackend implements ChatBackend {
  readonly id = 'copilot-cli' as const;
  readonly label = 'GitHub Copilot CLI';

  /** Cached probe result; failures re-probe so installing the CLI mid-session recovers. */
  private probed: { command: string } | undefined;

  private readonly hints: CopilotCliHints;

  constructor(
    private readonly config: Pick<
      Configuration,
      'getAiHelperCopilotCliModel' | 'getAiHelperCopilotCliPath'
    >,
    options?: { hints?: CopilotCliHints },
  ) {
    this.hints = options?.hints ?? VSCODE_COPILOT_CLI_HINTS;
  }

  async isAvailable(): Promise<BackendAvailability> {
    const command = await this.resolveCommand();
    if (command === undefined) {
      return { available: false, reason: copilotCliMissingMessage(this.hints) };
    }
    return { available: true };
  }

  async listModels(): Promise<ModelChoice[]> {
    return [...COPILOT_CLI_MODEL_CHOICES];
  }

  async streamChat(
    request: ChatRequest,
    onDelta: (text: string) => void,
    token: CancellationToken,
  ): Promise<void> {
    const command = await this.resolveCommand();
    if (command === undefined) {
      throw new CopilotCliError('GitHub Copilot CLI was not found', { code: 'ENOENT' });
    }
    const prompt = serializeMessagesForCli(request.messages);
    const model = this.config.getAiHelperCopilotCliModel();

    // The CLI reads nothing from stdin in prompt mode, so a prompt too large
    // for a command line travels as a payload file the model reads with its
    // `view` tool — one file, in one app-owned temp directory, deleted after.
    let payloadDir: string | undefined;
    let args: string[];
    if (prompt.length > COPILOT_ARGV_PROMPT_LIMIT) {
      payloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copilot-'));
      const payloadPath = path.join(payloadDir, 'prompt.md');
      fs.writeFileSync(payloadPath, prompt, 'utf8');
      args = buildCopilotPayloadArgs(model, payloadPath, payloadDir);
    } else {
      args = buildCopilotArgs(model, prompt);
    }

    try {
      await this.run(command, args, onDelta, token);
    } finally {
      if (payloadDir !== undefined) {
        fs.rmSync(payloadDir, { recursive: true, force: true });
      }
    }
  }

  describeError(err: unknown): FriendlyError {
    return describeCopilotCliError(err, this.hints);
  }

  private run(
    command: string,
    args: string[],
    onDelta: (text: string) => void,
    token: CancellationToken,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeCopilotEnv(process.env),
      });

      const parser = new CopilotStreamParser();
      let stderrTail = '';
      let sawDelta = false;
      let fullMessage = '';
      let resultExit: number | undefined;
      let cancelled = false;
      let spawnError: NodeJS.ErrnoException | undefined;

      const subscription = token.onCancellationRequested(() => {
        cancelled = true;
        child.kill();
      });

      const handleEvents = (events: CopilotEvent[]): void => {
        for (const event of events) {
          if (event.kind === 'text') {
            sawDelta = true;
            onDelta(event.text);
          } else if (event.kind === 'message') {
            fullMessage = event.text;
          } else {
            resultExit = event.exitCode;
          }
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => handleEvents(parser.push(chunk)));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        // Surfaced via 'close', which fires even after a failed spawn.
        spawnError = err;
      });

      child.on('close', (exitCode) => {
        subscription.dispose();
        handleEvents(parser.flush());

        if (cancelled) {
          reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
          return;
        }
        if (spawnError) {
          reject(new CopilotCliError(spawnError.message, { code: spawnError.code, stderrTail }));
          return;
        }
        const failed = (exitCode !== null && exitCode !== 0) || (resultExit !== undefined && resultExit !== 0);
        if (failed) {
          const trimmedTail = stderrTail.trim();
          const detail = trimmedTail.length > 0 ? trimmedTail : 'GitHub Copilot CLI failed';
          reject(new CopilotCliError(detail, { exitCode: exitCode ?? resultExit, stderrTail }));
          return;
        }
        // A stream that carried no deltas still ends with the full message.
        if (!sawDelta && fullMessage.length > 0) {
          onDelta(fullMessage);
        }
        resolve();
      });
    });
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
    for (const candidate of copilotCommandCandidates(this.config.getAiHelperCopilotCliPath(), process.platform)) {
      if (await probeVersion(candidate)) {
        this.probed = { command: candidate };
        return candidate;
      }
    }
    return undefined;
  }
}

/** Whether `<command> --version` exits 0 within the probe timeout. */
function probeVersion(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err) => {
      resolve(err === null);
    });
  });
}
