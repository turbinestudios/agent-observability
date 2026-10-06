import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeService, ClaudeServiceConfig } from './claudeCodeService';
import { ClaudeFs, defaultFs } from './paths';
import { resolveClaudeProjectsDirs } from './paths';

/**
 * The completion check through the real service seam, over temp-dir
 * transcripts: one session per decision-table row. Asserts statuses and that
 * nothing content-derived (command, path, reply text) reaches the result.
 */

let root: string;
let cwd: string;
let service: ClaudeCodeService;
let n = 0;

const SECRET_COMMAND = 'npm test -- --grep zebra-marker';

function rec(o: Record<string, unknown>): string {
  n += 1;
  return JSON.stringify({ timestamp: new Date(Date.UTC(2026, 4, 1, 10, 0, n)).toISOString(), cwd, ...o });
}
const user = (text: string): string => rec({ type: 'user', message: { role: 'user', content: text } });
const say = (text: string): string =>
  rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] } });
const use = (id: string, name: string, input: Record<string, unknown>): string =>
  rec({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, isError: boolean): string =>
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'output body' }] } });

function edit(id: string, file: string): string[] {
  return [use(id, 'Edit', { file_path: path.join(cwd, file), old_string: 'a', new_string: 'b' }), result(id, false)];
}
function check(id: string, failed: boolean): string[] {
  return [use(id, 'Bash', { command: SECRET_COMMAND }), result(id, failed)];
}

const SESSIONS: Record<string, () => string[]> = {
  verified: () => [user('Add it'), ...edit('e1', 'src/a.ts'), ...check('c1', false), say('All tests pass. Done.')],
  unverified: () => [user('Add it'), ...edit('e1', 'src/a.ts'), say('The change is implemented and done.')],
  contradicted: () => [user('Add it'), ...edit('e1', 'src/a.ts'), ...check('c1', true), say('Everything is implemented and done.')],
  incomplete: () => [user('Add it'), ...edit('e1', 'src/a.ts'), say('I could not finish; remaining work is the parser.')],
  docsonly: () => [user('Fix the readme'), ...edit('e1', 'README.md'), say('Done.')],
};
const IDS: Record<string, string> = {};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-completion-'));
  cwd = path.join(root, 'work', 'repo');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  const projects = path.join(root, 'projects', 'enc');
  fs.mkdirSync(projects, { recursive: true });
  let i = 0;
  for (const [name, build] of Object.entries(SESSIONS)) {
    i += 1;
    const id = `0000000${i}-0000-4000-8000-000000000000`;
    IDS[name] = id;
    fs.writeFileSync(path.join(projects, `${id}.jsonl`), `${build().join('\n')}\n`);
  }
  const config: ClaudeServiceConfig = {
    isClaudeEnabled: () => true,
    getClaudeProjectsPathOverride: () => path.join(root, 'projects'),
    getClaudeScanDepth: () => 4,
    getClaudeMaxSessions: () => 150,
    getCodeFileExtensions: () => ['.ts'],
    getDocFileExtensions: () => ['.md'],
    getExcludedRepositories: () => new Set<string>(),
  };
  const env: ClaudeFs = { ...defaultFs, homedir: () => path.join(root, 'home'), env: {} };
  expect(resolveClaudeProjectsDirs(config, env).length).toBe(1);
  service = new ClaudeCodeService(config, env);
});

afterAll(() => {
  service.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function statusOf(name: string): string | undefined {
  const retro = service.getSessionRetrospective(IDS[name]);
  if (!retro.ok) {
    throw new Error(retro.message);
  }
  return retro.value.completion?.status;
}

describe('completion check through ClaudeCodeService', () => {
  it('decides each session by what its transcript recorded', () => {
    expect(statusOf('verified')).toBe('verified');
    expect(statusOf('unverified')).toBe('unverified');
    expect(statusOf('contradicted')).toBe('contradicted');
    expect(statusOf('incomplete')).toBe('incomplete');
    expect(statusOf('docsonly')).toBe('not-applicable');
  }, 30_000);

  it('exposes the activity through the source seam, classified', () => {
    const activity = service.getSessionActivity(IDS.contradicted);
    expect(activity.ok).toBe(true);
    if (activity.ok) {
      expect(activity.value.commands.map((c) => c.class)).toEqual(['test']);
      expect(activity.value.commands[0].failed).toBe(true);
      expect(activity.value.edits).toHaveLength(1);
      expect(activity.value.complete).toBe(true);
    }
  });

  it('keeps command text, paths and reply text out of the retrospective', () => {
    const retro = service.getSessionRetrospective(IDS.contradicted);
    expect(retro.ok).toBe(true);
    if (retro.ok) {
      const json = JSON.stringify({ completion: retro.value.completion, counts: retro.value.counts, findings: retro.value.findings });
      expect(json).not.toContain('zebra-marker');
      expect(json).not.toContain('a.ts');
      expect(json).not.toContain('Everything is implemented');
      expect(retro.value.counts.completion?.filesOutsideRepo).toBe(0);
      expect(retro.value.counts.completion?.lastVerifyClass).toBe('test');
    }
  });
});
