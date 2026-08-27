import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RenameStore } from './renames';
import type { SessionRow } from '../shared/rpc';

/**
 * Renames are the one piece of user-authored data the app holds. The index can
 * be dropped and rebuilt at any time, so what matters most here is that a name
 * survives independently of it, and that clearing one restores the original
 * rather than leaving the session blank.
 */

let dir: string;
let file: string;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'github.com/acme/app',
    title: 'Original title',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    durationMs: 1_000,
    interactionCount: 5,
    llmCalls: 2,
    toolCalls: 3,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    model: 'claude-sonnet-4',
    agentModes: [],
    indexedAtMs: 9,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-renames-'));
  file = path.join(dir, 'renames.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('setting and clearing', () => {
  it('stores a name and reads it back', () => {
    const store = new RenameStore(file);
    expect(store.set('claude', 'abc', 'Refactor the parser')).toBe('Refactor the parser');
    expect(store.get('claude', 'abc')).toBe('Refactor the parser');
  });

  it('trims surrounding whitespace', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', '  Padded  ');
    expect(store.get('claude', 'abc')).toBe('Padded');
  });

  it('clears on an empty name, restoring the original title', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'Temporary');
    expect(store.set('claude', 'abc', '')).toBeUndefined();
    expect(store.get('claude', 'abc')).toBeUndefined();
  });

  it('treats whitespace as a clear rather than a blank name', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'Temporary');
    store.set('claude', 'abc', '   ');
    expect(store.get('claude', 'abc')).toBeUndefined();
  });

  it('clearing something never renamed is a no-op', () => {
    const store = new RenameStore(file);
    expect(store.set('claude', 'never', '')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('keeps sources separate for the same session id', () => {
    const store = new RenameStore(file);
    store.set('claude', 'same-id', 'From Claude');
    store.set('copilot', 'same-id', 'From Copilot');
    expect(store.get('claude', 'same-id')).toBe('From Claude');
    expect(store.get('copilot', 'same-id')).toBe('From Copilot');
  });
});

describe('persistence', () => {
  it('survives a restart', () => {
    new RenameStore(file).set('claude', 'abc', 'Kept');
    expect(new RenameStore(file).get('claude', 'abc')).toBe('Kept');
  });

  it('starts empty when no file exists yet', () => {
    expect(new RenameStore(path.join(dir, 'absent.json')).size()).toBe(0);
  });

  it('degrades to no renames on an unparsable file rather than throwing', () => {
    fs.writeFileSync(file, '{ not json');
    expect(new RenameStore(file).size()).toBe(0);
  });

  it('ignores entries that are not usable names', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ 'claude:a': 'Good', 'claude:b': '', 'claude:c': 42, 'claude:d': null }),
    );
    const store = new RenameStore(file);
    expect(store.size()).toBe(1);
    expect(store.get('claude', 'a')).toBe('Good');
  });

  it('creates the directory when saving for the first time', () => {
    const nested = path.join(dir, 'deep', 'renames.json');
    new RenameStore(nested).set('claude', 'abc', 'Made a path');
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('applying to rows', () => {
  it('replaces the title and records the original', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'My name');

    const [patched] = store.apply([row({ sessionId: 'abc' })]);
    expect(patched.title).toBe('My name');
    expect(patched.originalTitle).toBe('Original title');
  });

  it('marks a renamed title as not derived, since the user typed it', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'My name');
    expect(store.apply([row({ sessionId: 'abc', titleDerived: true })])[0].titleDerived).toBe(false);
  });

  it('leaves rows without a rename untouched', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'My name');

    const rows = store.apply([row({ sessionId: 'abc' }), row({ sessionId: 'other' })]);
    expect(rows[1].title).toBe('Original title');
    expect(rows[1].originalTitle).toBeUndefined();
  });

  it('returns the input untouched when nothing is renamed', () => {
    const store = new RenameStore(file);
    const input = [row({ sessionId: 'abc' })];
    expect(store.apply(input)).toBe(input);
  });
});

describe('searching by the new name', () => {
  it('matches case-insensitively on a substring', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'Parser refactor');
    expect(store.matchingKeys('REFACTOR')).toEqual(['claude:abc']);
  });

  it('does not match the original title, which SQL already covers', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'Totally different');
    expect(store.matchingKeys('Original')).toEqual([]);
  });

  it('returns nothing for a blank query', () => {
    const store = new RenameStore(file);
    store.set('claude', 'abc', 'Anything');
    expect(store.matchingKeys('  ')).toEqual([]);
  });
});
