import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEventChange } from '../../shared/runTypes';
import {
  RUN_ALLOW_ALL_REFUSED,
  RUN_ALLOW_ALL_STUCK,
  RUN_FLUSH_MS,
  RUN_MODE_ALLOW_ALL_NOTE,
  RUN_MODE_DEFAULT_NOTE,
  RUN_MODE_LOST_NOTE,
  RunController,
  diffStat,
  sortModels,
  toRequest,
  type RunRecord,
} from './runController';
import type { DriverEvent, DriverPermission, DriverPermissionAnswer, DriverSessionOptions, RunDriver } from './runDriver';

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
  models = [{ id: 'auto', label: 'Auto' }];
  listModels = async () => this.models;
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
  /** Whether the runtime takes a change of its allow-all mode. */
  allowAllTaken = true;
  setAllowAll = async (sessionId: string, enabled: boolean) => {
    this.calls.push(`allow-all:${sessionId}:${enabled}`);
    return this.allowAllTaken;
  };
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
  const request: DriverPermission = {
    requestId: 'p1',
    kind: 'shell',
    commandText: 'npm test',
    intention: 'Run tests',
    canAllowSession: true,
    mustAsk: false,
  };

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
      mustAsk: false,
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

describe('several requests at once', () => {
  const read = (requestId: string): DriverPermission => ({
    requestId,
    kind: 'read',
    fileName: `${requestId}.ts`,
    canAllowSession: true,
    sessionScope: { kind: 'read' },
    mustAsk: false,
  });
  const write = (requestId: string): DriverPermission => ({
    requestId,
    kind: 'write',
    fileName: `${requestId}.ts`,
    canAllowSession: true,
    sessionScope: { kind: 'write' },
    mustAsk: false,
  });

  it('keeps every request: one is shown, the rest wait, and none is lost when the first is answered', async () => {
    const run = controller();
    await run.start(START);
    // The agent asks to do two things in the same turn.
    driver.play('id-1', { type: 'permission', request: read('p1') });
    driver.play('id-1', { type: 'permission', request: write('p2') });
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p1', more: 1 });

    run.respondPermission('p1', 'allow-once');
    // The second one is now on screen and the session is still waiting on the user.
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p2' });
    expect(run.transcript('id-1')?.pendingPermission?.more).toBeUndefined();
    expect(run.liveStates()[0].status).toBe('waiting-approval');
    expect(events.at(-1)?.change).toMatchObject({ type: 'permission', request: { requestId: 'p2' } });

    run.respondPermission('p2', 'deny');
    expect(driver.answers).toEqual([
      { requestId: 'p1', answer: { decision: 'allow-once' } },
      { requestId: 'p2', answer: { decision: 'deny' } },
    ]);
    expect(run.transcript('id-1')?.pendingPermission).toBeUndefined();
    expect(run.liveStates()[0].status).toBe('working');
  });

  it('releases every waiting request as unavailable when the turn is stopped', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request: read('p1') });
    driver.play('id-1', { type: 'permission', request: write('p2') });
    await run.abort('id-1');
    expect(driver.answers.map((a) => [a.requestId, a.answer.decision])).toEqual([
      ['p1', 'unavailable'],
      ['p2', 'unavailable'],
    ]);
  });

  it('lets "for this session" answer what it covers: waiting requests and later ones, and nothing else', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request: read('p1') });
    driver.play('id-1', { type: 'permission', request: read('p2') });
    driver.play('id-1', { type: 'permission', request: write('p3') });
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ sessionScopeLabel: 'reading files', more: 2 });

    run.respondPermission('p1', 'allow-session');
    // The other read is covered; the write is not, and is asked.
    expect(driver.answers).toEqual([
      { requestId: 'p1', answer: { decision: 'allow-session' } },
      { requestId: 'p2', answer: { decision: 'allow-once' } },
    ]);
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p3' });
    run.respondPermission('p3', 'allow-once');

    // A later read does not ask again; a later write does.
    driver.play('id-1', { type: 'permission', request: read('p4') });
    expect(driver.answers.at(-1)).toEqual({ requestId: 'p4', answer: { decision: 'allow-once' } });
    expect(run.transcript('id-1')?.pendingPermission).toBeUndefined();
    driver.play('id-1', { type: 'permission', request: write('p5') });
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p5' });
  });

  it('still asks for a covered request the runtime will not take a session approval for, or says must be asked', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request: read('p1') });
    run.respondPermission('p1', 'allow-session');
    driver.play('id-1', { type: 'permission', request: { ...read('p2'), canAllowSession: false } });
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p2' });
    run.respondPermission('p2', 'allow-once');
    driver.play('id-1', { type: 'permission', request: { ...read('p3'), mustAsk: true } });
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p3' });
  });

  it('keeps a session approval inside the session that got it', async () => {
    const run = controller();
    await run.start(START);
    const other = (await run.start(START)).sessionId;
    expect(other).not.toBe('id-1');
    driver.play('id-1', { type: 'permission', request: read('p1') });
    run.respondPermission('p1', 'allow-session');
    driver.play(other, { type: 'permission', request: read('p2') });
    expect(run.transcript(other)?.pendingPermission).toMatchObject({ requestId: 'p2' });
  });
});

