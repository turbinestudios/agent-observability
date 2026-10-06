import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from './runDriver';
import { RUNTIME_ENDED, SdkRunDriver, isRuntimeGone, mapEvent, toDriverPermission, toSdkResult } from './sdkDriver';

/**
 * The driver against a fake SDK module: nothing here loads the real package
 * or starts a CLI. What is tested is the mapping in both directions and that
 * a permission request stays parked until it is answered, and what the
 * driver does when the CLI process behind it goes away.
 */
type Handler = (event: { type: string; data?: Record<string, unknown> }) => void;

function fakeSdk() {
  const state = {
    clientOptions: undefined as Record<string, unknown> | undefined,
    connection: undefined as { path: string; env?: Record<string, string> } | undefined,
    config: undefined as Record<string, unknown> | undefined,
    handler: undefined as Handler | undefined,
    sent: [] as string[],
    stopped: 0,
    authenticated: true,
    /** One entry per CLI process the driver started. */
    processes: [] as EventEmitter[],
    forceStopped: 0,
    resumed: [] as string[],
    startError: undefined as Error | undefined,
    /** What a call on the nth CLI (1-based) fails with, if anything. */
    callError: undefined as ((nth: number) => Error | undefined) | undefined,
    sendError: undefined as ((nth: number) => Error | undefined) | undefined,
  };
  const check = (pick: ((nth: number) => Error | undefined) | undefined, nth: number): void => {
    const err = pick?.(nth);
    if (err !== undefined) {
      throw err;
    }
  };
  const sessionOn = (nth: number) => ({
    on: (handler: Handler) => {
      state.handler = handler;
      return () => void (state.handler = undefined);
    },
    send: async (options: { prompt: string }) => {
      check(state.sendError, nth);
      state.sent.push(options.prompt);
      return 'id';
    },
    abort: async () => undefined,
    disconnect: async () => undefined,
  });
  class CopilotClient {
    readonly cliProcess = new EventEmitter();
    readonly nth: number;
    constructor(options: Record<string, unknown>) {
      state.clientOptions = options;
      state.processes.push(this.cliProcess);
      this.nth = state.processes.length;
    }
    start = async () => {
      if (state.startError !== undefined) {
        throw state.startError;
      }
    };
    stop = async () => void (state.stopped += 1);
    forceStop = async () => void (state.forceStopped += 1);
    getStatus = async () => {
      check(state.callError, this.nth);
      return { version: '9.9.9', protocolVersion: 3 };
    };
    getAuthStatus = async () => ({ isAuthenticated: state.authenticated });
    listModels = async () => [{ id: 'auto', name: 'Auto' }, { id: 'raw' }];
    createSession = async (config: Record<string, unknown>) => {
      check(state.callError, this.nth);
      state.config = config;
      return sessionOn(this.nth);
    };
    resumeSession = async (id: string, config: Record<string, unknown>) => {
      check(state.callError, this.nth);
      state.resumed.push(id);
      state.config = config;
      return sessionOn(this.nth);
    };
  }
  const RuntimeConnection = {
    forStdio: (options: { path: string; env?: Record<string, string> }) => {
      state.connection = options;
      return options;
    },
  };
  return { state, module: { CopilotClient, RuntimeConnection } };
}

function driverWith(sdk: ReturnType<typeof fakeSdk>, env: NodeJS.ProcessEnv = { KEEP: '1', COPILOT_ALLOW_ALL: '1' }) {
  return new SdkRunDriver({
    resolveRuntime: () => ({ target: { path: '/x/npm-loader.js', env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'npm-entry' } }),
    loadSdk: () => sdk.module as never,
    env,
  });
}

describe('toSdkResult', () => {
  it('can only produce the four scoped answers', () => {
    expect(toSdkResult({ decision: 'allow-once' })).toEqual({ kind: 'approve-once' });
    expect(toSdkResult({ decision: 'allow-session' })).toEqual({ kind: 'approve-for-session' });
    expect(toSdkResult({ decision: 'deny' })).toEqual({ kind: 'reject' });
    expect(toSdkResult({ decision: 'deny', feedback: 'no' })).toEqual({ kind: 'reject', feedback: 'no' });
    expect(toSdkResult({ decision: 'unavailable' })).toEqual({ kind: 'user-not-available' });
  });
});

