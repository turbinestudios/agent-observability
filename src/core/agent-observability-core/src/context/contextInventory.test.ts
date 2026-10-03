import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyInventoryPath, scanContextInventory } from './contextInventory';

describe('classifyInventoryPath', () => {
  it.each([
    ['CLAUDE.md', 'memory', 'claude'],
    ['CLAUDE.local.md', 'memory', 'claude'],
    ['packages/api/CLAUDE.md', 'memory', 'claude'],
    ['AGENTS.md', 'memory', 'shared'],
    ['.github/copilot-instructions.md', 'instruction', 'copilot'],
    ['copilot-instructions.md', 'instruction', 'copilot'],
    ['.claude/rules/a.md', 'rule', 'claude'],
    ['.claude/rules/nested/deep.md', 'rule', 'claude'],
    ['.github/instructions/ts.instructions.md', 'instruction', 'copilot'],
    ['docs/style.instructions.md', 'instruction', 'copilot'],
    ['.claude/skills/review/SKILL.md', 'skill', 'claude'],
    ['.agents/skills/review/SKILL.md', 'skill', 'claude'],
    ['.github/skills/x/SKILL.md', 'skill', 'copilot'],
    ['.copilot/skills/x/SKILL.md', 'skill', 'copilot'],
    ['.claude/agents/reviewer.md', 'agent', 'claude'],
    ['.github/agents/planner.agent.md', 'agent', 'copilot'],
    ['.agents/roles/r.md', 'agent', 'shared'],
    ['.github/prompts/fix.prompt.md', 'prompt', 'copilot'],
    ['tools/lint.skill.md', 'skill', 'shared'],
  ] as const)('%s → %s / %s', (rel, kind, agent) => {
    expect(classifyInventoryPath(rel)).toEqual({ kind, agent });
  });

  it.each(['src/README.md', 'README.md', '.claude/settings.json', 'docs/notes.md', '.github/workflows/ci.yml', 'other/copilot-instructions.md', ''])(
    'does not classify %s',
    (rel) => {
      expect(classifyInventoryPath(rel)).toBeUndefined();
    },
  );
});

describe('scanContextInventory', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-inventory-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('lists classified files with POSIX relative paths and sizes, skipping excluded folders and noise', () => {
    write('CLAUDE.md', 'a'.repeat(10));
    write('AGENTS.md', 'b'.repeat(4));
    write('.claude/rules/style.md', 'c'.repeat(9));
    write('.github/skills/x/SKILL.md', 'd');
    write('.github/workflows/ci.yml', 'not a context file');
    write('.claude/node_modules/pkg/CLAUDE.md', 'excluded');
    write('src/README.md', 'ignored: not a context dir');

    const inventory = scanContextInventory(root);

    expect(inventory.truncated).toBe(false);
    expect(inventory.files.map((f) => f.relPath)).toEqual([
      '.claude/rules/style.md',
      '.github/skills/x/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    for (const file of inventory.files) {
      expect(file.relPath.includes('\\')).toBe(false);
    }
    const rule = inventory.files.find((f) => f.relPath === '.claude/rules/style.md');
    expect(rule).toMatchObject({ kind: 'rule', agent: 'claude', bytes: 9, estTokens: 3 });
    const memory = inventory.files.find((f) => f.relPath === 'CLAUDE.md');
    expect(memory).toMatchObject({ kind: 'memory', agent: 'claude', bytes: 10, estTokens: 3 });
  });

  it('returns an empty inventory for a root without context files', () => {
    write('src/index.ts', 'export {}');
    expect(scanContextInventory(root)).toEqual({ files: [], truncated: false });
  });

  it('reports truncation through the injected seam when the file budget is exhausted', () => {
    const many = Array.from({ length: 6000 }, (_, i) => ({ name: `f${i}.md`, isDirectory: false, isFile: true }));
    const inventory = scanContextInventory(root, {
      readDir: (dir) => (dir.endsWith('.claude') ? many : []),
      // Only the budget-busting tree exists; no repo-root files.
      fileSize: (p) => (p.includes('.claude') ? 1 : undefined),
    });
    expect(inventory.truncated).toBe(true);
    expect(inventory.files.length).toBe(0);
  });
});
