import { randomUUID } from 'node:crypto';
import { sanitizeCopilotEnv } from '@agent-observability/core/src/chat/backends/copilotCliArgs';
import type {
  DriverEvent,
  DriverPermission,
  DriverPermissionAnswer,
  DriverProbe,
  DriverSessionOptions,
  RunDriver,
} from './runDriver';
import type { RuntimeResolution } from './runtimePath';

/**
 * The Copilot SDK behind the {@link RunDriver} seam — the ONLY file in the
 * app that loads `@github/copilot-sdk`.
 *
 * It drives the user's own installed Copilot CLI under their own login: the
 * launch target comes from `runtimePath.ts`, never from a runtime shipped
 * with the app. The SDK is loaded lazily, on the first probe, so an app that
 * never opens Run never touches it.
 *
 * Permissions: every request is handed up and the session waits for the
 * user's answer. The only answers this file can produce are the two
 * approvals scoped to this request or this session, a rejection, and "the
 * user is not available". It has no code path that approves on the user's
 * behalf or that persists an approval; `runSafety.test.ts` scans this
 * directory to keep it that way.
 *
 * The CLI is a separate process and can end at any time: a crash, the user
 * ending it, an update replacing it. A call that finds it gone starts a
 * fresh one and is tried once more; sessions that were running on the old
 * one are told, and the next message the user sends reconnects them. Nothing
 * is ever re-sent on the user's behalf.
 *
 * The SDK surface is described structurally below rather than imported as
 * types, so this file compiles the same whichever module format the SDK
 * resolves to, and a field the SDK adds or drops is a runtime `undefined`
 * here rather than a broken build. Verified against @github/copilot-sdk
 * 1.0.16 (2026-10-06).
 */

interface SdkEvent {
  type: string;
  data?: Record<string, unknown>;
}

type SdkPermissionResult =
  | { kind: 'approve-once' }
  | { kind: 'approve-for-session' }
  | { kind: 'reject'; feedback?: string }
  | { kind: 'user-not-available' };

interface SdkSession {
  on(handler: (event: SdkEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

interface SdkSessionConfig {
  sessionId?: string;
  workingDirectory: string;
  model?: string;
  streaming: boolean;
  onPermissionRequest: (request: Record<string, unknown>) => Promise<SdkPermissionResult>;
  onUserInputRequest: (request: { question: string; choices?: string[] }) => Promise<{ answer: string; wasFreeform: boolean }>;
}

interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop?(): Promise<void>;
  /** The CLI child process, when the SDK started one. */
  cliProcess?: { once(event: 'exit', listener: () => void): unknown } | null;
  /** What the CLI wrote to stderr so far. */
  stderrBuffer?: string;
  getStatus(): Promise<{ version: string; protocolVersion: number }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  listModels(): Promise<{ id: string; name?: string }[]>;
  createSession(config: SdkSessionConfig): Promise<SdkSession>;
  resumeSession(sessionId: string, config: SdkSessionConfig): Promise<SdkSession>;
}

interface SdkModule {
  CopilotClient: new (options: Record<string, unknown>) => SdkClient;
  RuntimeConnection: { forStdio(options: { path: string; env?: Record<string, string> }): unknown };
}

interface Hosted {
  options: DriverSessionOptions;
  session: SdkSession;
  off: () => void;
  onEvent: (event: DriverEvent) => void;
  permissions: Map<string, (result: SdkPermissionResult) => void>;
  inputs: Map<string, (answer: string | undefined) => void>;
}

export interface SdkDriverDeps {
  /** Resolves the user's installed CLI; called on every (re)start so a Settings change is honoured. */
  resolveRuntime: () => RuntimeResolution;
  /** Seam for tests; the default loads the real SDK on first use. */
  loadSdk?: () => SdkModule;
  env?: NodeJS.ProcessEnv;
}

/** What a session is told when the CLI process it ran on has gone. */
export const RUNTIME_ENDED =
  'GitHub Copilot CLI stopped running, so this session was disconnected. It is saved: send a message to reconnect and continue.';

const RUNTIME_GONE =
  /stream was destroyed|write after end|EPIPE|Connection is (closed|disposed)|Client (is )?not connected|CLI server (exited|connection failed)/i;

/**
 * Whether an error says the CLI process, or the pipe to it, is gone, as
 * opposed to the CLI answering with an error of its own.
 */
export function isRuntimeGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'EPIPE') {
    return true;
  }
  return RUNTIME_GONE.test(messageOf(err));
}

