import { describe, it, expect } from 'vitest';
import {
  GitRemoteIo,
  GitRemoteResolver,
  parseGitConfigRemote,
  parseSshConfigHostNames,
} from './gitRemote';

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

describe('parseSshConfigHostNames', () => {
  it('maps literal aliases to HostName, skipping wildcards, first HostName wins', () => {
    const text = `
# work account
Host github-work gh-w
  HostName github.com
  IdentityFile ~/.ssh/id_work

Host github-work
  HostName should-not-win.example

Host *
  ServerAliveInterval 60
Host *.internal !secret-host
  HostName internal.example.com
Host eq-form
HostName=alias.example.org
`;
    const map = parseSshConfigHostNames(text);
    expect(map.get('github-work')).toBe('github.com');
    expect(map.get('gh-w')).toBe('github.com');
    expect(map.get('eq-form')).toBe('alias.example.org');
    expect(map.has('*')).toBe(false);
    expect(map.has('*.internal')).toBe(false);
    expect(map.has('!secret-host')).toBe(false);
  });
});

describe('GitRemoteResolver — SSH host aliases', () => {
  const repoIo = (remote: string, sshConfigs: Record<string, string>): GitRemoteIo => ({
    statKind: (p) => (norm(p).endsWith('/repo/.git') ? 'dir' : 'absent'),
    readFile: (p) => {
      const n = norm(p);
      if (n.endsWith('/repo/.git/config')) {
        return `[remote "origin"]\n\turl = ${remote}\n`;
      }
      for (const [suffix, content] of Object.entries(sshConfigs)) {
        if (n.endsWith(suffix)) {
          return content;
        }
      }
      return undefined;
    },
  });

  it('resolves a dotless SCP host alias through ~/.ssh/config', () => {
    const io = repoIo('git@github-work:Org/Proj.git', {
      '/home/u/.ssh/config': 'Host github-work\n  HostName github.com\n',
    });
    const resolver = new GitRemoteResolver(io, '/home/u');
    expect(resolver.resolve('/repo/src')).toBe('https://github.com/Org/Proj');
  });

  it('resolves an ssh:// url alias the same way', () => {
    const io = repoIo('ssh://git@github-work/Org/Proj.git', {
      '/home/u/.ssh/config': 'Host github-work\n  HostName github.com\n',
    });
    const resolver = new GitRemoteResolver(io, '/home/u');
    expect(resolver.resolve('/repo')).toBe('https://github.com/Org/Proj');
  });

  it('stays unknown for a dotless alias with no ssh-config mapping', () => {
    const io = repoIo('git@github-work:Org/Proj.git', {});
    const resolver = new GitRemoteResolver(io, '/home/u');
    expect(resolver.resolve('/repo')).toBe('unknown');
  });

  it('leaves a dotted (real) host untouched', () => {
    const io = repoIo('git@github.com:Org/Proj.git', {
      // A malicious-looking mapping for the real host must never apply.
      '/home/u/.ssh/config': 'Host github.com\n  HostName evil.example\n',
    });
    const resolver = new GitRemoteResolver(io, '/home/u');
    expect(resolver.resolve('/repo')).toBe('https://github.com/Org/Proj');
  });

  it('consults the WSL user ssh config first for a \\\\wsl$ repo', () => {
    const io: GitRemoteIo = {
      statKind: (p) => (norm(p).endsWith('/proj/.git') ? 'dir' : 'absent'),
      readFile: (p) => {
        const n = norm(p);
        if (n.endsWith('/proj/.git/config')) {
          return '[remote "origin"]\n\turl = git@gh-wsl:Org/Proj.git\n';
        }
        if (n === '//wsl$/Ubuntu/home/dev/.ssh/config') {
          return 'Host gh-wsl\n  HostName github.com\n';
        }
        return undefined;
      },
    };
    const resolver = new GitRemoteResolver(io, '/home/u');
    expect(resolver.resolve('\\\\wsl$\\Ubuntu\\home\\dev\\proj')).toBe(
      'https://github.com/Org/Proj',
    );
  });
});
