import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunSessionInfo } from '../../shared/rpc';
import { applyHosted } from '../live/liveBoard';
import type { LiveSessionRow } from '../../shared/rpc';
import { PREFILL_MAX_CHARS } from './runPrefill';
import { RUN_REFUSAL_NOTICE, RUN_REFUSAL_OFF, RunService, type RunServiceDeps } from './runService';

/**
 * The RPC face of Run against a fake controller. What matters most is what it
 * refuses: anything while Run is off or unacknowledged, and any directory the
 * renderer did not get from the verified list.
 */

const REPO = 'https://github.com/o/repo';
const CLI_ID = '11111111-2222-4333-8444-555555555555';

function info(over: Partial<RunSessionInfo> = {}): RunSessionInfo {
  return {
    sessionId: CLI_ID,
    repository: REPO,
    cwd: path.join('work', 'repo'),
    status: 'working',
    startedAtMs: 1,
    lastActivityMs: 2,
    door: 'blank',
    permissionMode: 'default',
    ...over,
  };
}

function service(over: Partial<RunServiceDeps> = {}, state = { enabled: true, acknowledged: true }) {
  const calls: string[] = [];
  const started: unknown[] = [];
  const deps: RunServiceDeps = {
    controller: {
      availability: async () => ({ enabled: state.enabled, acknowledged: state.acknowledged, cliFound: true, models: [] }),
      start: async (params) => {
        calls.push('start');
        started.push(params);
        return info({ cwd: params.cwd });
      },
      resume: async (params) => {
        calls.push('resume');
        started.push(params);
        return info({ cwd: params.cwd });
      },
      send: async () => void calls.push('send'),
      abort: async () => void calls.push('abort'),
      close: async () => void calls.push('close'),
      respondPermission: (_id, decision) => void calls.push(`permission:${decision}`),
      setPermissionMode: async (_id, mode) => {
        calls.push(`mode:${mode}`);
        return info({ permissionMode: mode });
      },
      respondInput: (_id, answer) => void calls.push(`input:${answer ?? 'skip'}`),
      list: () => [info()],
      transcript: () => undefined,
    },
    enabled: () => state.enabled,
    acknowledged: () => state.acknowledged,
    acknowledge: () => {
      state.acknowledged = true;
    },
    defaultModel: () => '',
    repositories: () => [REPO, 'unknown', 'https://github.com/o/gone'],
    resolveRoot: (repository) => (repository === REPO ? path.join('work', 'repo') : undefined),
    cliSessions: () => [{ sessionId: CLI_ID, repository: 'https://github.com/o/cli-only' }],
    cliCwd: (sessionId) => (sessionId === CLI_ID ? path.join('work', 'cli') : undefined),
    isHidden: (_source, sessionId) => sessionId === 'hidden',
    repositoryOf: () => REPO,
    digestMarkdown: () => '# What agents learned\n\n- friction',
    plan: (planId) =>
      planId === 'p1' ? { repository: REPO, summary: 'Tighten AGENTS.md', edits: [{ path: 'AGENTS.md', action: 'replace' }] } : undefined,
    retro: () => ({ goal: 'Fix the build', tips: ['State the end state.'], findings: ['Tools failed in a row.'] }),
    handoffMarkdown: () => '# Hand-off\n\nContinue the work.',
    ...over,
  };
  return { run: new RunService(deps), calls, started, state };
}