function loadRealSdk(): SdkModule {
  // Lazy and external: electron-vite leaves this require for runtime, and
  // nothing is loaded until Run is actually used.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('@github/copilot-sdk') as SdkModule;
}

export class SdkRunDriver implements RunDriver {
  private client: SdkClient | undefined;
  private starting: Promise<SdkClient> | undefined;
  private readonly sessions = new Map<string, Hosted>();
  /** Sessions whose CLI process ended under them; the user's next message reconnects one. */
  private readonly lost = new Map<string, DriverSessionOptions>();
  /** Bumped by `dispose`, so a start that was still in flight does not outlive it. */
  private generation = 0;

  constructor(private readonly deps: SdkDriverDeps) {}

  async probe(): Promise<DriverProbe> {
    const resolved = this.deps.resolveRuntime();
    if ('problem' in resolved) {
      return { ok: false, problem: resolved.problem };
    }
    let started = false;
    try {
      const { status, auth } = await this.withClient(async (client) => {
        started = true;
        return { status: await client.getStatus(), auth: await client.getAuthStatus() };
      });
      if (!auth.isAuthenticated) {
        return {
          ok: false,
          cliVersion: status.version,
          signedIn: false,
          problem: 'GitHub Copilot CLI is not signed in. Run `copilot` in a terminal and sign in, then try again.',
        };
      }
      return { ok: true, cliVersion: status.version, signedIn: true };
    } catch (err) {
      // Sessions the app is hosting are left alone here: a probe that fails is
      // no reason to close them, and `withClient` has already dealt with a
      // CLI that is gone.
      return {
        ok: false,
        problem: started
          ? `GitHub Copilot CLI stopped answering: ${messageOf(err)}`
          : `GitHub Copilot CLI could not be started from ${resolved.target.path}: ${messageOf(err)}`,
      };
    }
  }

  async listModels(): Promise<{ id: string; label: string }[]> {
    const models = await this.withClient((client) => client.listModels());
    return models.map((model) => ({ id: model.id, label: model.name ?? model.id }));
  }

  async start(options: DriverSessionOptions): Promise<void> {
    const hosted = this.prepare(options);
    hosted.session = await this.withClient((client) => client.createSession(this.config(options, hosted)));
    this.attach(options.sessionId, hosted);
  }

  async resume(options: DriverSessionOptions): Promise<void> {
    this.lost.delete(options.sessionId);
    const hosted = this.prepare(options);
    hosted.session = await this.withClient((client) =>
      client.resumeSession(options.sessionId, this.config(options, hosted)),
    );
    this.attach(options.sessionId, hosted);
  }

  async send(sessionId: string, text: string): Promise<void> {
    // The user sending a message is what reconnects a session that lost its CLI.
    const lost = this.lost.get(sessionId);
    if (lost !== undefined) {
      await this.resume(lost);
    }
    const hosted = this.require(sessionId);
    try {
      await hosted.session.send({ prompt: text });
    } catch (err) {
      if (!isRuntimeGone(err)) {
        throw err;
      }
      // The CLI went away before this message reached it, so nothing was
      // sent: reconnect this session and send it once.
      await this.drop(this.client, sessionId);
      await this.resume(hosted.options);
      await this.require(sessionId).session.send({ prompt: text });
    }
  }

