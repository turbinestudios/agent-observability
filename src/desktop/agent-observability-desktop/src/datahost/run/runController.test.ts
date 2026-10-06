import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventChange } from '../../shared/runTypes';
import { RUN_FLUSH_MS, RunController, diffStat, toRequest, type RunRecord } from './runController';
import type { DriverEvent, DriverPermissionAnswer, DriverSessionOptions, RunDriver } from './runDriver';

/**
 * The run host against a fake driver: no SDK, no CLI, no process. The fake
 * records every call and lets a test play runtime events into the controller.
 */
class FakeDriver implements RunDriver {
  calls: string[] = [];
  answers: { requestId: string; answer: DriverPermissionAnswer }[] = [];
  inputs: { requestId: string; answer: string | undefined }[] = [];
  sessions = new Map<string, DriverSessionOptions>();
  probeResult = { ok: true, cliVersion: '1.0.0', signedIn: true } as { ok: boolean; cliVersion?: string; signedIn?: boolean; problem?: string };
  failStart = false;

  probe = async () => {
    this.calls.push('probe');
    return this.probeResult;
  };
  listModels = async () => [{ id: 'auto', label: 'Auto' }];
  start = async (options: DriverSessionOptions) => {
    if (this.failStart) {
      throw new Error('could not start');
    }
    this.calls.push(`start:${options.cwd}`);
    this.sessions.set(options.sessionId, options);
  };
  resume = async (options: DriverSessionOptions) => {
    this.calls.push(`resume:${options.sessionId}`);
    this.sessions.set(options.sessionId, options);
  };
  send = async (sessionId: string, text: string) => void this.calls.push(`send:${sessionId}:${text}`);
  abort = async (sessionId: string) => void this.calls.push(`abort:${sessionId}`);
  close = async (sessionId: string) => void this.calls.push(`close:${sessionId}`);
  respondPermission = (_sessionId: string, requestId: string, answer: DriverPermissionAnswer) =>
    void this.answers.push({ requestId, answer });
  respondInput = (_sessionId: string, requestId: string, answer: string | undefined) => void this.inputs.push({ requestId, answer });
  dispose = async () => void this.calls.push('dispose');

  play(sessionId: string, event: DriverEvent): void {
    this.sessions.get(sessionId)?.onEvent(event);
  }
}

let driver: FakeDriver;
let events: { sessionId: string; change: RunEventChange }[];
let records: RunRecord[];
let enabled: boolean;
let acknowledged: boolean;
let turnEnds: string[];
let ids: number;

function controller(): RunController {
  return new RunController({
    driver,
    emit: (sessionId, change) => events.push({ sessionId, change }),
    enabled: () => enabled,
    acknowledged: () => acknowledged,
    renderMarkdown: (text) => `<p>${text}</p>`,
    records: { add: (record) => void records.push(record) },
    onTurnEnded: (sessionId) => void turnEnds.push(sessionId),
    now: () => 1_000,
    newId: () => `id-${(ids += 1)}`,
  });
}

const START = { goal: 'Fix the build', repository: 'https://github.com/o/r', cwd: 'C:/repo', door: 'blank' as const };
const statuses = (): string[] =>
  events.filter((e) => e.change.type === 'status').map((e) => (e.change as { status: string }).status);

