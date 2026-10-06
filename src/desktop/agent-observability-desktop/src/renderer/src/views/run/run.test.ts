import { describe, expect, it } from 'vitest';
import type { RunItem, RunPermissionRequest, RunTranscript } from '../../../../shared/runTypes';
import {
  canSend,
  canStop,
  diffStatLabel,
  ALLOW_ALL_WARNING,
  PERMISSION_MODE_OPTIONS,
  busyLabel,
  isBusy,
  permissionButtons,
  permissionQueueLabel,
  permissionKindLabel,
  permissionSubject,
  runStatusLabel,
  toolRowSummary,
} from './run';
import { EMPTY_RUN_VIEW, applyRunEvent, fromTranscript } from './runReducer';

const request = (over: Partial<RunPermissionRequest> = {}): RunPermissionRequest => ({
  requestId: 'p',
  sessionId: 's',
  kind: 'shell',
  canAllowSession: true,
  ...over,
});

describe('applyRunEvent', () => {
  it('upserts items by id, so a streamed message replaces itself', () => {
    const first: RunItem = { kind: 'assistant', id: 'a:m', html: '<p>He</p>', done: false };
    const second: RunItem = { kind: 'assistant', id: 'a:m', html: '<p>Hello</p>', done: true };
    const tool: RunItem = { kind: 'tool', id: 't:1', name: 'Bash', summary: '', state: 'running' };
    let state = applyRunEvent(EMPTY_RUN_VIEW, { type: 'item', item: first });
    state = applyRunEvent(state, { type: 'item', item: tool });
    state = applyRunEvent(state, { type: 'item', item: second });
    expect(state.items).toEqual([second, tool]);
    expect(EMPTY_RUN_VIEW.items).toEqual([]);
  });

  it('sets and clears the pending permission and question only for the matching request', () => {
    let state = applyRunEvent(EMPTY_RUN_VIEW, { type: 'permission', request: request() });
    state = applyRunEvent(state, { type: 'permission-cleared', requestId: 'other' });
    expect(state.permission?.requestId).toBe('p');
    state = applyRunEvent(state, { type: 'permission-cleared', requestId: 'p' });
    expect('permission' in state).toBe(false);

    state = applyRunEvent(state, { type: 'input', request: { requestId: 'q', sessionId: 's', question: 'Which?' } });
    state = applyRunEvent(state, { type: 'input-cleared', requestId: 'q' });
    expect('input' in state).toBe(false);
  });

  it('follows status and usage, and returns the same object when the status did not change', () => {
    const working = applyRunEvent(EMPTY_RUN_VIEW, { type: 'status', status: 'working' });
    expect(working.status).toBe('working');
    expect(applyRunEvent(working, { type: 'status', status: 'working' })).toBe(working);
    expect(applyRunEvent(working, { type: 'usage', inputTokens: 1, outputTokens: 2, nanoAiu: 3 }).usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      nanoAiu: 3,
    });
  });

  it('rebuilds from a transcript after a remount', () => {
    const transcript: RunTranscript = {
      info: {
        sessionId: 's',
        repository: 'r',
        cwd: 'c',
        status: 'waiting-approval',
        startedAtMs: 1,
        lastActivityMs: 2,
        door: 'blank',
        permissionMode: 'default',
      },
      items: [{ kind: 'user', id: 'u', text: 'go', atMs: 1 }],
      pendingPermission: request(),
    };
    expect(fromTranscript(transcript)).toEqual({ status: 'waiting-approval', items: transcript.items, permission: request() });
  });
});