  async abort(sessionId: string): Promise<void> {
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      return;
    }
    this.releasePending(hosted);
    try {
      await hosted.session.abort();
    } catch (err) {
      if (!isRuntimeGone(err)) {
        throw err;
      }
      // Nothing is left to stop: the CLI itself is gone.
      await this.drop(this.client);
    }
  }

  async close(sessionId: string): Promise<void> {
    this.lost.delete(sessionId);
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      return;
    }
    this.sessions.delete(sessionId);
    this.releasePending(hosted);
    hosted.off();
    try {
      await hosted.session.disconnect();
    } catch {
      // The session stays on disk either way.
    }
  }

  respondPermission(sessionId: string, requestId: string, answer: DriverPermissionAnswer): void {
    const hosted = this.sessions.get(sessionId);
    const resolve = hosted?.permissions.get(requestId);
    if (hosted === undefined || resolve === undefined) {
      return;
    }
    hosted.permissions.delete(requestId);
    resolve(toSdkResult(answer));
  }

  respondInput(sessionId: string, requestId: string, answer: string | undefined): void {
    const hosted = this.sessions.get(sessionId);
    const resolve = hosted?.inputs.get(requestId);
    if (hosted === undefined || resolve === undefined) {
      return;
    }
    hosted.inputs.delete(requestId);
    resolve(answer);
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.lost.clear();
    for (const sessionId of [...this.sessions.keys()]) {
      await this.close(sessionId);
    }
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    if (client !== undefined) {
      try {
        await client.stop();
      } catch {
        try {
          await client.forceStop?.();
        } catch {
          // Nothing further to do: the process is going away.
        }
      }
    }
  }

  // ── internals ──

  /**
   * Run one call against the CLI. If the CLI turns out to be gone, start a
   * fresh one and try once more; any other failure is the caller's.
   */
  private async withClient<T>(call: (client: SdkClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.ensureClient();
      try {
        return await call(client);
      } catch (err) {
        if (!isRuntimeGone(err)) {
          throw err;
        }
        const stderr = stderrTail(client);
        await this.drop(client);
        if (attempt > 0) {
          throw stderr.length > 0 ? new Error(`${messageOf(err)} (${stderr})`) : err;
        }
      }
    }
  }

  /**
   * The CLI behind `client` is gone: forget it, tell every session it hosted,
   * and keep what is needed to reconnect each one. A stale caller (the client
   * was already replaced) changes nothing. `quiet` names a session that is
   * being reconnected right now and needs no notice.
   */
  private async drop(client: SdkClient | undefined, quiet?: string): Promise<void> {
    if (client === undefined || this.client !== client) {
      return;
    }
    this.client = undefined;
    this.starting = undefined;
    for (const [sessionId, hosted] of [...this.sessions]) {
      this.sessions.delete(sessionId);
      this.releasePending(hosted);
      hosted.off();
      this.lost.set(sessionId, hosted.options);
      if (sessionId !== quiet) {
        hosted.onEvent({ type: 'error', message: RUNTIME_ENDED });
      }
    }
    try {
      await (client.forceStop !== undefined ? client.forceStop() : client.stop());
    } catch {
      // It is already gone.
    }
  }

  private ensureClient(): Promise<SdkClient> {
    if (this.client !== undefined) {
      return Promise.resolve(this.client);
    }
    this.starting ??= this.startClient().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private async startClient(): Promise<SdkClient> {
    const resolved = this.deps.resolveRuntime();
    if ('problem' in resolved) {
      throw new Error(resolved.problem);
    }
    const sdk = (this.deps.loadSdk ?? loadRealSdk)();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizeCopilotEnv(this.deps.env ?? process.env))) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    Object.assign(env, resolved.target.env);
    const client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forStdio({ path: resolved.target.path, env }),
      logLevel: 'error',
    });
    const generation = this.generation;
    await client.start();
    if (generation !== this.generation) {
      // The driver was disposed while the CLI was starting.
      await client.stop().catch(() => undefined);
      throw new Error('Run was shut down.');
    }
    this.client = client;
    // Notice a CLI that ends by itself at once, not on the next call.
    client.cliProcess?.once('exit', () => void this.drop(client));
    return client;
  }

  private prepare(options: DriverSessionOptions): Hosted {
    return {
      options,
      session: undefined as unknown as SdkSession,
      off: () => undefined,
      onEvent: options.onEvent,
      permissions: new Map(),
      inputs: new Map(),
    };
  }

  private config(options: DriverSessionOptions, hosted: Hosted): SdkSessionConfig {
    return {
      sessionId: options.sessionId,
      workingDirectory: options.cwd,
      ...(options.model !== undefined && options.model.length > 0 ? { model: options.model } : {}),
      streaming: true,
      onPermissionRequest: (request) =>
        new Promise<SdkPermissionResult>((resolve) => {
          const requestId = randomUUID();
          hosted.permissions.set(requestId, resolve);
          hosted.onEvent({ type: 'permission', request: toDriverPermission(requestId, request) });
        }),
      onUserInputRequest: (request) =>
        new Promise<{ answer: string; wasFreeform: boolean }>((resolve, reject) => {
          const requestId = randomUUID();
          hosted.inputs.set(requestId, (answer) => {
            if (answer === undefined) {
              reject(new Error('The question was cancelled.'));
            } else {
              resolve({ answer, wasFreeform: !(request.choices ?? []).includes(answer) });
            }
          });
          hosted.onEvent({
            type: 'input',
            requestId,
            question: request.question,
            ...(request.choices !== undefined ? { choices: request.choices } : {}),
          });
        }),
    };
  }

  private attach(sessionId: string, hosted: Hosted): void {
    this.sessions.get(sessionId)?.off();
    hosted.off = hosted.session.on((event) => {
      const mapped = mapEvent(event);
      if (mapped !== undefined) {
        hosted.onEvent(mapped);
      }
    });
    this.sessions.set(sessionId, hosted);
  }

  private require(sessionId: string): Hosted {
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      throw new Error('This session is not open in the app. Resume it first.');
    }
    return hosted;
  }

  /** Nothing may stay parked when a turn is aborted or a session closes. */
  private releasePending(hosted: Hosted): void {
    for (const resolve of hosted.permissions.values()) {
      resolve({ kind: 'user-not-available' });
    }
    hosted.permissions.clear();
    for (const resolve of hosted.inputs.values()) {
      resolve(undefined);
    }
    hosted.inputs.clear();
  }
}

