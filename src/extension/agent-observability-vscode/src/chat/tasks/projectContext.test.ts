import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildContextFilesDigest,
  gatherProjectContextFiles,
  parseRemoteUrl,
  resolveWorkspaceRepository,
  type ProjectContextFile,
} from './projectContext';

describe('parseRemoteUrl', () => {
  it('prefers the origin remote', () => {
    const cfg = [
      '[remote "upstream"]',
      '\turl = https://github.com/upstream/repo.git',
      '[remote "origin"]',
      '\turl = git@github.com:org/repo.git',
    ].join('\n');
    expect(parseRemoteUrl(cfg)).toBe('git@github.com:org/repo.git');
  });

  it('falls back to the first remote when there is no origin', () => {
    const cfg = '[remote "fork"]\n\turl = https://example.com/a/b\n';
    expect(parseRemoteUrl(cfg)).toBe('https://example.com/a/b');
  });

  it('ignores url keys outside a remote section', () => {
    const cfg = '[branch "main"]\n\turl = not-a-remote\n';
    expect(parseRemoteUrl(cfg)).toBeUndefined();
  });
});

describe('resolveWorkspaceRepository', () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeAll(() => {
    // A normal repo: `.git/` directory with a config.
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-repo-'));
    mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    writeFileSync(
      path.join(repoDir, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/org/widgets.git\n',
      'utf8',
    );

    // A linked worktree: `.git` FILE -> worktree git dir whose commondir points
    // back at the shared git dir holding the config (mirrors the user's setup).
    worktreeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-wt-'));
    const wtGitDir = path.join(repoDir, '.git', 'worktrees', 'feature');
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8');
    writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('reads + sanitizes the origin remote of a normal repo', () => {
    expect(resolveWorkspaceRepository(repoDir)).toBe('https://github.com/org/widgets');
  });

  it('resolves the shared config through a linked worktree', () => {
    expect(resolveWorkspaceRepository(worktreeDir)).toBe('https://github.com/org/widgets');
  });

  it('returns unknown when there is no workspace or git dir', () => {
    expect(resolveWorkspaceRepository(undefined)).toBe('unknown');
    expect(resolveWorkspaceRepository(os.tmpdir() + path.sep + 'definitely-not-a-repo-xyz')).toBe(
      'unknown',
    );
  });
});

describe('gatherProjectContextFiles', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-files-'));
    const write = (rel: string, body: string): void => {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    };
    write('.github/copilot-instructions.md', '# how this repo works\n');
    write('.github/agents/planner.agent.md', '# planner\nPlans the work, then hands to coder.\n');
    write('.github/agents/coder.agent.md', '# coder\nImplements using read_file + apply_patch.\n');
    write('.github/prompts/review.prompt.md', '# review\n');
    write('README.md', 'not a customization file\n'); // must be ignored
    write('.github/agents/huge.agent.md', 'x'.repeat(20_000)); // exercises truncation
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the allowlisted files with contents + categories, ignoring source files', () => {
    const files = gatherProjectContextFiles(dir);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.has('README.md')).toBe(false);
    expect(byPath.get('.github/copilot-instructions.md')?.category).toBe('instruction');
    expect(byPath.get('.github/agents/planner.agent.md')?.category).toBe('agent');
    expect(byPath.get('.github/prompts/review.prompt.md')?.category).toBe('prompt');
    expect(byPath.get('.github/agents/coder.agent.md')?.content).toContain('apply_patch');
  });

  it('truncates a file that exceeds the per-file budget', () => {
    const files = gatherProjectContextFiles(dir, {
      maxFiles: 24,
      maxFileChars: 5_000,
      maxTotalChars: 1_000_000,
    });
    const huge = files.find((f) => f.path === '.github/agents/huge.agent.md');
    expect(huge?.truncated).toBe(true);
    expect(huge?.content.length).toBe(5_000);
  });

  it('honors the file-count budget', () => {
    const files = gatherProjectContextFiles(dir, {
      maxFiles: 2,
      maxFileChars: 8_000,
      maxTotalChars: 1_000_000,
    });
    expect(files.length).toBe(2);
  });

  it('returns empty when there is no workspace', () => {
    expect(gatherProjectContextFiles(undefined)).toEqual([]);
  });
});

describe('buildContextFilesDigest', () => {
  const files: ProjectContextFile[] = [
    {
      path: '.github/agents/planner.agent.md',
      category: 'agent',
      content: '# planner',
      truncated: false,
    },
  ];

  it('includes the repository and each file body', () => {
    const digest = buildContextFilesDigest('https://github.com/org/repo', files);
    expect(digest).toContain('https://github.com/org/repo');
    expect(digest).toContain('.github/agents/planner.agent.md');
    expect(digest).toContain('# planner');
    expect(digest).toContain('category: agent');
  });

  it('flags an unknown repository and tells the model what to use', () => {
    const digest = buildContextFilesDigest('unknown', files);
    expect(digest).toMatch(/"unknown"/);
  });

  it('reports the empty case without inventing files', () => {
    const digest = buildContextFilesDigest('https://github.com/org/repo', []);
    expect(digest).toMatch(/no copilot customization files/i);
  });

  it('marks truncated files', () => {
    const digest = buildContextFilesDigest('https://github.com/org/repo', [
      { ...files[0], truncated: true },
    ]);
    expect(digest).toMatch(/truncated/i);
  });
});