describe('RunService gates', () => {
  it('refuses every action while Run is off, and while the notice is unread', async () => {
    for (const state of [
      { enabled: false, acknowledged: true },
      { enabled: true, acknowledged: false },
    ]) {
      const { run, calls } = service({}, state);
      const refusal = state.enabled ? RUN_REFUSAL_NOTICE : RUN_REFUSAL_OFF;
      expect(() => run.repositories()).toThrow(refusal);
      expect(() => run.start({ goal: 'do it', repository: REPO, door: 'blank' })).toThrow(refusal);
      expect(() => run.resume(CLI_ID)).toThrow(refusal);
      expect(() => run.send(CLI_ID, 'more')).toThrow(refusal);
      expect(() => run.respondPermission('r1', 'allow-once')).toThrow(refusal);
      expect(() => run.respondPermission('r1', 'allow-session')).toThrow(refusal);
      expect(() => run.setPermissionMode(CLI_ID, 'allow-all')).toThrow(refusal);
      expect(() => run.respondInput('r1', 'yes')).toThrow(refusal);
      expect(() => run.prefill({ door: 'repo-digest', repository: REPO })).toThrow(refusal);
      expect(calls).toEqual([]);
    }
  });

  it('always lets the user stop, close, deny and skip', async () => {
    const { run, calls } = service({}, { enabled: false, acknowledged: false });
    await run.abort(CLI_ID);
    await run.close(CLI_ID);
    run.respondPermission('r1', 'deny', 'no');
    run.respondInput('r1', undefined);
    // Going back to asking is the safe direction, so it is never refused.
    await run.setPermissionMode(CLI_ID, 'default');
    expect(calls).toEqual(['abort', 'close', 'permission:deny', 'input:skip', 'mode:default']);
    expect(run.list()).toEqual([]);
  });

  it('records the acknowledgement only while Run is on', async () => {
    const off = service({}, { enabled: false, acknowledged: false });
    expect(() => off.run.acknowledge()).toThrow(RUN_REFUSAL_OFF);
    expect(off.state.acknowledged).toBe(false);
    const on = service({}, { enabled: true, acknowledged: false });
    await on.run.acknowledge();
    expect(on.state.acknowledged).toBe(true);
  });
});

describe('RunService directories', () => {
  it('lists only checkouts it could verify, never unknown', () => {
    const { run } = service();
    expect(run.repositories()).toEqual([
      { repository: REPO, cwd: path.join('work', 'repo') },
      { repository: 'https://github.com/o/cli-only', cwd: path.join('work', 'cli') },
    ]);
  });

  it('starts in the directory it resolved itself and rejects a repository it cannot verify', async () => {
    const { run, started } = service();
    await run.start({ goal: '  do it  ', repository: REPO, door: 'blank' });
    expect(started[0]).toMatchObject({
      goal: 'do it',
      repository: REPO,
      cwd: path.join('work', 'repo'),
      permissionMode: 'default',
    });
    // Allow all is passed on only for the exact word.
    await run.start({ goal: 'do it', repository: REPO, door: 'blank', permissionMode: 'allow-all' });
    expect(started[1]).toMatchObject({ permissionMode: 'allow-all' });
    await run.start({ goal: 'do it', repository: REPO, door: 'blank', permissionMode: 'ALL' as never });
    expect(started[2]).toMatchObject({ permissionMode: 'default' });
    expect((await run.setPermissionMode(CLI_ID, 'allow-all')).permissionMode).toBe('allow-all');
    expect((await run.setPermissionMode(CLI_ID, 'whatever' as never)).permissionMode).toBe('default');
    expect(() => run.start({ goal: 'do it', repository: 'https://github.com/o/gone', door: 'blank' })).toThrow('could be verified');
    expect(() => run.start({ goal: 'do it', repository: 'unknown', door: 'blank' })).toThrow('could be verified');
    expect(() => run.start({ goal: '   ', repository: REPO, door: 'blank' })).toThrow('Write what');
  });

  it('resumes only a session whose own record names a directory that still exists', async () => {
    const { run, started } = service();
    await run.resume(CLI_ID);
    expect(started[0]).toMatchObject({ sessionId: CLI_ID, cwd: path.join('work', 'cli') });
    expect(() => run.resume('99999999-2222-4333-8444-555555555555')).toThrow('no longer there');
    expect(() => run.resume('../../etc')).toThrow('can continue');
  });

  it('drops a model id that is not a plain identifier', async () => {
    const { run, started } = service();
    await run.start({ goal: 'x', repository: REPO, door: 'blank', model: 'gpt-5; rm -rf' });
    expect((started[0] as { model?: string }).model).toBeUndefined();
  });
});

