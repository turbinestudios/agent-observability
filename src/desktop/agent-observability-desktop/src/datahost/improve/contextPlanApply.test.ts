import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesktopSettingsReader } from '../drivers/desktopConfig';
import { ContextPlanStore, type StoredContextPlan } from './contextPlans';
import { IMPROVE_ENABLED_KEY, sha256 } from './contextPlan';
import { applyContextPlan, diffForEdit, undoContextPlan } from './contextPlanApply';

/**
 * The write path's whole safety story, against real temp fixture repos:
 * allowlist, traversal, staleness, backup-before-write, undo, and never-delete.
 */

const REPO = 'github.com/acme/app';
const OLD = '# Rules\nOld content.\n';
const NEW = '# Rules\nNew content.\n';

let dir: string;
let repoDir: string;
let store: ContextPlanStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-apply-'));
  repoDir = path.join(dir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), OLD, 'utf8');
  store = new ContextPlanStore(path.join(dir, 'plans.json'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedPlan(over: Partial<StoredContextPlan> = {}): StoredContextPlan {
  const plan: StoredContextPlan = {
    id: 'p1',
    repository: REPO,
    repoRoot: repoDir,
    createdAtMs: 1_000,
    backendId: 'claude-code',
    backendLabel: 'Claude Code',
    vendor: 'Anthropic',
    model: 'sonnet',
    selection: { hotspotFiles: [], sessions: [] },
    narrative: 'plan',
    invalidEditCount: 0,
    edits: [
      { path: 'CLAUDE.md', action: 'replace', content: NEW, baseHash: sha256(OLD) },
      { path: 'AGENTS.md', action: 'create', content: '# Agents guide\n' },
    ],
    gathered: [{ path: 'CLAUDE.md', baseHash: sha256(OLD), truncated: false }],
    ...over,
  };
  store.add(plan);
  return store.get(plan.id) as StoredContextPlan;
}

function depsWith(enabled = true) {
  return {
    store,
    settings: {
      get: <T,>(key: string, fallback: T): T =>
        key === IMPROVE_ENABLED_KEY ? (enabled as unknown as T) : fallback,
    } as unknown as DesktopSettingsReader,
    seams: { resolveRepository: () => REPO },
  };
}

describe('applyContextPlan', () => {
  it('replaces and creates approved files, backing up before the first write', () => {
    seedPlan();
    const result = applyContextPlan('p1', ['CLAUDE.md', 'AGENTS.md'], depsWith());

    expect(result.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe(NEW);
    expect(fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf8')).toBe('# Agents guide\n');

    const stored = store.get('p1');
    expect(stored?.edits[0].backup?.content).toBe(OLD);
    expect(stored?.edits[0].appliedAtMs).toBeDefined();
    // The backup survives a reload — it was flushed, not just held in memory.
    const reloaded = new ContextPlanStore(path.join(dir, 'plans.json'));
    expect(reloaded.get('p1')?.edits[0].backup?.content).toBe(OLD);
  });

  it('refuses everything when the gate is off', () => {
    seedPlan();
    const result = applyContextPlan('p1', ['CLAUDE.md'], depsWith(false));
    expect(result.error).toContain('turned off in Settings');
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe(OLD);
  });

  it('refuses a stale replace and a create whose target now exists', () => {
    seedPlan();
    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Someone edited this\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), '# Already here\n', 'utf8');

    const result = applyContextPlan('p1', ['CLAUDE.md', 'AGENTS.md'], depsWith());
    expect(result.results.map((r) => r.status)).toEqual(['stale', 'stale']);
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('# Someone edited this\n');
    expect(fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf8')).toBe('# Already here\n');
  });

  it('refuses paths outside the plan, tampered paths, and a re-pointed root', () => {
    const plan = seedPlan();
    expect(applyContextPlan('p1', ['SKILL.md'], depsWith()).results[0].status).toBe('refused');

    // The store file is user-editable JSON: a hand-added traversal path must
    // die at the allowlist re-check, not reach the filesystem.
    plan.edits.push({ path: '../escape/CLAUDE.md', action: 'create', content: 'x' });
    const tampered = applyContextPlan('p1', ['../escape/CLAUDE.md'], depsWith());
    expect(tampered.results[0].status).toBe('refused');
    expect(fs.existsSync(path.join(dir, 'escape'))).toBe(false);

    const moved = applyContextPlan('p1', ['CLAUDE.md'], {
      ...depsWith(),
      seams: { resolveRepository: () => 'github.com/acme/other' },
    });
    expect(moved.error).toContain('no longer belongs');
  });

  it('reports a vanished replace target as missing', () => {
    seedPlan();
    fs.rmSync(path.join(repoDir, 'CLAUDE.md'));
    expect(applyContextPlan('p1', ['CLAUDE.md'], depsWith()).results[0].status).toBe('missing');
  });
});

describe('undoContextPlan', () => {
  it('restores an applied, untouched file from its backup', () => {
    seedPlan();
    applyContextPlan('p1', ['CLAUDE.md'], depsWith());
    const result = undoContextPlan('p1', ['CLAUDE.md'], depsWith());

    expect(result.results[0].status).toBe('reverted');
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe(OLD);
    expect(store.get('p1')?.edits[0].revertedAtMs).toBeDefined();
  });

  it('refuses after outside edits, and never deletes a created file', () => {
    seedPlan();
    applyContextPlan('p1', ['CLAUDE.md', 'AGENTS.md'], depsWith());

    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Edited after apply\n', 'utf8');
    const edited = undoContextPlan('p1', ['CLAUDE.md'], depsWith());
    expect(edited.results[0].status).toBe('refused');
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('# Edited after apply\n');

    const created = undoContextPlan('p1', ['AGENTS.md'], depsWith());
    expect(created.results[0].status).toBe('refused');
    expect(created.results[0].detail).toContain('remove it manually');
    expect(fs.existsSync(path.join(repoDir, 'AGENTS.md'))).toBe(true);
  });

  it('has nothing to undo before an apply', () => {
    seedPlan();
    expect(undoContextPlan('p1', ['CLAUDE.md'], depsWith()).results[0].status).toBe('refused');
  });
});

describe('diffForEdit', () => {
  it('diffs against the CURRENT file, doubling as a staleness probe', () => {
    seedPlan();
    const fresh = diffForEdit('p1', 'CLAUDE.md', depsWith());
    expect(fresh.stale).toBe(false);
    expect(fresh.lines.some((l) => l.kind === 'add' && l.text === 'New content.')).toBe(true);
    expect(fresh.lines.some((l) => l.kind === 'del' && l.text === 'Old content.')).toBe(true);

    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Drifted\n', 'utf8');
    expect(diffForEdit('p1', 'CLAUDE.md', depsWith()).stale).toBe(true);
  });

  it('shows a create as pure additions, stale once the file exists', () => {
    seedPlan();
    const fresh = diffForEdit('p1', 'AGENTS.md', depsWith());
    expect(fresh.stale).toBe(false);
    expect(fresh.lines.every((l) => l.kind === 'add')).toBe(true);

    fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), 'now exists', 'utf8');
    expect(diffForEdit('p1', 'AGENTS.md', depsWith()).stale).toBe(true);
  });
});