beforeEach(() => {
  vi.useFakeTimers();
  driver = new FakeDriver();
  events = [];
  records = [];
  enabled = true;
  acknowledged = true;
  turnEnds = [];
  ids = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gates', () => {
  it('refuses to start, resume or send while Run is off or the notice is unread, without touching the driver', async () => {
    const run = controller();
    enabled = false;
    await expect(run.start(START)).rejects.toThrow('turned off');
    enabled = true;
    acknowledged = false;
    await expect(run.start(START)).rejects.toThrow('notice');
    await expect(run.resume({ sessionId: 's', repository: 'r', cwd: 'c' })).rejects.toThrow('notice');
    expect(driver.calls).toEqual([]);
  });

  it('does not start the CLI to report availability while Run is off', async () => {
    enabled = false;
    expect(await controller().availability()).toEqual({ enabled: false, acknowledged: true, cliFound: false, models: [] });
    expect(driver.calls).toEqual([]);
  });

  it('reports the probe problem and the models when on', async () => {
    const run = controller();
    expect(await run.availability()).toMatchObject({ cliFound: true, cliVersion: '1.0.0', signedIn: true, models: [{ id: 'auto' }] });
    driver.probeResult = { ok: false, problem: 'not found' };
    expect(await run.availability()).toMatchObject({ cliFound: false, problem: 'not found', models: [] });
  });
});

describe('a session', () => {
  it('starts with an app-generated id, records it, sends the goal and follows the status machine', async () => {
    const run = controller();
    const info = await run.start(START);
    expect(info.sessionId).toBe('id-1');
    expect(records).toEqual([{ sessionId: 'id-1', cwd: 'C:/repo', repository: START.repository, startedAtMs: 1_000, door: 'blank' }]);
    expect(driver.calls).toEqual(['start:C:/repo', 'send:id-1:Fix the build']);
    expect(statuses()).toEqual(['starting', 'working']);

    driver.play('id-1', { type: 'tool-start', toolCallId: 't1', name: 'Bash' });
    expect(run.liveStates()).toEqual([{ sessionId: 'id-1', status: 'working', lastActivityMs: 1_000, pendingTools: ['Bash'] }]);
    driver.play('id-1', { type: 'tool-end', toolCallId: 't1', success: false });
    driver.play('id-1', { type: 'idle' });
    expect(statuses()).toEqual(['starting', 'working', 'idle']);
    expect(turnEnds).toEqual(['id-1']);

    const tool = run.transcript('id-1')?.items.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ name: 'Bash', state: 'failed' });
    expect(run.transcript('id-1')?.info.title).toBe('Fix the build');
  });

  it('refuses an empty goal and reports a failed start as an error without leaving a session behind', async () => {
    const run = controller();
    await expect(run.start({ ...START, goal: '   ' })).rejects.toThrow('Write what');
    driver.failStart = true;
    await expect(run.start(START)).rejects.toThrow('could not start');
    expect(run.list()).toEqual([]);
    expect(statuses()).toContain('error');
  });

  it('coalesces streamed deltas into whole host-rendered messages', async () => {
    const run = controller();
    await run.start(START);
    events = [];
    driver.play('id-1', { type: 'delta', messageId: 'm', text: 'Hel' });
    driver.play('id-1', { type: 'delta', messageId: 'm', text: 'lo' });
    expect(events.filter((e) => e.change.type === 'item')).toHaveLength(0);
    vi.advanceTimersByTime(RUN_FLUSH_MS);
    const items = events.filter((e) => e.change.type === 'item').map((e) => (e.change as { item: unknown }).item);
    expect(items).toEqual([{ kind: 'assistant', id: 'a:m', html: '<p>Hello</p>', done: false }]);

    driver.play('id-1', { type: 'message', messageId: 'm', text: 'Hello there' });
    expect(run.transcript('id-1')?.items.at(-1)).toEqual({ kind: 'assistant', id: 'a:m', html: '<p>Hello there</p>', done: true });
  });

  it('resumes an existing session without sending anything', async () => {
    const run = controller();
    const info = await run.resume({ sessionId: 'abc', repository: 'r', cwd: 'c' });
    expect(info).toMatchObject({ sessionId: 'abc', status: 'idle', door: 'continue-session' });
    expect(driver.calls).toEqual(['resume:abc']);
    expect(records).toEqual([]);
  });
});

