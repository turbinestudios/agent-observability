import { describe, it, expect } from 'vitest';
import { buildCmdShimLine, needsCmdShim } from './cliShim';

describe('needsCmdShim', () => {
  it('wraps .cmd and .bat on Windows only', () => {
    expect(needsCmdShim('copilot.cmd', 'win32')).toBe(true);
    expect(needsCmdShim('C:\\tools\\claude.CMD', 'win32')).toBe(true);
    expect(needsCmdShim('run.bat', 'win32')).toBe(true);
    expect(needsCmdShim('copilot.exe', 'win32')).toBe(false);
    expect(needsCmdShim('copilot', 'win32')).toBe(false);
    expect(needsCmdShim('copilot.cmd', 'linux')).toBe(false);
    expect(needsCmdShim('copilot.cmd', 'darwin')).toBe(false);
  });
});

describe('buildCmdShimLine', () => {
  it('quotes every token, spaces included', () => {
    expect(buildCmdShimLine('C:\\a dir\\copilot.cmd', ['-p', 'two words', '--flag'])).toBe(
      '"C:\\a dir\\copilot.cmd" "-p" "two words" "--flag"',
    );
  });

  it('quotes an empty token rather than dropping it', () => {
    expect(buildCmdShimLine('claude.cmd', ['--tools', ''])).toBe('"claude.cmd" "--tools" ""');
  });

  it('refuses tokens cmd.exe could reinterpret even inside quotes', () => {
    expect(() => buildCmdShimLine('x.cmd', ['%PATH%'])).toThrow(/stdin or a payload file/);
    expect(() => buildCmdShimLine('x.cmd', ['say "hi"'])).toThrow();
    expect(() => buildCmdShimLine('x.cmd', ['line\nbreak'])).toThrow();
  });
});
