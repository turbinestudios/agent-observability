import { describe, it, expect } from 'vitest';
import { GitRemoteIo, GitRemoteResolver, parseGitConfigRemote } from './gitRemote';

describe('parseGitConfigRemote', () => {
  it('prefers the origin remote', () => {
    const text = `
[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/upstream/repo.git
[remote "origin"]
\turl = https://github.com/me/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
    expect(parseGitConfigRemote(text)).toBe('https://github.com/me/repo.git');
  });

  it('falls back to the first remote when there is no origin', () => {
    const text = `[remote "fork"]\n\turl = git@github.com:me/repo.git\n`;
    expect(parseGitConfigRemote(text)).toBe('git@github.com:me/repo.git');
  });

  it('returns undefined when no remote url is declared', () => {
    expect(parseGitConfigRemote('[core]\n\tbare = false\n')).toBeUndefined();
  });

  it('ignores comments and url keys outside a remote section', () => {
    const text = `[branch "main"]\n\turl = not-a-remote\n# [remote "x"] commented\n[remote "origin"]\n\turl = https://h/o/r\n`;
    expect(parseGitConfigRemote(text)).toBe('https://h/o/r');
  });
});

// Normalize separators so the fakes match regardless of host path semantics
// (path.join/dirname emit `\` on win32, `/` elsewhere).
const norm = (p: string): string => p.replace(/\\/g, '/');

describe('GitRemoteResolver', () => {
  it('walks up to the enclosing .git directory and sanitizes the remote', () => {
    const io: GitRemoteIo = {
      statKind: (p) => (norm(p).endsWith('/repo/.git') ? 'dir' : 'absent'),
      readFile: (p) =>
        norm(p).endsWith('/repo/.git/config')
          ? '[remote "origin"]\n\turl = git@github.com:org/proj.git\n'
          : undefined,
    };
    const resolver = new GitRemoteResolver(io);
    expect(resolver.resolve('/repo/src/deep')).toBe('https://github.com/org/proj');
  });

  it('resolves a linked-worktree .git FILE via gitdir + commondir', () => {
    const io: GitRemoteIo = {
      statKind: (p) => (norm(p).endsWith('/wt/.git') ? 'file' : 'absent'),
      readFile: (p) => {
        const n = norm(p);
        if (n.endsWith('/wt/.git')) return 'gitdir: /main/.git/worktrees/wt\n';
        if (n.endsWith('/main/.git/worktrees/wt/commondir')) return '/main/.git\n';
        if (n.endsWith('/main/.git/config'))
          return '[remote "origin"]\n\turl = https://github.com/org/main.git\n';
        return undefined;
      },
    };
    const resolver = new GitRemoteResolver(io);
    expect(resolver.resolve('/wt')).toBe('https://github.com/org/main');
  });

  it('returns unknown when there is no git repo and caches per cwd', () => {
    let calls = 0;
    const io: GitRemoteIo = {
      statKind: () => {
        calls += 1;
        return 'absent';
      },
      readFile: () => undefined,
    };
    const resolver = new GitRemoteResolver(io);
    expect(resolver.resolve('/no/git')).toBe('unknown');
    const after = calls;
    resolver.resolve('/no/git'); // cached — no further stat walk
    expect(calls).toBe(after);
  });
});
