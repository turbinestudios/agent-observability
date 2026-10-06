import { describe, expect, it } from 'vitest';
import { scopeCovers, scopeLabel, scopeOf, type SessionScope } from './permissionScope';

describe('scopeOf', () => {
  it('names what a session approval of each kind of request covers', () => {
    expect(scopeOf({ kind: 'read', path: 'a.ts' })).toEqual({ kind: 'read' });
    expect(scopeOf({ kind: 'write', fileName: 'a.ts' })).toEqual({ kind: 'write' });
    expect(scopeOf({ kind: 'memory', fact: 'x' })).toEqual({ kind: 'memory' });
    expect(
      scopeOf({
        kind: 'shell',
        fullCommandText: 'git status && git diff && npm test',
        commands: [
          { identifier: 'git', readOnly: true },
          { identifier: 'git', readOnly: true },
          { identifier: 'npm', readOnly: false },
        ],
      }),
    ).toEqual({ kind: 'commands', commandIdentifiers: ['git', 'npm'] });
    expect(scopeOf({ kind: 'mcp', serverName: 'github', toolName: 'search' })).toEqual({
      kind: 'mcp',
      serverName: 'github',
      toolName: 'search',
    });
    expect(scopeOf({ kind: 'custom-tool', toolName: 'lint' })).toEqual({ kind: 'custom-tool', toolName: 'lint' });
    expect(scopeOf({ kind: 'url', url: 'https://docs.example.com/a/b?c=d' })).toEqual({ kind: 'url', domain: 'docs.example.com' });
  });

  it('has no scope for what cannot be remembered by name', () => {
    // A command line the runtime could not name, in whole or in part.
    expect(scopeOf({ kind: 'shell', fullCommandText: 'x', commands: [] })).toBeUndefined();
    expect(scopeOf({ kind: 'shell', commands: [{ identifier: 'git' }, { readOnly: true }] })).toBeUndefined();
    expect(scopeOf({ kind: 'shell' })).toBeUndefined();
    expect(scopeOf({ kind: 'mcp', serverName: 'github' })).toBeUndefined();
    expect(scopeOf({ kind: 'url', url: 'not a url' })).toBeUndefined();
    expect(scopeOf({ kind: 'hook' })).toBeUndefined();
    expect(scopeOf({ kind: 'something-new' })).toBeUndefined();
    expect(scopeOf({})).toBeUndefined();
  });
});

describe('scopeCovers', () => {
  const git: SessionScope = { kind: 'commands', commandIdentifiers: ['git', 'npm'] };

  it('covers the same kind of action and nothing wider', () => {
    expect(scopeCovers({ kind: 'read' }, { kind: 'read' })).toBe(true);
    expect(scopeCovers({ kind: 'read' }, { kind: 'write' })).toBe(false);
    expect(scopeCovers({ kind: 'write' }, { kind: 'read' })).toBe(false);
    expect(scopeCovers({ kind: 'write' }, git)).toBe(false);
  });

  it('covers a command line only when every command in it was approved', () => {
    expect(scopeCovers(git, { kind: 'commands', commandIdentifiers: ['git'] })).toBe(true);
    expect(scopeCovers(git, { kind: 'commands', commandIdentifiers: ['npm', 'git'] })).toBe(true);
    expect(scopeCovers(git, { kind: 'commands', commandIdentifiers: ['git', 'rm'] })).toBe(false);
    expect(scopeCovers({ kind: 'commands', commandIdentifiers: ['git'] }, git)).toBe(false);
  });

  it('keeps tools and web domains apart by name', () => {
    const tool: SessionScope = { kind: 'mcp', serverName: 'github', toolName: 'search' };
    expect(scopeCovers(tool, { kind: 'mcp', serverName: 'github', toolName: 'search' })).toBe(true);
    expect(scopeCovers(tool, { kind: 'mcp', serverName: 'github', toolName: 'delete' })).toBe(false);
    expect(scopeCovers(tool, { kind: 'mcp', serverName: 'other', toolName: 'search' })).toBe(false);
    expect(scopeCovers({ kind: 'custom-tool', toolName: 'lint' }, { kind: 'custom-tool', toolName: 'lint' })).toBe(true);
    expect(scopeCovers({ kind: 'custom-tool', toolName: 'lint' }, { kind: 'custom-tool', toolName: 'deploy' })).toBe(false);
    expect(scopeCovers({ kind: 'url', domain: 'a.example' }, { kind: 'url', domain: 'a.example' })).toBe(true);
    expect(scopeCovers({ kind: 'url', domain: 'a.example' }, { kind: 'url', domain: 'b.example' })).toBe(false);
  });
});

describe('scopeLabel', () => {
  it('finishes the sentence "Allow … for this session"', () => {
    expect(scopeLabel({ kind: 'read' })).toBe('reading files');
    expect(scopeLabel({ kind: 'write' })).toBe('changing files');
    expect(scopeLabel({ kind: 'commands', commandIdentifiers: ['git'] })).toBe('the command git');
    expect(scopeLabel({ kind: 'commands', commandIdentifiers: ['git', 'npm'] })).toBe('the commands git, npm');
    expect(scopeLabel({ kind: 'mcp', serverName: 'github', toolName: 'search' })).toBe('the tool search from github');
    expect(scopeLabel({ kind: 'url', domain: 'example.com' })).toBe('web addresses on example.com');
  });
});
