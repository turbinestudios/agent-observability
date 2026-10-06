import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  openTerminal,
  resumeCommand,
  shellQuote,
  terminalLaunches,
  validateResumeRequest,
  type TerminalLaunch,
} from './terminalLaunch';

/**
 * The launch plan is pure, so every platform is tested on whichever machine
 * runs the suite; nothing is spawned.
 */

const ID = '3f2a9c1e-7b4d-4e8a-9c6f-0a1b2c3d4e5f';
const CWD = path.resolve(path.sep, 'work', "my repo's \"copy\"");
const yes = (): boolean => true;

describe('validateResumeRequest', () => {
  it('accepts exactly the two CLIs, a UUID and an existing absolute folder', () => {
    expect(validateResumeRequest({ cwd: CWD, cli: 'claude', sessionId: ID }, yes)).toEqual({
      cwd: CWD,
      cli: 'claude',
      sessionId: ID,
    });
    expect(validateResumeRequest({ cwd: CWD, cli: 'copilot', sessionId: ID }, yes)?.cli).toBe('copilot');
  });

  it('rejects anything else', () => {
    expect(validateResumeRequest(null, yes)).toBeUndefined();
    expect(validateResumeRequest({ cwd: CWD, cli: 'bash', sessionId: ID }, yes)).toBeUndefined();
    expect(validateResumeRequest({ cwd: CWD, cli: 'claude', sessionId: `${ID}; rm -rf /` }, yes)).toBeUndefined();
    expect(validateResumeRequest({ cwd: CWD, cli: 'claude', sessionId: 'not-a-uuid' }, yes)).toBeUndefined();
    expect(validateResumeRequest({ cwd: 'relative/dir', cli: 'claude', sessionId: ID }, yes)).toBeUndefined();
    expect(validateResumeRequest({ cwd: `${CWD}\nwhoami`, cli: 'claude', sessionId: ID }, yes)).toBeUndefined();
    expect(validateResumeRequest({ cwd: CWD, cli: 'claude', sessionId: ID }, () => false)).toBeUndefined();
    expect(validateResumeRequest({ cwd: CWD, cli: 'claude', sessionId: ID, command: 'evil' }, yes)).toEqual({
      cwd: CWD,
      cli: 'claude',
      sessionId: ID,
    });
  });
});

describe('terminalLaunches', () => {
  const request = { cwd: CWD, cli: 'claude' as const, sessionId: ID };

  it('tries Windows Terminal, then cmd, with the folder as its own argument', () => {
    const [wt, cmd] = terminalLaunches('win32', request);
    expect(wt).toEqual({ file: 'wt.exe', args: ['-d', CWD, 'cmd', '/k', 'claude', '--resume', ID] });
    expect(cmd.file).toBe('cmd.exe');
    expect(cmd.args).toEqual(['/c', 'start', '', '/D', CWD, 'cmd', '/k', 'claude', '--resume', ID]);
  });

  it('asks Terminal on macOS with the folder quoted for the shell and for AppleScript', () => {
    const [launch] = terminalLaunches('darwin', request);
    expect(launch.file).toBe('osascript');
    expect(launch.args[1]).toContain(`claude --resume ${ID}`);
    // The single quote in the folder name is closed, escaped and reopened.
    expect(launch.args[1]).toContain(`'\\\\''`);
    // Double quotes inside the folder name cannot end the AppleScript string.
    expect(launch.args[1]).toContain('\\"copy\\"');
    expect(launch.args[3]).toBe('tell application "Terminal" to activate');
  });

  it('tries the common Linux terminals in order', () => {
    const launches = terminalLaunches('linux', { ...request, cli: 'copilot' });
    expect(launches.map((l) => l.file)).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole']);
    expect(launches[0]).toEqual({ file: 'x-terminal-emulator', args: ['-e', 'copilot', '--resume', ID], cwd: CWD });
    expect(launches[1].args).toEqual(['--working-directory', CWD, '--', 'copilot', '--resume', ID]);
  });

  it('quotes for a POSIX shell', () => {
    expect(shellQuote("a b'c")).toBe(`'a b'\\''c'`);
    expect(resumeCommand(request)).toBe(`claude --resume ${ID}`);
  });
});

describe('openTerminal', () => {
  it('stops at the first launcher that starts', async () => {
    const tried: TerminalLaunch[] = [];
    const result = await openTerminal(
      { cwd: CWD, cli: 'claude', sessionId: ID },
      {
        platform: 'win32',
        isDirectory: yes,
        launch: async (launch) => {
          tried.push(launch);
          return launch.file === 'cmd.exe';
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(tried.map((t) => t.file)).toEqual(['wt.exe', 'cmd.exe']);
  });

  it('hands back the command to paste when nothing could be opened', async () => {
    const result = await openTerminal(
      { cwd: CWD, cli: 'copilot', sessionId: ID },
      { platform: 'linux', isDirectory: yes, launch: async () => false },
    );
    expect(result).toEqual({ ok: false, fallbackCommand: `copilot --resume ${ID}` });
  });

  it('launches nothing for an invalid request', async () => {
    let launched = 0;
    const result = await openTerminal(
      { cwd: CWD, cli: 'claude', sessionId: 'x' },
      { platform: 'win32', isDirectory: yes, launch: async () => ((launched += 1), true) },
    );
    expect(result).toEqual({ ok: false });
    expect(launched).toBe(0);
  });
});