describe('labels', () => {
  it('names every status and knows when sending and stopping make sense', () => {
    expect(runStatusLabel('waiting-approval')).toBe('Waiting for your approval');
    expect(runStatusLabel('idle')).toBe('Waiting for you');
    expect(canSend('idle')).toBe(true);
    expect(canSend('working')).toBe(false);
    expect(canStop('waiting-approval')).toBe(true);
    expect(canStop('stopped')).toBe(false);
  });

  it('shows the exact command or file as the thing to decide on', () => {
    expect(permissionKindLabel('shell')).toBe('Run a command');
    expect(permissionKindLabel('something-new')).toBe('Do something that needs your approval');
    expect(permissionSubject(request({ commandText: 'npm test', fileName: 'x' }))).toBe('npm test');
    expect(permissionSubject(request({ kind: 'write', fileName: 'src/a.ts' }))).toBe('src/a.ts');
    expect(permissionSubject(request({ toolName: 'fetch' }))).toBe('fetch');
    expect(diffStatLabel(request({ diffStat: { added: 12, removed: 3 } }))).toBe('+12 -3');
    expect(diffStatLabel(request())).toBeUndefined();
  });

  it('offers the three answers, the narrowest first, and hides the session-wide one when it is not accepted', () => {
    expect(permissionButtons(request()).map((b) => b.decision)).toEqual(['allow-once', 'allow-session', 'deny']);
    expect(permissionButtons(request()).filter((b) => b.primary).map((b) => b.decision)).toEqual(['allow-once']);
    expect(permissionButtons(request({ canAllowSession: false })).map((b) => b.decision)).toEqual(['allow-once', 'deny']);
  });

  it('summarizes a tool row with hand-formatted durations', () => {
    const tool = (over: Partial<Extract<RunItem, { kind: 'tool' }>>) =>
      ({ kind: 'tool', id: 't', name: 'Bash', summary: '', state: 'running', ...over }) as Extract<RunItem, { kind: 'tool' }>;
    expect(toolRowSummary(tool({}))).toBe('Bash · running');
    expect(toolRowSummary(tool({ state: 'ok', durationMs: 250 }))).toBe('Bash · done in 250 ms');
    expect(toolRowSummary(tool({ state: 'failed', durationMs: 2500, summary: 'npm test' }))).toBe('Bash npm test · failed in 2.5 s');
  });
});

describe('busy', () => {
  it('shows the spinner only while the agent is doing something, never while it waits on the user', () => {
    expect((['starting', 'working'] as const).map(isBusy)).toEqual([true, true]);
    expect((['waiting-approval', 'waiting-input', 'idle', 'stopped', 'error'] as const).map(isBusy)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(busyLabel('starting')).toContain('Starting');
    expect(busyLabel('working')).toContain('working');
  });
});

describe('permission scope and queue', () => {
  it('says what a session approval covers on its button', () => {
    const label = (over: Partial<RunPermissionRequest>): string | undefined =>
      permissionButtons(request(over)).find((b) => b.decision === 'allow-session')?.label;
    expect(label({ sessionScopeLabel: 'reading files' })).toBe('Allow reading files for this session');
    expect(label({ sessionScopeLabel: 'the command git' })).toBe('Allow the command git for this session');
    expect(label({})).toBe('Allow for this session');
    // Allow once stays the highlighted answer either way.
    expect(permissionButtons(request({ sessionScopeLabel: 'reading files' })).filter((b) => b.primary)).toHaveLength(1);
  });

  it('says how many requests wait behind the one shown', () => {
    expect(permissionQueueLabel(request())).toBeUndefined();
    expect(permissionQueueLabel(request({ more: 0 }))).toBeUndefined();
    expect(permissionQueueLabel(request({ more: 1 }))).toBe('1 more request is waiting behind this one.');
    expect(permissionQueueLabel(request({ more: 3 }))).toBe('3 more requests are waiting behind this one.');
  });

  it('replaces the shown request when the next one in the queue arrives', () => {
    const first = applyRunEvent(EMPTY_RUN_VIEW, { type: 'permission', request: request({ requestId: 'p1', more: 1 }) });
    const cleared = applyRunEvent(first, { type: 'permission-cleared', requestId: 'p1' });
    expect(cleared.permission).toBeUndefined();
    const second = applyRunEvent(cleared, { type: 'permission', request: request({ requestId: 'p2' }) });
    expect(second.permission?.requestId).toBe('p2');
  });
});

describe('permission modes', () => {
  it('lists the asking default first, then Allow all, and warns in plain words', () => {
    expect(PERMISSION_MODE_OPTIONS).toEqual([
      { mode: 'default', label: 'Default permissions' },
      { mode: 'allow-all', label: 'Allow all' },
    ]);
    expect(ALLOW_ALL_WARNING).toContain('without asking');
    expect(ALLOW_ALL_WARNING).toContain('this session only');
  });
});
