import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  ClaudeFs,
  DirEntry,
  classifyTranscriptFile,
  discoverClaudeSessions,
} from './paths';

describe('classifyTranscriptFile', () => {
  const root = path.join('home', '.claude', 'projects');

  it('classifies a top-level transcript as a main session', () => {
    const file = path.join(root, 'proj', 'sess1.jsonl');
    expect(classifyTranscriptFile(root, file)).toEqual({ sessionId: 'sess1', kind: 'main' });
  });

  it('classifies a subagents/ file under <sessionId> as a subagent', () => {
    const file = path.join(root, 'proj', 'sess1', 'subagents', 'agent-abc.jsonl');
    expect(classifyTranscriptFile(root, file)).toEqual({ sessionId: 'sess1', kind: 'subagent' });
  });

  it('ignores non-jsonl files', () => {
    expect(classifyTranscriptFile(root, path.join(root, 'proj', 'notes.txt'))).toBeUndefined();
  });
});

describe('discoverClaudeSessions', () => {
  const root = path.join('home', '.claude', 'projects');
  const proj = path.join(root, 'proj');
  const sess = path.join(proj, 'sess1');
  const subs = path.join(sess, 'subagents');

  const dir = (...names: Array<[string, boolean]>): DirEntry[] =>
    names.map(([name, isDir]) => ({ name, isDirectory: isDir, isFile: !isDir }));

  const tree: Record<string, DirEntry[]> = {
    [root]: dir(['proj', true]),
    [proj]: dir(['sess1.jsonl', false], ['sess1', true]),
    [sess]: dir(['subagents', true]),
    [subs]: dir(['agent-a.jsonl', false], ['agent-b.jsonl', false]),
  };

  const env: ClaudeFs = {
    homedir: () => 'home',
    env: {},
    isDirectory: (p) => tree[p] !== undefined,
    readDir: (p) => tree[p] ?? [],
    mtimeMs: (p) => (p.endsWith('agent-b.jsonl') ? 300 : p.endsWith('sess1.jsonl') ? 100 : 50),
  };

  const config = {
    getClaudeProjectsPathOverride: () => root,
    getClaudeScanDepth: () => 5,
  };

  it('groups a main transcript with its sub-agent side-chains, newest mtime', () => {
    const sessions = discoverClaudeSessions(config, env);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.sessionId).toBe('sess1');
    expect(s.mainFile && path.basename(s.mainFile)).toBe('sess1.jsonl');
    expect(s.subagentFiles.map((f) => path.basename(f)).sort()).toEqual([
      'agent-a.jsonl',
      'agent-b.jsonl',
    ]);
    // Newest file across the session (agent-b @ 300) wins.
    expect(s.mtimeMs).toBe(300);
  });
});
