import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { ClaudeFs, DirEntry } from './paths';
import type { TranscriptRecord } from './transcript';
import {
  detectContextToolReads,
  detectInvokedSkills,
  discoverMemoryFiles,
  isContextPath,
  resolveAgentDefinition,
} from './claudeContextDiscovery';

/** Build a ClaudeFs backed by a fixed directory → entries map. */
function fakeFs(tree: Record<string, DirEntry[]>, home = 'home'): ClaudeFs {
  return {
    homedir: () => home,
    env: {},
    isDirectory: (p) => tree[path.normalize(p)] !== undefined,
    readDir: (p) => tree[path.normalize(p)] ?? [],
    mtimeMs: () => 0,
  };
}

const file = (name: string): DirEntry => ({ name, isDirectory: false, isFile: true });
const subdir = (name: string): DirEntry => ({ name, isDirectory: true, isFile: false });

/** An assistant record carrying the given content blocks. */
function assistant(...content: Array<Record<string, unknown>>): TranscriptRecord {
  return { type: 'assistant', message: { role: 'assistant', content: content as never } };
}

describe('isContextPath', () => {
  it('matches context directories and known basenames', () => {
    expect(isContextPath('repo/.claude/skills/x/SKILL.md')).toBe(true);
    expect(isContextPath('repo/CLAUDE.md')).toBe(true);
    expect(isContextPath('C:\\repo\\.github\\copilot-instructions.md')).toBe(true);
    expect(isContextPath('repo/docs/foo.instructions.md')).toBe(true);
    expect(isContextPath('repo/AGENTS.md')).toBe(true);
  });

  it('rejects ordinary source files', () => {
    expect(isContextPath('repo/src/index.ts')).toBe(false);
    expect(isContextPath('repo/README.md')).toBe(false);
  });
});

describe('discoverMemoryFiles', () => {
  const cwd = path.join('repo', 'app');
  const tree: Record<string, DirEntry[]> = {
    [path.normalize(path.join('repo', 'app'))]: [file('CLAUDE.md'), subdir('.claude')],
    [path.normalize('repo')]: [file('CLAUDE.md'), subdir('app')],
    [path.normalize('.')]: [subdir('repo')],
    [path.normalize(path.join('home', '.claude'))]: [file('CLAUDE.md')],
  };

  it('collects the CLAUDE.md hierarchy plus user memory, uniquified by directory', () => {
    const entries = discoverMemoryFiles(cwd, fakeFs(tree));
    // Three CLAUDE.md at different levels → all disambiguated by parent dir.
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['CLAUDE.md (.claude)', 'CLAUDE.md (app)', 'CLAUDE.md (repo)']);
    for (const e of entries) {
      expect(e.category).toBe('instruction');
      expect(e.status).toBe('applied');
      expect(e.filePath).toBeTruthy();
    }
  });

  it('leaves a single memory file unqualified', () => {
    const single: Record<string, DirEntry[]> = {
      [path.normalize(path.join('repo', 'app'))]: [file('CLAUDE.md')],
      [path.normalize('repo')]: [subdir('app')],
      [path.normalize('.')]: [subdir('repo')],
      [path.normalize(path.join('home', '.claude'))]: [],
    };
    const entries = discoverMemoryFiles(cwd, fakeFs(single));
    expect(entries.map((e) => e.name)).toEqual(['CLAUDE.md']);
  });

  it('returns nothing when cwd is undefined and no user memory exists', () => {
    expect(discoverMemoryFiles(undefined, fakeFs({}))).toEqual([]);
  });
});

describe('detectContextToolReads', () => {
  it('keeps Read calls targeting context paths and drops the rest', () => {
    const records: TranscriptRecord[] = [
      assistant(
        { type: 'tool_use', name: 'Read', id: 'a', input: { file_path: 'repo/.claude/agents/x.md' } },
        { type: 'tool_use', name: 'Read', id: 'b', input: { file_path: 'repo/src/index.ts' } },
        { type: 'tool_use', name: 'Edit', id: 'c', input: { file_path: 'repo/.claude/hooks/h.md' } },
      ),
    ];
    const rows = detectContextToolReads(records);
    expect(rows.map((r) => r.filePath)).toEqual(['repo/.claude/agents/x.md']);
    expect(rows[0]).toMatchObject({ conversationId: null, chatSessionId: null });
  });

  it('ignores tool_use blocks without a string file_path', () => {
    const records: TranscriptRecord[] = [
      assistant({ type: 'tool_use', name: 'Read', id: 'a', input: { offset: 1 } }),
    ];
    expect(detectContextToolReads(records)).toEqual([]);
  });
});

describe('detectInvokedSkills', () => {
  const cwd = path.join('repo', 'app');
  const skillDir = path.normalize(path.join('repo', 'app', '.claude', 'skills', 'code-review'));
  const tree: Record<string, DirEntry[]> = {
    [skillDir]: [file('SKILL.md')],
  };

  it('resolves a known skill to its SKILL.md and dedups repeats', () => {
    const records: TranscriptRecord[] = [
      assistant({ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'code-review' } }),
      assistant({ type: 'tool_use', name: 'Skill', id: 's2', input: { skill: 'code-review' } }),
    ];
    const entries = detectInvokedSkills(records, cwd, fakeFs(tree));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('code-review');
    expect(entries[0].category).toBe('skill');
    expect(entries[0].status).toBe('applied');
    expect(entries[0].filePath && path.basename(entries[0].filePath)).toBe('SKILL.md');
  });

  it('records an unresolved (e.g. plugin) skill by name without a path', () => {
    const records: TranscriptRecord[] = [
      assistant({ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'plugin:deploy' } }),
    ];
    const entries = detectInvokedSkills(records, cwd, fakeFs(tree));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('plugin:deploy');
    expect(entries[0].filePath).toBeUndefined();
  });
});

describe('resolveAgentDefinition', () => {
  const cwd = path.join('repo', 'app');
  const agentsDir = path.normalize(path.join('repo', 'app', '.claude', 'agents'));
  const env = fakeFs({ [agentsDir]: [file('claude-code-guide.md')] });

  it('resolves a custom agent definition file', () => {
    const entry = resolveAgentDefinition('claude-code-guide', cwd, env);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('claude-code-guide.md');
    expect(entry!.category).toBe('agent');
    expect(entry!.filePath && path.basename(entry!.filePath)).toBe('claude-code-guide.md');
  });

  it('returns undefined for a built-in agent with no definition file', () => {
    expect(resolveAgentDefinition('Explore', cwd, env)).toBeUndefined();
    expect(resolveAgentDefinition(undefined, cwd, env)).toBeUndefined();
  });
});
