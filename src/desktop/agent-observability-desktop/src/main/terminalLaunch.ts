import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "Resume in terminal": open the user's OWN terminal in a session's folder,
 * running their own `claude --resume <id>` or `copilot --resume <id>`.
 *
 * The app does not drive the agent and embeds no terminal. It also never
 * accepts a command string from the renderer: the request carries three plain
 * values, each validated here (the CLI is one of two literals, the session id
 * is a UUID, the folder is an existing absolute directory), and this module
 * builds the argv itself. Everything is spawned with `shell: false`.
 */

export type ResumeCli = 'claude' | 'copilot';

export interface ResumeRequest {
  cwd: string;
  cli: ResumeCli;
  sessionId: string;
}

export interface TerminalLaunch {
  file: string;
  args: string[];
  /** Working directory for launchers that take it from the process, not an argument. */
  cwd?: string;
}

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrow an untrusted IPC payload, or `undefined` when anything is off. */
export function validateResumeRequest(
  input: unknown,
  isDirectory: (p: string) => boolean = defaultIsDirectory,
): ResumeRequest | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined;
  }
  const { cwd, cli, sessionId } = input as Record<string, unknown>;
  if (cli !== 'claude' && cli !== 'copilot') {
    return undefined;
  }
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return undefined;
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || !path.isAbsolute(cwd) || /[\r\n\0]/.test(cwd)) {
    return undefined;
  }
  if (!isDirectory(cwd)) {
    return undefined;
  }
  return { cwd, cli, sessionId };
}

/** The command the user would type themselves; also the copy-paste fallback. */
export function resumeCommand(request: Pick<ResumeRequest, 'cli' | 'sessionId'>): string {
  return `${request.cli} --resume ${request.sessionId}`;
}

/** The launchers to try, in order, for a platform. Pure: nothing is spawned here. */
export function terminalLaunches(platform: NodeJS.Platform, request: ResumeRequest): TerminalLaunch[] {
  const { cwd, cli, sessionId } = request;
  const argv = [cli, '--resume', sessionId];
  if (platform === 'win32') {
    return [
      { file: 'wt.exe', args: ['-d', cwd, 'cmd', '/k', ...argv] },
      { file: 'cmd.exe', args: ['/c', 'start', '', '/D', cwd, 'cmd', '/k', ...argv] },
    ];
  }
  if (platform === 'darwin') {
    const shellLine = `cd ${shellQuote(cwd)} && ${resumeCommand(request)}`;
    return [
      {
        file: 'osascript',
        args: [
          '-e',
          `tell application "Terminal" to do script "${appleScriptEscape(shellLine)}"`,
          '-e',
          'tell application "Terminal" to activate',
        ],
      },
    ];
  }
  return [
    { file: 'x-terminal-emulator', args: ['-e', ...argv], cwd },
    { file: 'gnome-terminal', args: ['--working-directory', cwd, '--', ...argv] },
    { file: 'konsole', args: ['--workdir', cwd, '-e', ...argv] },
  ];
}

/** POSIX single-quoting: safe for any path, including ones with quotes and spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escape for the inside of an AppleScript double-quoted string. */
export function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface OpenTerminalResult {
  ok: boolean;
  /** The command to paste into a terminal when none could be opened. */
  fallbackCommand?: string;
}

export interface OpenTerminalSeams {
  platform?: NodeJS.Platform;
  isDirectory?: (p: string) => boolean;
  /** Resolves true when the launcher started, false when it could not be spawned. */
  launch?: (launch: TerminalLaunch) => Promise<boolean>;
}

/** Validate, then try each launcher until one starts. */
export async function openTerminal(input: unknown, seams: OpenTerminalSeams = {}): Promise<OpenTerminalResult> {
  const request = validateResumeRequest(input, seams.isDirectory);
  if (request === undefined) {
    return { ok: false };
  }
  const launch = seams.launch ?? spawnDetached;
  for (const candidate of terminalLaunches(seams.platform ?? process.platform, request)) {
    if (await launch(candidate)) {
      return { ok: true };
    }
  }
  return { ok: false, fallbackCommand: resumeCommand(request) };
}

function spawnDetached(launch: TerminalLaunch): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(launch.file, launch.args, {
        ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
        detached: true,
        shell: false,
        stdio: 'ignore',
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function defaultIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
