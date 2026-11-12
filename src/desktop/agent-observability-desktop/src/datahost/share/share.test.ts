import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureDetail } from '@agent-observability/core/src/share/sharedSessionFixture';
import { SharedSessionSource } from '@agent-observability/core/src/share/sharedSessionSource';
import { IndexDb } from '../indexer/indexDb';
import { SharedIndexer } from '../indexer/sharedIndexer';
import type { SessionContextAnalysis } from '@agent-observability/core/src/context/models';
import type { SessionRow } from '../../shared/rpc';
import { exportShare, importShare, previewShare, removeShared, type ShareSessionInput } from './shareFiles';
import { figureExclusions } from './figures';

/**
 * Sharing a session end to end: export to a file, import it into a separate
 * folder and index, and check it never counts toward the receiver's figures.
 * Everything runs in a temp directory; nothing reads the real home folder.
 */

let root: string;
let sharedDir: string;
let db: IndexDb;

function input(over: Partial<ShareSessionInput> = {}): ShareSessionInput {
  return {
    source: 'claude',
    sessionId: 'abc-123',
    detail: () => fixtureDetail(),
    costMode: 'usd',
    toolVersion: '2.5.0',
    nowMs: 5_000,
    ...over,
  };
}

function ownRow(sessionId: string): SessionRow {
  return {
    source: 'claude',
    sessionId,
    repository: 'octo/repo',
    startedAtMs: 1_000,
    endedAtMs: Date.now(),
    durationMs: 60_000,
    interactionCount: 10,
    llmCalls: 4,
    toolCalls: 6,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 25,
    model: 'claude-sonnet',
    agentModes: [],
    indexedAtMs: 1,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-share-'));
  sharedDir = path.join(root, 'shared');
  db = new IndexDb(path.join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('previewShare', () => {
  it('reports the size, turns and redactions without writing', () => {
    const preview = previewShare(input());
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.turns).toBe(1);
      expect(preview.redactions).toBe(1);
      expect(preview.bytes).toBeGreaterThan(0);
    }
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('refuses an imported session', () => {
    expect(previewShare(input({ source: 'shared' })).ok).toBe(false);
  });
});

describe('exportShare', () => {
  it('writes only to a path with the shared-session extension', () => {
    const wrong = path.join(root, 'notes.txt');
    expect(exportShare(input(), wrong).ok).toBe(false);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(exportShare(input(), 'relative.aosession.json').ok).toBe(false);
  });

  it('writes a file that imports, and leaves no temp file behind', () => {
    const target = path.join(root, 'login bug.aosession.json');
    const result = exportShare(input(), target);
    expect(result.ok).toBe(true);
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const text = fs.readFileSync(target, 'utf8');
    expect(text).not.toContain('ghp_');
    expect(text).toContain('[REDACTED:token]');
  });
});

describe('exporting the Context Analysis', () => {
  const repo = path.join(path.parse(process.cwd()).root, 'work', 'repo');
  const context = (): SessionContextAnalysis => {
    const total = {
      agentName: 'Total',
      kind: 'total' as const,
      loadedFiles: [{ name: 'AGENTS.md', filePath: path.join(repo, 'AGENTS.md'), category: 'instruction' as const, status: 'applied' as const }],
      expectedMissing: [],
      totalContextTokens: 1_000,
      contextFileTokens: 100,
      otherContextTokens: 900,
      oversizedFiles: [],
    };
    return { total, agents: [] };
  };

  it('writes the analysis with repository-relative paths, and the imported copy serves it', () => {
    const target = path.join(root, 'with-context.aosession.json');
    const result = exportShare(input({ context, repoRootOf: () => repo }), target);
    expect(result.ok).toBe(true);
    const text = fs.readFileSync(target, 'utf8');
    expect(text).toContain('"repoPath": "AGENTS.md"');
    expect(text).not.toContain(JSON.stringify(repo).slice(1, -1));

    const imported = importShare(target, sharedDir);
    expect(imported.ok).toBe(true);
    const id = imported.ok ? imported.sessionId : '';
    const served = new SharedSessionSource(sharedDir).getContextAnalysis(id);
    expect(served?.readOnly).toBe(true);
    expect(served?.total.loadedFiles[0]).toMatchObject({ name: 'AGENTS.md', repoPath: 'AGENTS.md' });
  });

  it('still exports the session when the analysis fails', () => {
    const target = path.join(root, 'no-context.aosession.json');
    const broken = (): SessionContextAnalysis => {
      throw new Error('analysis failed');
    };
    expect(exportShare(input({ context: broken }), target).ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('contextAnalysis');
  });
});

describe('importShare', () => {
  it('stores nothing when the file is invalid', () => {
    const bad = path.join(root, 'bad.aosession.json');
    fs.writeFileSync(bad, JSON.stringify({ kind: 'agent-observability.shared-session', schemaVersion: '1.0' }), 'utf8');
    const result = importShare(bad, sharedDir);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(sharedDir) ? fs.readdirSync(sharedDir) : []).toEqual([]);
  });

  it('refuses a file that is not JSON by name, and one that does not exist', () => {
    expect(importShare(path.join(root, 'x.txt'), sharedDir).ok).toBe(false);
    expect(importShare(path.join(root, 'missing.json'), sharedDir).ok).toBe(false);
  });

  it('stores a valid file once, replacing it on a second import', () => {
    const file = path.join(root, 's.aosession.json');
    exportShare(input(), file);
    const first = importShare(file, sharedDir);
    expect(first.ok && first.replaced).toBe(false);
    const second = importShare(file, sharedDir);
    expect(second.ok && second.replaced).toBe(true);
    expect(fs.readdirSync(sharedDir)).toHaveLength(1);
  });

  it('accepts a file saved with a byte-order mark', () => {
    const file = path.join(root, 'bom.aosession.json');
    exportShare(input(), file);
    fs.writeFileSync(file, `${String.fromCharCode(0xfeff)}${fs.readFileSync(file, 'utf8')}`, 'utf8');
    expect(importShare(file, sharedDir).ok).toBe(true);
  });
});

describe('an imported session in the index', () => {
  function importOne(): string {
    const file = path.join(root, 's.aosession.json');
    exportShare(input(), file);
    const result = importShare(file, sharedDir);
    if (!result.ok) {
      throw new Error(result.problems.join('; '));
    }
    return result.sessionId;
  }

  it('is listed under the shared source with the sender\'s figures', () => {
    const id = importOne();
    const indexed = new SharedIndexer({ db, source: new SharedSessionSource(sharedDir) }).run();
    expect(indexed).toEqual({ discovered: 1, hydrated: 1, problems: [] });
    const row = db.getRow('shared', id);
    expect(row?.inputTokens).toBe(100);
    expect(row?.title).toBe('Fix the login bug');
  });

  it('is skipped on the next pass while its file is unchanged, and dropped once removed', () => {
    const id = importOne();
    const source = new SharedSessionSource(sharedDir);
    new SharedIndexer({ db, source }).run();
    expect(new SharedIndexer({ db, source }).run().hydrated).toBe(0);
    const file = source.fileFor(id);
    expect(file).toBeDefined();
    expect(removeShared(file as string).ok).toBe(true);
    source.refresh();
    new SharedIndexer({ db, source }).run();
    expect(db.getRow('shared', id)).toBeUndefined();
  });

  it('never counts toward the receiver\'s own figures', () => {
    importOne();
    new SharedIndexer({ db, source: new SharedSessionSource(sharedDir) }).run();
    db.upsertSessions([ownRow('mine')]);

    const hidden = { all: (): string[] => [], isHidden: (): boolean => false };
    const figures = figureExclusions(hidden, () => db.hydratedSessionIds('shared'));

    // The list still shows both…
    expect(db.listSessions({}, hidden.all()).map((r) => r.source).sort()).toEqual(['claude', 'shared']);
    // …but every aggregate read through the exclusions sees only the user's own.
    expect(db.overview(30, figures.all()).totals.sessions).toBe(1);
    expect(figures.isHidden('shared', 'anything')).toBe(true);
    expect(figures.isHidden('claude', 'mine')).toBe(false);
  });
});