describe('event mapping', () => {
  it('maps the events the host shows and ignores the rest', () => {
    expect(mapEvent({ type: 'assistant.message_delta', data: { messageId: 'm', deltaContent: 'hi' } })).toEqual({
      type: 'delta',
      messageId: 'm',
      text: 'hi',
    });
    expect(mapEvent({ type: 'assistant.message', data: { messageId: 'm', content: '' } })).toBeUndefined();
    expect(mapEvent({ type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'create' } })).toEqual({
      type: 'tool-start',
      toolCallId: 't',
      name: 'create',
    });
    expect(mapEvent({ type: 'tool.execution_complete', data: { toolCallId: 't', success: true } })).toEqual({
      type: 'tool-end',
      toolCallId: 't',
      success: true,
    });
    expect(
      mapEvent({ type: 'assistant.usage', data: { inputTokens: 2, outputTokens: 3, copilotUsage: { totalNanoAiu: 7 } } }),
    ).toEqual({ type: 'usage', inputTokens: 2, outputTokens: 3, nanoAiu: 7 });
    expect(mapEvent({ type: 'session.idle' })).toEqual({ type: 'idle' });
    expect(mapEvent({ type: 'session.error', data: {} })).toMatchObject({ type: 'error' });
    expect(mapEvent({ type: 'session.canvas.recorded', data: {} })).toBeUndefined();
  });

  it('reads a permission request by field, keeping the diff for counting only', () => {
    const request = toDriverPermission('r', {
      kind: 'write',
      toolCallId: 't',
      fileName: 'a.ts',
      intention: 'Create file',
      diff: '+x',
      canOfferSessionApproval: false,
      newFileContents: 'secret body',
    });
    expect(request).toEqual({
      requestId: 'r',
      kind: 'write',
      toolCallId: 't',
      fileName: 'a.ts',
      intention: 'Create file',
      diff: '+x',
      canAllowSession: false,
    });
  });
});

describe('SdkRunDriver', () => {
  it('launches the resolved runtime with a sanitized environment and reports the probe', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    expect(await driver.probe()).toEqual({ ok: true, cliVersion: '9.9.9', signedIn: true });
    expect(sdk.state.connection?.path).toBe('/x/npm-loader.js');
    expect(sdk.state.connection?.env).toEqual({ KEEP: '1', ELECTRON_RUN_AS_NODE: '1' });
    expect(await driver.listModels()).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'raw', label: 'raw' },
    ]);
  });

  it('says how to fix a missing CLI or a signed-out one, without loading the SDK for the former', async () => {
    let loaded = false;
    const missing = new SdkRunDriver({
      resolveRuntime: () => ({ problem: 'not installed' }),
      loadSdk: () => {
        loaded = true;
        throw new Error('must not load');
      },
    });
    expect(await missing.probe()).toEqual({ ok: false, problem: 'not installed' });
    expect(loaded).toBe(false);

    const sdk = fakeSdk();
    sdk.state.authenticated = false;
    expect(await driverWith(sdk).probe()).toMatchObject({ ok: false, signedIn: false, problem: expect.stringContaining('sign in') });
  });

  it('parks a permission request until answered, and releases it as unavailable on abort', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    const events: DriverEvent[] = [];
    await driver.start({ sessionId: 's', cwd: '/repo', model: 'auto', onEvent: (event) => events.push(event) });
    expect(sdk.state.config).toMatchObject({ sessionId: 's', workingDirectory: '/repo', model: 'auto', streaming: true });

    const ask = sdk.state.config?.onPermissionRequest as (r: Record<string, unknown>) => Promise<unknown>;
    let settled: unknown;
    const first = ask({ kind: 'shell', fullCommandText: 'rm x' }).then((result) => void (settled = result));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    const raised = events.find((e) => e.type === 'permission') as Extract<DriverEvent, { type: 'permission' }>;
    expect(raised.request).toMatchObject({ kind: 'shell', commandText: 'rm x' });
    driver.respondPermission('s', raised.request.requestId, { decision: 'deny', feedback: 'no' });
    await first;
    expect(settled).toEqual({ kind: 'reject', feedback: 'no' });

    const second = ask({ kind: 'write', fileName: 'a' });
    await driver.abort('s');
    expect(await second).toEqual({ kind: 'user-not-available' });

    sdk.state.handler?.({ type: 'session.idle' });
    expect(events.at(-1)).toEqual({ type: 'idle' });
    await driver.send('s', 'hello');
    expect(sdk.state.sent).toEqual(['hello']);
    await driver.dispose();
    await driver.dispose();
    expect(sdk.state.stopped).toBe(1);
    await expect(driver.send('s', 'x')).rejects.toThrow('not open');
  });
});

describe('isRuntimeGone', () => {
  it('tells a CLI that is gone from a CLI that answered with an error', () => {
    expect(isRuntimeGone(new Error('Cannot call write after a stream was destroyed'))).toBe(true);
    expect(isRuntimeGone(Object.assign(new Error('write failed'), { code: 'EPIPE' }))).toBe(true);
    expect(isRuntimeGone(new Error('Connection is closed.'))).toBe(true);
    expect(isRuntimeGone(new Error('CLI server exited unexpectedly with code 1'))).toBe(true);
    expect(isRuntimeGone(new Error('Client not connected'))).toBe(true);
    expect(isRuntimeGone(new Error('Model not available'))).toBe(false);
    expect(isRuntimeGone('quota exceeded')).toBe(false);
    expect(isRuntimeGone(undefined)).toBe(false);
  });
});

