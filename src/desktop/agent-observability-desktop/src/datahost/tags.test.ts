import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_TAGS_PER_SESSION, MAX_TAG_LENGTH, TagStore } from './tags';
import type { SessionRow } from '../shared/rpc';

/**
 * Tags are user-authored data the index cannot rebuild, so what matters most
 * here is the same thing that matters for renames: they survive independently
 * of the index. Beyond that, the interesting behaviour is normalization — one
 * tag written two ways has to be one tag, or it filters as one and displays as
 * two.
 */

let dir: string;
let file: string;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'github.com/acme/app',
    title: 'A session',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tags-'));
  file = path.join(dir, 'tags.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('setting and clearing', () => {
  it('stores tags and reads them back', () => {
    const store = new TagStore(file);
    expect(store.set('claude', 'abc', ['experiment-A', 'baseline'])).toEqual([
      'experiment-A',
      'baseline',
    ]);
    expect(store.get('claude', 'abc')).toEqual(['experiment-A', 'baseline']);
  });

  it('reads an untagged session as an empty list, not undefined', () => {
    expect(new TagStore(file).get('claude', 'never')).toEqual([]);
  });

  it('replaces rather than merges, so removing a tag actually removes it', () => {
    const store = new TagStore(file);
    store.set('claude', 'abc', ['keep', 'drop']);
    store.set('claude', 'abc', ['keep']);
    expect(store.get('claude', 'abc')).toEqual(['keep']);
  });

  it('clears on an empty list and forgets the session entirely', () => {
    const store = new TagStore(file);
    store.set('claude', 'abc', ['temporary']);
    expect(store.set('claude', 'abc', [])).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('clearing something never tagged is a no-op', () => {
    const store = new TagStore(file);
    expect(store.set('claude', 'never', [])).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('keeps sources separate for the same session id', () => {
    const store = new TagStore(file);
    store.set('claude', 'same-id', ['from-claude']);
    store.set('copilot', 'same-id', ['from-copilot']);
    expect(store.get('claude', 'same-id')).toEqual(['from-claude']);
    expect(store.get('copilot', 'same-id')).toEqual(['from-copilot']);
  });
});

describe('normalization', () => {
  it('trims and drops blanks', () => {
    const store = new TagStore(file);
    expect(store.set('claude', 'a', ['  padded  ', '', '   '])).toEqual(['padded']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    // Otherwise "Bad-Run" and "bad-run" filter as one tag and display as two.
    const store = new TagStore(file);
    expect(store.set('claude', 'a', ['Bad-Run', 'bad-run', 'BAD-RUN'])).toEqual(['Bad-Run']);
  });

  it('caps the length of a tag', () => {
    const store = new TagStore(file);
    const [tag] = store.set('claude', 'a', ['x'.repeat(MAX_TAG_LENGTH + 50)]);
    expect(tag).toHaveLength(MAX_TAG_LENGTH);
  });

  it('caps how many tags one session can carry', () => {
    const store = new TagStore(file);
    const many = Array.from({ length: MAX_TAGS_PER_SESSION + 10 }, (_, i) => `t${i}`);
    expect(store.set('claude', 'a', many)).toHaveLength(MAX_TAGS_PER_SESSION);
  });
});

describe('persistence', () => {
  it('survives a restart', () => {
    new TagStore(file).set('claude', 'abc', ['kept']);
    expect(new TagStore(file).get('claude', 'abc')).toEqual(['kept']);
  });

  it('starts empty when no file exists yet', () => {
    expect(new TagStore(path.join(dir, 'absent.json')).size()).toBe(0);
  });

  it('degrades to no tags on an unparsable file rather than throwing', () => {
    fs.writeFileSync(file, '{ not json');
    expect(new TagStore(file).size()).toBe(0);
  });

  it('ignores entries that are not usable tag lists', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        'claude:a': ['good'],
        'claude:b': 'not-a-list',
        'claude:c': [],
        'claude:d': [42, null, 'salvaged'],
      }),
    );
    const store = new TagStore(file);
    expect(store.get('claude', 'a')).toEqual(['good']);
    expect(store.get('claude', 'b')).toEqual([]);
    expect(store.get('claude', 'c')).toEqual([]);
    expect(store.get('claude', 'd')).toEqual(['salvaged']);
  });

  it('creates the directory when saving for the first time', () => {
    const nested = path.join(dir, 'deep', 'tags.json');
    new TagStore(nested).set('claude', 'abc', ['made-a-path']);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('filtering by tag', () => {
  it('returns the keys carrying a tag, matched case-insensitively', () => {
    const store = new TagStore(file);
    store.set('claude', 'a', ['Experiment-A']);
    store.set('copilot', 'b', ['experiment-a']);
    store.set('claude', 'c', ['baseline']);
    expect(store.keysFor('EXPERIMENT-A').sort()).toEqual(['claude:a', 'copilot:b']);
  });

  it('returns nothing for a tag nobody carries, and for a blank one', () => {
    const store = new TagStore(file);
    store.set('claude', 'a', ['real']);
    expect(store.keysFor('imaginary')).toEqual([]);
    expect(store.keysFor('  ')).toEqual([]);
  });
});

describe('listing tags', () => {
  it('counts sessions per tag, most used first', () => {
    const store = new TagStore(file);
    store.set('claude', 'a', ['common', 'rare']);
    store.set('claude', 'b', ['common']);
    store.set('claude', 'c', ['common']);
    expect(store.list()).toEqual([
      { tag: 'common', count: 3 },
      { tag: 'rare', count: 1 },
    ]);
  });

  it('folds spellings into one tag, labelled the way it is usually written', () => {
    const store = new TagStore(file);
    store.set('claude', 'a', ['Experiment-A']);
    store.set('claude', 'b', ['experiment-a']);
    store.set('claude', 'c', ['experiment-a']);
    expect(store.list()).toEqual([{ tag: 'experiment-a', count: 3 }]);
  });

  it('breaks count ties by name, so the order is stable between runs', () => {
    const store = new TagStore(file);
    store.set('claude', 'a', ['zebra', 'alpha']);
    expect(store.list().map((t) => t.tag)).toEqual(['alpha', 'zebra']);
  });

  it('leaves out excluded sessions, so a count matches what selecting it shows', () => {
    const store = new TagStore(file);
    store.set('claude', 'shown', ['t']);
    store.set('claude', 'gone', ['t']);
    expect(store.list(['claude:gone'])).toEqual([{ tag: 't', count: 1 }]);
  });

  it('is empty when nothing is tagged', () => {
    expect(new TagStore(file).list()).toEqual([]);
  });
});

describe('applying to rows', () => {
  it('attaches tags to the matching row only', () => {
    const store = new TagStore(file);
    store.set('claude', 'abc', ['experiment-A']);

    const rows = store.apply([row({ sessionId: 'abc' }), row({ sessionId: 'other' })]);
    expect(rows[0].tags).toEqual(['experiment-A']);
    expect(rows[1].tags).toBeUndefined();
  });

  it('returns the input untouched when nothing is tagged', () => {
    const input = [row({ sessionId: 'abc' })];
    expect(new TagStore(file).apply(input)).toBe(input);
  });
});
