import { describe, it, expect } from 'vitest';
import {
  COPILOT_ARGV_PROMPT_LIMIT,
  buildCopilotArgs,
  buildCopilotPayloadArgs,
  copilotCommandCandidates,
  copilotPayloadPointer,
  sanitizeCopilotEnv,
} from './copilotCliArgs';

describe('buildCopilotArgs', () => {
  it('runs a tool-less non-interactive prompt with the hygiene flags', () => {
    const args = buildCopilotArgs('auto', 'hello');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('hello');
    expect(args).toContain('--available-tools=');
    for (const flag of [
      '--no-custom-instructions',
      '--no-remote',
      '--no-remote-export',
      '--no-ask-user',
      '--disable-builtin-mcps',
      '--no-auto-update',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args.join(' ')).toContain('--output-format json');
    expect(args.join(' ')).toContain('--stream on');
    expect(args.join(' ')).toContain('--model auto');
    // Tool-less mode must never widen permissions.
    expect(args).not.toContain('--allow-all-tools');
  });
});

describe('buildCopilotPayloadArgs', () => {
  it('grants exactly the view tool over exactly the payload directory', () => {
    const args = buildCopilotPayloadArgs('auto', '/tmp/ao/prompt.md', '/tmp/ao');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(copilotPayloadPointer('/tmp/ao/prompt.md'));
    expect(args).toContain('--available-tools=view');
    const addDir = args.indexOf('--add-dir');
    expect(args[addDir + 1]).toBe('/tmp/ao');
    const allow = args.indexOf('--allow-tool');
    expect(args[allow + 1]).toBe('view');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('keeps a sane argv threshold well under the Windows command-line cap', () => {
    expect(COPILOT_ARGV_PROMPT_LIMIT).toBeLessThan(32_000);
  });
});

describe('copilotCommandCandidates', () => {
  it('retries with the npm .cmd shim on Windows, but not elsewhere', () => {
    expect(copilotCommandCandidates('', 'win32')).toEqual(['copilot', 'copilot.cmd']);
    expect(copilotCommandCandidates('', 'linux')).toEqual(['copilot']);
    expect(copilotCommandCandidates('', 'darwin')).toEqual(['copilot']);
  });

  it('uses a configured path as-is when it already carries an extension', () => {
    expect(copilotCommandCandidates('C:\\tools\\copilot.cmd', 'win32')).toEqual([
      'C:\\tools\\copilot.cmd',
    ]);
    expect(copilotCommandCandidates(' C:\\tools\\copilot ', 'win32')).toEqual([
      'C:\\tools\\copilot',
      'C:\\tools\\copilot.cmd',
    ]);
  });
});

describe('sanitizeCopilotEnv', () => {
  it('strips the permission-widening variables and nothing else', () => {
    const env = sanitizeCopilotEnv({
      PATH: '/bin',
      COPILOT_ALLOW_ALL: '1',
      COPILOT_ASSISTED_APPROVAL: '1',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(env.COPILOT_ASSISTED_APPROVAL).toBeUndefined();
  });
});