describe('Allow all', () => {
  const shell = (requestId: string, over: Partial<DriverPermission> = {}): DriverPermission => ({
    requestId,
    kind: 'shell',
    commandText: 'npm test',
    canAllowSession: false,
    mustAsk: false,
    ...over,
  });
  const notices = (run: RunController, sessionId: string): string[] =>
    (run.transcript(sessionId)?.items ?? []).flatMap((item) => (item.kind === 'notice' ? [item.text] : []));
  const switches = (): string[] => driver.calls.filter((call) => call.startsWith('allow-all:'));

  it('is off unless chosen, per session, and the runtime is not touched', async () => {
    const run = controller();
    const info = await run.start(START);
    expect(info.permissionMode).toBe('default');
    expect((await run.resume({ sessionId: 'abc', repository: 'r', cwd: 'c' })).permissionMode).toBe('default');
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    expect(driver.answers).toEqual([]);
    expect(switches()).toEqual([]);
  });

  it("turns on the runtime's own allow-all, then answers what was already waiting, and says so", async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    driver.play('id-1', { type: 'permission', request: shell('p2') });

    expect((await run.setPermissionMode('id-1', 'allow-all')).permissionMode).toBe('allow-all');
    expect(switches()).toEqual(['allow-all:id-1:true']);
    expect(driver.answers).toEqual([
      { requestId: 'p1', answer: { decision: 'allow-once' } },
      { requestId: 'p2', answer: { decision: 'allow-once' } },
    ]);
    expect(run.transcript('id-1')?.pendingPermission).toBeUndefined();
    expect(run.liveStates()[0].status).toBe('working');
    expect(notices(run, 'id-1')).toEqual([RUN_MODE_ALLOW_ALL_NOTE]);
    expect(run.list()[0].permissionMode).toBe('allow-all');

    // A request the runtime still raises is approved, one request at a time.
    driver.play('id-1', { type: 'permission', request: shell('p3') });
    expect(driver.answers.at(-1)).toEqual({ requestId: 'p3', answer: { decision: 'allow-once' } });
    // Choosing the mode it already has does not switch the runtime again.
    await run.setPermissionMode('id-1', 'allow-all');
    expect(switches()).toHaveLength(1);
  });

  it('stays in the asking mode when the runtime refuses, and approves nothing', async () => {
    const run = controller();
    await run.start(START);
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    driver.allowAllTaken = false;
    await expect(run.setPermissionMode('id-1', 'allow-all')).rejects.toThrow(RUN_ALLOW_ALL_REFUSED);
    expect(run.list()[0].permissionMode).toBe('default');
    expect(driver.answers).toEqual([]);
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p1' });
    expect(notices(run, 'id-1')).toEqual([]);
  });

  it('applies it before the goal is sent when a session starts in Allow all', async () => {
    const run = controller();
    const info = await run.start({ ...START, permissionMode: 'allow-all' });
    expect(info.permissionMode).toBe('allow-all');
    expect(driver.calls).toEqual(['start:C:/repo', 'allow-all:id-1:true', 'send:id-1:Fix the build']);
    expect(notices(run, 'id-1')).toEqual([RUN_MODE_ALLOW_ALL_NOTE]);
  });

  it('starts in the asking mode, and says why, when the runtime refuses at the start', async () => {
    const run = controller();
    driver.allowAllTaken = false;
    const info = await run.start({ ...START, permissionMode: 'allow-all' });
    expect(info.permissionMode).toBe('default');
    expect(notices(run, 'id-1')).toEqual([RUN_ALLOW_ALL_REFUSED]);
    // The goal still goes out: asking is the safe direction.
    expect(driver.calls.at(-1)).toBe('send:id-1:Fix the build');
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    expect(driver.answers).toEqual([]);
  });

  it('still shows a request the runtime says must be put to the user', async () => {
    const run = controller();
    await run.start({ ...START, permissionMode: 'allow-all' });
    driver.play('id-1', { type: 'permission', request: shell('p1', { mustAsk: true }) });
    expect(driver.answers).toEqual([]);
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p1' });
  });

  it('goes back to asking in the runtime too, and does not leak into another session', async () => {
    const run = controller();
    await run.start(START);
    const other = (await run.start(START)).sessionId;
    await run.setPermissionMode('id-1', 'allow-all');
    driver.play(other, { type: 'permission', request: shell('other') });
    expect(driver.answers).toEqual([]);
    expect(run.transcript(other)?.pendingPermission).toMatchObject({ requestId: 'other' });

    await run.setPermissionMode('id-1', 'default');
    expect(switches()).toEqual(['allow-all:id-1:true', 'allow-all:id-1:false']);
    expect(notices(run, 'id-1')).toEqual([RUN_MODE_ALLOW_ALL_NOTE, RUN_MODE_DEFAULT_NOTE]);
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    expect(driver.answers).toEqual([]);
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p1' });
  });

  it('does not claim to be asking again when the runtime did not go back', async () => {
    const run = controller();
    await run.start(START);
    await run.setPermissionMode('id-1', 'allow-all');
    driver.allowAllTaken = false;
    await expect(run.setPermissionMode('id-1', 'default')).rejects.toThrow(RUN_ALLOW_ALL_STUCK);
    expect(run.list()[0].permissionMode).toBe('allow-all');
  });

  it('ends when the session loses its CLI, because the mode lived there', async () => {
    const run = controller();
    await run.start(START);
    await run.setPermissionMode('id-1', 'allow-all');
    driver.play('id-1', { type: 'error', message: 'the CLI stopped', disconnected: true });
    expect(run.list()[0].permissionMode).toBe('default');
    expect(notices(run, 'id-1')).toEqual([RUN_MODE_ALLOW_ALL_NOTE, 'the CLI stopped', RUN_MODE_LOST_NOTE]);
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    expect(driver.answers).toEqual([]);

    // An ordinary session error changes nothing about the mode.
    const other = (await run.start(START)).sessionId;
    await run.setPermissionMode(other, 'allow-all');
    driver.play(other, { type: 'error', message: 'rate limited' });
    expect(run.list().find((s) => s.sessionId === other)?.permissionMode).toBe('allow-all');
  });

  it('cannot be turned on, and approves nothing, while Run is off', async () => {
    const run = controller();
    await run.start(START);
    await run.setPermissionMode('id-1', 'allow-all');
    enabled = false;
    driver.play('id-1', { type: 'permission', request: shell('p1') });
    expect(driver.answers).toEqual([]);
    expect(run.transcript('id-1')?.pendingPermission).toMatchObject({ requestId: 'p1' });

    // Going back to asking still works with Run off; turning it on does not reach the runtime.
    await run.setPermissionMode('id-1', 'default');
    const before = switches().length;
    await expect(run.setPermissionMode('id-1', 'allow-all')).rejects.toThrow('turned off');
    expect(switches()).toHaveLength(before);
    await expect(run.setPermissionMode('missing', 'default')).rejects.toThrow('not open');
  });

  it('treats anything but the exact word as the asking default', async () => {
    const run = controller();
    await run.start({ ...START, permissionMode: 'everything' as never });
    expect(run.list()[0].permissionMode).toBe('default');
    expect((await run.setPermissionMode('id-1', 'yes' as never)).permissionMode).toBe('default');
    expect(switches()).toEqual([]);
  });
});

describe('models', () => {
  it('lists them in alphabetical order by name, whatever their case', async () => {
    const models = [
      { id: 'gpt', label: 'GPT-5' },
      { id: 'auto', label: 'auto' },
      { id: 'opus', label: 'Claude Opus 5.5' },
      { id: 'sonnet', label: 'claude Sonnet 5.5' },
      { id: 'b', label: 'Same' },
      { id: 'a', label: 'Same' },
    ];
    const sorted = sortModels(models);
    expect(sorted.map((m) => m.id)).toEqual(['auto', 'opus', 'sonnet', 'gpt', 'a', 'b']);
    // The input is left as it was.
    expect(models[0].id).toBe('gpt');

    driver.models = models;
    expect((await controller().availability()).models.map((m) => m.id)).toEqual(['auto', 'opus', 'sonnet', 'gpt', 'a', 'b']);
  });
});
