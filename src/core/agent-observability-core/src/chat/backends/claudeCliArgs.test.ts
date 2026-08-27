import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs,
  claudeCommandCandidates,
  parseClaudeEffort,
  sanitizeClaudeEnv,
  serializeMessagesForCli,
  CLAUDE_MODEL_CHOICES,
  DEFAULT_CLAUDE_EFFORT,
} from './claudeCliArgs';

describe('buildClaudeArgs', () => {
  it('builds the exact argv, including the empty --tools element', () => {
    expect(buildClaudeArgs('sonnet', 'high')).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', 'sonnet',
      '--effort', 'high',
      '--tools', '',
      '--max-turns', '1',
      '--no-session-persistence',
    ]);
  });

  it('passes custom model ids and every effort level through verbatim', () => {
    const args = buildClaudeArgs('claude-sonnet-5', 'xhigh');
    expect(args).toContain('claude-sonnet-5');
    expect(args).toContain('xhigh');
  });
});

describe('serializeMessagesForCli', () => {
  it('renders a single turn as preamble + user section', () => {
    const out = serializeMessagesForCli([
      { role: 'user', text: 'PREAMBLE' },
      { role: 'user', text: 'hello' },
    ]);
    expect(out).toBe('PREAMBLE\n\n# Conversation\n\n## User\nhello');
  });

  it('renders multi-turn history in order with role tags', () => {
    const out = serializeMessagesForCli([
      { role: 'user', text: 'PREAMBLE' },
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' },
    ]);
    expect(out.indexOf('## User\nq1')).toBeGreaterThan(-1);
    expect(out.indexOf('## Assistant\na1')).toBeGreaterThan(out.indexOf('## User\nq1'));
    expect(out.indexOf('## User\nq2')).toBeGreaterThan(out.indexOf('## Assistant\na1'));
  });

  it('returns the bare preamble when there is no history and empty for no messages', () => {
    expect(serializeMessagesForCli([{ role: 'user', text: 'P' }])).toBe('P');
    expect(serializeMessagesForCli([])).toBe('');
  });
});

describe('claudeCommandCandidates', () => {
  it('adds a .cmd fallback on Windows for extension-less commands', () => {
    expect(claudeCommandCandidates('claude', 'win32')).toEqual(['claude', 'claude.cmd']);
  });

  it('uses an explicit .exe/.cmd path as-is on Windows', () => {
    expect(claudeCommandCandidates('C:\\tools\\claude.exe', 'win32')).toEqual(['C:\\tools\\claude.exe']);
    expect(claudeCommandCandidates('C:\\tools\\claude.CMD', 'win32')).toEqual(['C:\\tools\\claude.CMD']);
  });

  it('never appends .cmd off Windows and defaults blank to claude', () => {
    expect(claudeCommandCandidates('claude', 'linux')).toEqual(['claude']);
    expect(claudeCommandCandidates('   ', 'darwin')).toEqual(['claude']);
  });
});

describe('sanitizeClaudeEnv', () => {
  it('drops CLAUDECODE and keeps everything else, without mutating the input', () => {
    const env = { CLAUDECODE: '1', PATH: '/bin' };
    const out = sanitizeClaudeEnv(env);
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.PATH).toBe('/bin');
    expect(env.CLAUDECODE).toBe('1');
  });
});

describe('parseClaudeEffort', () => {
  it('accepts every documented level, case- and whitespace-insensitively', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(parseClaudeEffort(level)).toBe(level);
    }
    expect(parseClaudeEffort(' XHigh ')).toBe('xhigh');
  });

  it('falls back to the default for invalid values', () => {
    expect(parseClaudeEffort('turbo')).toBe(DEFAULT_CLAUDE_EFFORT);
    expect(parseClaudeEffort(undefined)).toBe(DEFAULT_CLAUDE_EFFORT);
    expect(parseClaudeEffort(42)).toBe(DEFAULT_CLAUDE_EFFORT);
  });
});

describe('CLAUDE_MODEL_CHOICES', () => {
  it('offers the CLI aliases', () => {
    expect(CLAUDE_MODEL_CHOICES.map((c) => c.id)).toEqual(['sonnet', 'opus', 'haiku', 'fable']);
  });
});
