import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { ClaudeFs, DirEntry } from './paths';
import type { ClaudeSessionInput } from './mapper';
import type { TranscriptRecord, TranscriptUsage } from './transcript';
import { analyzeClaudeContext } from './claudeContextAnalyzer';

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

/** An assistant record with usage and optional content blocks. */
function turn(usage: TranscriptUsage, ...content: Array<Record<string, unknown>>): TranscriptRecord {
  return { type: 'assistant', message: { role: 'assistant', usage, content: content as never } };
}

const cwd = 'repo';
const tree: Record<string, DirEntry[]> = {
  [path.normalize('repo')]: [file('CLAUDE.md'), subdir('.claude')],
  [path.normalize('.')]: [subdir('repo')],
  [path.normalize(path.join('home', '.claude'))]: [file('CLAUDE.md')],
  [path.normalize(path.join('repo', '.claude', 'skills', 'code-review'))]: [file('SKILL.md')],
  [path.normalize(path.join('repo', '.claude', 'agents'))]: [file('claude-code-guide.md')],
};

describe('analyzeClaudeContext', () => {
  it('analyzes a main-only session: memory hierarchy, skills, reads and token budget', () => {
    const input: ClaudeSessionInput = {
      sessionId: 's1',
      cwd,
      repository: 'repo',
      codeExts: [],
      docExts: [],
      subagents: [],
      mainRecords: [
        turn(
          { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 },
          { type: 'tool_use', name: 'Skill', id: 'k1', input: { skill: 'code-review' } },
          { type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: 'repo/.claude/agents/reviewer.md' } },
        ),
        turn({ input_tokens: 100, cache_read_input_tokens: 5000 }),
      ],
    };

    const result = analyzeClaudeContext(input, undefined, fakeFs(tree));
    expect(result).toBeDefined();

    expect(result!.agents).toHaveLength(1);
    const main = result!.agents[0];
    expect(main.agentName).toBe('Main agent');
    expect(main.kind).toBe('main');

    // Largest (input + cache_read + cache_creation) across turns: 1000+20000+500.
    expect(main.totalContextTokens).toBe(21500);

    const names = main.loadedFiles.map((f) => f.name).sort();
    // Two CLAUDE.md (disambiguated), the invoked skill, and the context-file read.
    expect(names).toContain('CLAUDE.md (repo)');
    expect(names).toContain('CLAUDE.md (.claude)');
    expect(names).toContain('code-review');
    expect(names).toContain('reviewer.md');

    const skill = main.loadedFiles.find((f) => f.name === 'code-review');
    expect(skill?.category).toBe('skill');
    expect(skill?.status).toBe('applied');
    const read = main.loadedFiles.find((f) => f.name === 'reviewer.md');
    expect(read?.status).toBe('read');

    expect(result!.total.kind).toBe('total');
    // Best-effort provenance caption is attached for the Claude path.
    expect(result!.note).toMatch(/on-disk/i);
  });

  it('adds a partition per sub-agent, named to match the Overview tab', () => {
    const input: ClaudeSessionInput = {
      sessionId: 's2',
      cwd,
      repository: 'repo',
      codeExts: [],
      docExts: [],
      mainRecords: [turn({ input_tokens: 500, cache_read_input_tokens: 1000 })],
      subagents: [
        {
          agentType: 'claude-code-guide',
          records: [
            turn(
              { input_tokens: 8000, cache_read_input_tokens: 3000 },
              { type: 'tool_use', name: 'Read', id: 'r2', input: { file_path: 'repo/.claude/hooks/pre.md' } },
            ),
          ],
        },
        {
          agentType: 'Explore', // built-in: no definition file on disk
          records: [turn({ input_tokens: 4000 })],
        },
      ],
    };

    const result = analyzeClaudeContext(input, undefined, fakeFs(tree));
    expect(result).toBeDefined();
    expect(result!.agents.map((a) => a.agentName)).toEqual([
      'Main agent',
      'Sub-agent: claude-code-guide',
      'Sub-agent: Explore',
    ]);

    const guide = result!.agents.find((a) => a.agentName === 'Sub-agent: claude-code-guide')!;
    expect(guide.kind).toBe('subagent');
    expect(guide.totalContextTokens).toBe(11000);
    // Its definition file (resolved on disk) plus the context-file read.
    expect(guide.loadedFiles.map((f) => f.name)).toContain('claude-code-guide.md');
    expect(guide.loadedFiles.map((f) => f.name)).toContain('pre.md');

    // Built-in agent has no definition file, so no agent-def entry appears.
    const explore = result!.agents.find((a) => a.agentName === 'Sub-agent: Explore')!;
    expect(explore.loadedFiles.some((f) => f.name.endsWith('.md') && f.category === 'agent')).toBe(false);
  });

  it('returns undefined when there is no context signal at all', () => {
    const input: ClaudeSessionInput = {
      sessionId: 's3',
      cwd: undefined,
      repository: 'repo',
      codeExts: [],
      docExts: [],
      subagents: [],
      mainRecords: [{ type: 'user', message: { role: 'user', content: 'hi' } }],
    };
    expect(analyzeClaudeContext(input, undefined, fakeFs({}))).toBeUndefined();
  });
});