describe('RunService prefill', () => {
  it('builds each door from local data and carries the repository', () => {
    const { run } = service();
    expect(run.prefill({ door: 'repo-digest', repository: REPO })).toMatchObject({ door: 'repo-digest', repository: REPO });
    expect(run.prefill({ door: 'repo-digest', repository: REPO }).goal).toContain('What agents learned');
    expect(run.prefill({ door: 'improve-plan', planId: 'p1' }).goal).toContain('AGENTS.md');
    expect(run.prefill({ door: 'retro-advice', source: 'claude', sessionId: 's' }).goal).toContain('State the end state.');
    expect(run.prefill({ door: 'handoff-brief', source: 'claude', sessionId: 's' }).goal).toContain('Continue the work.');
    expect(run.prefill({ door: 'continue-session', source: 'copilot-cli', sessionId: CLI_ID })).toMatchObject({
      door: 'continue-session',
      resumeSessionId: CLI_ID,
    });
  });

  it('gives a hidden session no content, and an unknown plan or a Claude continue nothing', () => {
    const { run } = service();
    for (const door of ['retro-advice', 'handoff-brief'] as const) {
      const prefill = run.prefill({ door, source: 'claude', sessionId: 'hidden' });
      expect(prefill.goal).not.toContain('State the end state.');
      expect(prefill.goal).not.toContain('Continue the work.');
    }
    expect(run.prefill({ door: 'improve-plan', planId: 'nope' }).door).toBe('blank');
    expect(run.prefill({ door: 'continue-session', source: 'claude', sessionId: 's' }).resumeSessionId).toBeUndefined();
  });

  it('caps what a door can put in the goal box', () => {
    const { run } = service({ digestMarkdown: () => 'x'.repeat(PREFILL_MAX_CHARS * 3) });
    expect(run.prefill({ door: 'repo-digest', repository: REPO }).goal.length).toBeLessThanOrEqual(PREFILL_MAX_CHARS + 400);
  });

  it('falls back to the retrospective when no brief can be built', () => {
    const { run } = service({ handoffMarkdown: () => undefined });
    expect(run.prefill({ door: 'handoff-brief', source: 'claude', sessionId: 's' }).goal).toContain('State the end state.');
  });
});

describe('applyHosted', () => {
  const row = (over: Partial<LiveSessionRow> = {}): LiveSessionRow => ({
    source: 'copilot-cli',
    sessionId: CLI_ID,
    repository: REPO,
    status: 'working',
    lastEvent: 'unknown',
    startedAtMs: 1,
    lastActivityMs: 10,
    pendingTools: [],
    inputTokens: 0,
    outputTokens: 0,
    countsIndexedAtMs: 0,
    ...over,
  });

  it('gives a hosted session its exact status, and an approval wait the exact-permission flag', () => {
    const rows = [row(), row({ source: 'claude' })];
    applyHosted(rows, [{ sessionId: CLI_ID, status: 'waiting-approval', waitingFor: 'approval', lastActivityMs: 50, pendingTools: ['create'] }]);
    expect(rows[0]).toMatchObject({ hosted: true, status: 'waiting', exactPermission: true, lastActivityMs: 50, pendingTools: ['create'] });
    expect(rows[1].hosted).toBeUndefined();

    applyHosted(rows, [{ sessionId: CLI_ID, status: 'idle', lastActivityMs: 60, pendingTools: [] }]);
    expect(rows[0]).toMatchObject({ status: 'waiting', lastEvent: 'turn-ended' });
    expect(rows[0].exactPermission).toBeUndefined();

    applyHosted(rows, [{ sessionId: CLI_ID, status: 'working', lastActivityMs: 70, pendingTools: [] }]);
    expect(rows[0].status).toBe('working');
  });

  it('leaves the disk-derived status alone once the hosted session stopped, and invents no row', () => {
    const rows = [row({ status: 'finished' })];
    applyHosted(rows, [
      { sessionId: CLI_ID, status: 'stopped', lastActivityMs: 99, pendingTools: [] },
      { sessionId: 'not-on-disk-yet', status: 'working', lastActivityMs: 99, pendingTools: [] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'finished', hosted: true });
  });
});

describe('the run host stays off the sharing paths', () => {
  it('imports nothing from aggregate, sync or team', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) {
        continue;
      }
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const line of text.split('\n')) {
        if (/^\s*import\b/.test(line) && /['"][^'"]*\/(aggregate|sync|team)\//.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