/** The complete set of answers this app can give a permission request. */
export function toSdkResult(answer: DriverPermissionAnswer): SdkPermissionResult {
  switch (answer.decision) {
    case 'allow-once':
      return { kind: 'approve-once' };
    case 'allow-session':
      return { kind: 'approve-for-session' };
    case 'deny':
      return answer.feedback !== undefined && answer.feedback.length > 0
        ? { kind: 'reject', feedback: answer.feedback }
        : { kind: 'reject' };
    case 'unavailable':
      return { kind: 'user-not-available' };
  }
}

export function toDriverPermission(requestId: string, request: Record<string, unknown>): DriverPermission {
  return {
    requestId,
    kind: str(request.kind) ?? 'unknown',
    ...opt('toolCallId', str(request.toolCallId)),
    ...opt('toolName', str(request.toolName)),
    ...opt('fileName', str(request.fileName)),
    ...opt('commandText', str(request.fullCommandText)),
    ...opt('intention', str(request.intention)),
    ...opt('diff', str(request.diff)),
    canAllowSession: request.canOfferSessionApproval !== false,
  };
}

/** One SDK event as a driver-neutral one, or `undefined` for events the host ignores. */
export function mapEvent(event: SdkEvent): DriverEvent | undefined {
  const data = event.data ?? {};
  switch (event.type) {
    case 'assistant.message_delta':
      return { type: 'delta', messageId: str(data.messageId) ?? 'message', text: str(data.deltaContent) ?? '' };
    case 'assistant.message': {
      const text = str(data.content) ?? '';
      // A message that only carries tool requests has no text to show.
      return text.length === 0 ? undefined : { type: 'message', messageId: str(data.messageId) ?? 'message', text };
    }
    case 'assistant.reasoning_delta':
      return { type: 'reasoning-delta', reasoningId: str(data.reasoningId) ?? 'reasoning', text: str(data.deltaContent) ?? '' };
    case 'assistant.reasoning':
      return { type: 'reasoning', reasoningId: str(data.reasoningId) ?? 'reasoning', text: str(data.content) ?? '' };
    case 'tool.execution_start':
      return { type: 'tool-start', toolCallId: str(data.toolCallId) ?? randomUUID(), name: str(data.toolName) ?? 'tool' };
    case 'tool.execution_complete':
      return { type: 'tool-end', toolCallId: str(data.toolCallId) ?? '', success: data.success === true };
    case 'assistant.usage': {
      const usage = data.copilotUsage as { totalNanoAiu?: unknown } | undefined;
      return {
        type: 'usage',
        inputTokens: num(data.inputTokens),
        outputTokens: num(data.outputTokens),
        ...(typeof usage?.totalNanoAiu === 'number' ? { nanoAiu: usage.totalNanoAiu } : {}),
      };
    }
    case 'session.idle':
      return { type: 'idle' };
    case 'session.error':
      return { type: 'error', message: str(data.message) ?? 'The session reported an error.' };
    default:
      return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function opt<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** The last thing the CLI said on stderr, for a failure that has no better explanation. */
function stderrTail(client: SdkClient): string {
  const text = typeof client.stderrBuffer === 'string' ? client.stderrBuffer.trim() : '';
  return text.length > 300 ? `…${text.slice(-300)}` : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
