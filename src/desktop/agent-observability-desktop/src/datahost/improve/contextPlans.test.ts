import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextPlanStore, MAX_STORED_PLANS, type StoredContextPlan } from './contextPlans';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plans-'));
  file = path.join(dir, 'context-plans.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function plan(over: Partial<StoredContextPlan> = {}): StoredContextPlan {
  return {
    id: over.id ?? `p-${Math.random().toString(36).slice(2)}`,
    repository: 'github.com/acme/app',
    repoRoot: path.join(dir, 'repo'),
    createdAtMs: 1_000,
    backendId: 'claude-code',
    backendLabel: 'Claude Code',
    vendor: 'Anthropic',
    model: 'sonnet',
    selection: { hotspotFiles: [], sessions: [] },
    narrative: 'Do better.',
    invalidEditCount: 0,
    edits: [],
    gathered: [],
    ...over,
  };
}

describe('ContextPlanStore', () => {
  it('round-trips plans across instances, newest first', () => {
    const store = new ContextPlanStore(file);
    store.add(plan({ id: 'old', createdAtMs: 1 }));
    store.add(plan({ id: 'new', createdAtMs: 2 }));

    const reopened = new ContextPlanStore(file);
    expect(reopened.list().map((p) => p.id)).toEqual(['new', 'old']);
    expect(reopened.get('old')?.narrative).toBe('Do better.');
  });

  it('narrows the list to one repository', () => {
    const store = new ContextPlanStore(file);
    store.add(plan({ id: 'a' }));
    store.add(plan({ id: 'b', repository: 'github.com/acme/other' }));
    expect(store.list('github.com/acme/other').map((p) => p.id)).toEqual(['b']);
  });

  it('prunes the oldest plan without undo state, never one holding a backup', () => {
    const store = new ContextPlanStore(file);
    // The very oldest plan holds an applied, un-reverted edit — it must survive.
    store.add(
      plan({
        id: 'applied-oldest',
        createdAtMs: 0,
        edits: [
          {
            path: 'CLAUDE.md',
            action: 'replace',
            content: 'x',
            appliedAtMs: 5,
            backup: { content: 'old', capturedAtMs: 5 },
          },
        ],
      }),
    );
    for (let n = 0; n < MAX_STORED_PLANS; n += 1) {
      store.add(plan({ id: `filler-${n}`, createdAtMs: n + 1 }));
    }

    const ids = store.list().map((p) => p.id);
    expect(ids).toHaveLength(MAX_STORED_PLANS);
    expect(ids).toContain('applied-oldest');
    expect(ids).not.toContain('filler-0'); // the oldest prunable went instead
  });

  it('reads a broken or hand-mangled file as fewer plans, never a crash', () => {
    fs.writeFileSync(file, 'not json', 'utf8');
    expect(new ContextPlanStore(file).list()).toEqual([]);

    fs.writeFileSync(file, JSON.stringify([{ id: 'missing-everything' }, null, 42]), 'utf8');
    expect(new ContextPlanStore(file).list()).toEqual([]);
  });
});
