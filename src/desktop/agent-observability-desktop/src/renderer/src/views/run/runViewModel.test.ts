import { describe, expect, it } from 'vitest';
import type { RunAvailability, RunSessionInfo } from '../../../../shared/runTypes';
import {
  RUN_START_REMINDER,
  availabilityProblem,
  canStart,
  runGate,
  runVisible,
  sessionDoor,
  sortRunSessions,
  startReminder,
} from './runViewModel';

const ready: RunAvailability = { enabled: true, acknowledged: true, cliFound: true, signedIn: true, models: [] };

describe('Run visibility and doors', () => {
  it('shows the rail entry and doors only while Run is on', () => {
    expect(runVisible(true)).toBe(true);
    expect(runVisible(false)).toBe(false);
    expect(runVisible(undefined)).toBe(false);
  });

  it('offers "continue" only for Copilot CLI sessions', () => {
    expect(sessionDoor('copilot-cli', true)).toBe('continue-session');
    expect(sessionDoor('claude', true)).toBeUndefined();
    expect(sessionDoor('copilot-cli', false)).toBeUndefined();
  });
});

describe('runGate', () => {
  it('puts the notice first, then setup problems', () => {
    expect(runGate(undefined)).toBeUndefined();
    expect(runGate({ ...ready, acknowledged: false })).toBe('notice');
    expect(runGate({ ...ready, cliFound: false })).toBe('problem');
    expect(runGate({ ...ready, signedIn: false })).toBe('problem');
    expect(runGate(ready)).toBe('ready');
  });

  it('says what is wrong and how to fix it', () => {
    expect(availabilityProblem(ready)).toBeUndefined();
    expect(availabilityProblem({ ...ready, cliFound: false })).toContain('not found');
    expect(availabilityProblem({ ...ready, signedIn: false })).toContain('not signed in');
    expect(availabilityProblem({ ...ready, problem: 'Too old.' })).toBe('Too old.');
  });
});

describe('canStart and ordering', () => {
  it('needs a goal and a repository, and nothing in flight', () => {
    expect(canStart('do it', 'r', false)).toBe(true);
    expect(canStart('   ', 'r', false)).toBe(false);
    expect(canStart('do it', '', false)).toBe(false);
    expect(canStart('do it', 'r', true)).toBe(false);
  });

  it('lists running sessions before stopped ones, newest first', () => {
    const s = (sessionId: string, status: RunSessionInfo['status'], lastActivityMs: number): RunSessionInfo => ({
      sessionId,
      repository: 'r',
      cwd: 'c',
      status,
      permissionMode: 'default',
      startedAtMs: 0,
      lastActivityMs,
      door: 'blank',
    });
    expect(
      sortRunSessions([s('old-stopped', 'stopped', 9), s('idle', 'idle', 1), s('working', 'working', 5)]).map((x) => x.sessionId),
    ).toEqual(['working', 'idle', 'old-stopped']);
  });
});

describe('startReminder', () => {
  it('says the truth for the mode the session starts in', () => {
    expect(startReminder('default')).toBe(RUN_START_REMINDER);
    expect(startReminder('default')).toContain('asks first');
    expect(startReminder('allow-all')).toContain('Allow all is on');
    expect(startReminder('allow-all')).not.toContain('asks first');
  });
});