describe('permission requests', () => {
  const request = { requestId: 'p1', kind: 'shell', commandText: 'npm test', intention: 'Run tests', canAllowSession: true };

  it('parks the request, shows exactly what was asked, and releases it only on the answer', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request });
    expect(run.liveStates()[0]).toMatchObject({ status: 'waiting-approval', waitingFor: 'approval' });
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p1', commandText: 'npm test', sessionId: 'id-1' });
    expect(driver.answers).toEqual([]);

    run.respondPermission('p1', 'allow-once');
    expect(driver.answers).toEqual([{ requestId: 'p1', answer: { decision: 'allow-once' } }]);
    expect(run.transcript('id-1')?.pendingPermission).toBeUndefined();
    expect(statuses().at(-1)).toBe('working');

    // A second answer to the same request is ignored.
    run.respondPermission('p1', 'deny');
    expect(driver.answers).toHaveLength(1);
  });

  it.each([
    ['allow-session', { decision: 'allow-session' }],
    ['deny', { decision: 'deny', feedback: 'no' }],
  ] as const)('maps %s', async (decision, expected) => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request });
    run.respondPermission('p1', decision, 'no');
    expect(driver.answers[0].answer).toEqual(expected);
  });

  it('narrows a session-wide approval the runtime will not accept to this one request', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request: { ...request, canAllowSession: false } });
    run.respondPermission('p1', 'allow-session');
    expect(driver.answers[0].answer).toEqual({ decision: 'allow-once' });
  });

  it('turns an approval into a denial when Run was switched off meanwhile', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request });
    enabled = false;
    run.respondPermission('p1', 'allow-once');
    expect(driver.answers[0].answer).toEqual({ decision: 'deny' });
  });

  it('answers "user not available" when the turn is stopped or the app shuts down', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request });
    await run.abort('id-1');
    expect(driver.answers).toEqual([{ requestId: 'p1', answer: { decision: 'unavailable' } }]);
    expect(statuses().at(-1)).toBe('stopped');

    driver.play('id-1', { type: 'permission', request: { ...request, requestId: 'p2' } });
    driver.play('id-1', { type: 'input', requestId: 'q1', question: 'Which one?' });
    await run.shutdown();
    expect(driver.answers.at(-1)).toEqual({ requestId: 'p2', answer: { decision: 'unavailable' } });
    expect(driver.inputs).toEqual([{ requestId: 'q1', answer: undefined }]);
    expect(driver.calls.at(-1)).toBe('dispose');
    expect(run.activeCount()).toBe(0);
  });

  it('never forwards the diff body, only its line counts, and caps long text', () => {
    const shown = toRequest('s', {
      requestId: 'r',
      kind: 'write',
      fileName: 'a.ts',
      diff: '--- a\n+++ b\n+one\n+two\n-three\n context',
      commandText: 'x'.repeat(10_000),
      canAllowSession: true,
    });
    expect(shown.diffStat).toEqual({ added: 2, removed: 1 });
    expect(JSON.stringify(shown)).not.toContain('three');
    expect(shown.commandText).toHaveLength(4000);
    expect(diffStat('')).toEqual({ added: 0, removed: 0 });
  });
});

describe('questions from the agent', () => {
  it('waits for the answer and passes it through', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'input', requestId: 'q', question: 'Which branch?', choices: ['main', 'dev'] });
    expect(run.liveStates()[0]).toMatchObject({ status: 'waiting-input', waitingFor: 'input' });
    run.respondInput('q', 'main');
    expect(driver.inputs).toEqual([{ requestId: 'q', answer: 'main' }]);
    expect(statuses().at(-1)).toBe('working');
  });
});

describe('closing', () => {
  it('stops hosting but leaves the session to the driver, and ignores late events', async () => {
    const run = controller();
    await run.start(START);
    await run.close('id-1');
    expect(driver.calls.at(-1)).toBe('close:id-1');
    expect(run.list()).toEqual([]);
    const before = events.length;
    driver.play('id-1', { type: 'idle' });
    expect(events).toHaveLength(before);
  });
});