describe('SdkRunDriver when the CLI process goes away', () => {
  const gone = (): Error => new Error('Cannot call write after a stream was destroyed');

  it('starts a fresh CLI and tries once more when the one it had is gone', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    expect((await driver.probe()).ok).toBe(true);
    // The first CLI dies between two looks at the Run view.
    sdk.state.callError = (nth) => (nth === 1 ? gone() : undefined);
    expect(await driver.probe()).toEqual({ ok: true, cliVersion: '9.9.9', signedIn: true });
    expect(sdk.state.processes).toHaveLength(2);
    expect(sdk.state.forceStopped).toBe(1);
    // The fresh one is kept: a third look starts nothing.
    expect((await driver.probe()).ok).toBe(true);
    expect(sdk.state.processes).toHaveLength(2);
  });

  it('gives up after one retry, and words a start failure and a lost CLI differently', async () => {
    const sdk = fakeSdk();
    sdk.state.callError = () => gone();
    const lostCli = await driverWith(sdk).probe();
    expect(lostCli.ok).toBe(false);
    expect(lostCli.problem).toContain('stopped answering');
    expect(lostCli.problem).not.toContain('could not be started');
    expect(sdk.state.processes).toHaveLength(2);

    const failing = fakeSdk();
    failing.state.startError = new Error('spawn EINVAL');
    expect(await driverWith(failing).probe()).toEqual({
      ok: false,
      problem: 'GitHub Copilot CLI could not be started from /x/npm-loader.js: spawn EINVAL',
    });
  });

  it('keeps hosted sessions when a probe fails for another reason', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    const events: DriverEvent[] = [];
    await driver.start({ sessionId: 's', cwd: '/repo', onEvent: (event) => events.push(event) });
    sdk.state.callError = () => new Error('rate limited');
    expect(await driver.probe()).toMatchObject({ ok: false, problem: expect.stringContaining('rate limited') });
    sdk.state.callError = undefined;
    await driver.send('s', 'still here');
    expect(sdk.state.sent).toEqual(['still here']);
    expect(events).toEqual([]);
    expect(sdk.state.processes).toHaveLength(1);
  });

  it('tells a session its CLI ended, and reconnects it when the user sends the next message', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    const events: DriverEvent[] = [];
    await driver.start({ sessionId: 's', cwd: '/repo', model: 'auto', onEvent: (event) => events.push(event) });

    const ask = sdk.state.config?.onPermissionRequest as (r: Record<string, unknown>) => Promise<unknown>;
    const parked = ask({ kind: 'shell', fullCommandText: 'npm test' });
    sdk.state.processes[0].emit('exit');
    // Nothing stays parked, and nothing was approved.
    expect(await parked).toEqual({ kind: 'user-not-available' });
    expect(events.at(-1)).toEqual({ type: 'error', message: RUNTIME_ENDED });
    // Nothing reconnects by itself.
    expect(sdk.state.processes).toHaveLength(1);
    expect(sdk.state.resumed).toEqual([]);

    await driver.send('s', 'carry on');
    expect(sdk.state.processes).toHaveLength(2);
    expect(sdk.state.resumed).toEqual(['s']);
    expect(sdk.state.config).toMatchObject({ sessionId: 's', workingDirectory: '/repo', model: 'auto' });
    expect(sdk.state.sent).toEqual(['carry on']);
    // The reconnected session reports through the same handler.
    sdk.state.handler?.({ type: 'session.idle' });
    expect(events.at(-1)).toEqual({ type: 'idle' });
  });

  it('reconnects and sends once when the CLI is found gone while sending, without a notice for that session', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    const events: DriverEvent[] = [];
    await driver.start({ sessionId: 's', cwd: '/repo', onEvent: (event) => events.push(event) });
    sdk.state.sendError = (nth) => (nth === 1 ? gone() : undefined);
    await driver.send('s', 'hello');
    expect(sdk.state.sent).toEqual(['hello']);
    expect(sdk.state.resumed).toEqual(['s']);
    expect(events).toEqual([]);
  });

  it('does not reconnect a session the user closed after its CLI ended', async () => {
    const sdk = fakeSdk();
    const driver = driverWith(sdk);
    await driver.start({ sessionId: 's', cwd: '/repo', onEvent: () => undefined });
    sdk.state.processes[0].emit('exit');
    await driver.close('s');
    await expect(driver.send('s', 'x')).rejects.toThrow('not open');
    expect(sdk.state.resumed).toEqual([]);
  });
});
