import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_NOTE_LENGTH, NoteStore } from './notes';
import type { SessionRow } from '../shared/rpc';

/**
 * A note is the only place the *why* of a run is kept, and the index cannot
 * rebuild it — so the tests that matter are that it survives a restart, that
 * clearing it really clears it, and that a list row learns a note EXISTS
 * without carrying its text.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-notes-'));
  file = path.join(dir, 'notes.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('setting and clearing', () => {
  it('stores a note and reads it back', () => {
    const store = new NoteStore(file);
    const text = 'Went sideways after it ignored the test instruction.';
    expect(store.set('claude', 'abc', text)).toBe(text);
    expect(store.get('claude', 'abc')).toBe(text);
  });

  it('reads a session with no note as an empty string', () => {
    const store = new NoteStore(file);
    expect(store.get('claude', 'never')).toBe('');
    expect(store.has('claude', 'never')).toBe(false);
  });

  it('trims the ends but keeps the blank lines between paragraphs', () => {
    const store = new NoteStore(file);
    expect(store.set('claude', 'abc', '\n  First.\n\nSecond.  \n')).toBe('First.\n\nSecond.');
  });

  it('clears on blank text and forgets the session entirely', () => {
    const store = new NoteStore(file);
    store.set('claude', 'abc', 'temporary');
    expect(store.set('claude', 'abc', '   ')).toBe('');
    expect(store.has('claude', 'abc')).toBe(false);
    expect(store.size()).toBe(0);
  });

  it('clearing something never noted is a no-op', () => {
    const store = new NoteStore(file);
    expect(store.set('claude', 'never', '')).toBe('');
    expect(store.size()).toBe(0);
  });

  it('caps a note that was pasted rather than written', () => {
    const store = new NoteStore(file);
    expect(store.set('claude', 'abc', 'x'.repeat(MAX_NOTE_LENGTH + 500))).toHaveLength(
      MAX_NOTE_LENGTH,
    );
  });

  it('keeps sources separate for the same session id', () => {
    const store = new NoteStore(file);
    store.set('claude', 'same-id', 'from Claude');
    store.set('copilot', 'same-id', 'from Copilot');
    expect(store.get('claude', 'same-id')).toBe('from Claude');
    expect(store.get('copilot', 'same-id')).toBe('from Copilot');
  });
});

describe('persistence', () => {
  it('survives a restart', () => {
    new NoteStore(file).set('claude', 'abc', 'kept');
    expect(new NoteStore(file).get('claude', 'abc')).toBe('kept');
  });

  it('starts empty when no file exists yet', () => {
    expect(new NoteStore(path.join(dir, 'absent.json')).size()).toBe(0);
  });

  it('degrades to no notes on an unparsable file rather than throwing', () => {
    fs.writeFileSync(file, '{ not json');
    expect(new NoteStore(file).size()).toBe(0);
  });

  it('ignores entries that are not usable note text', () => {
    // A blank entry would put an indicator on a row and an empty editor behind
    // it, which is worse than having no note at all.
    fs.writeFileSync(
      file,
      JSON.stringify({ 'claude:a': 'good', 'claude:b': '', 'claude:c': 42, 'claude:d': null }),
    );
    const store = new NoteStore(file);
    expect(store.size()).toBe(1);
    expect(store.get('claude', 'a')).toBe('good');
  });

  it('creates the directory when saving for the first time', () => {
    const nested = path.join(dir, 'deep', 'notes.json');
    new NoteStore(nested).set('claude', 'abc', 'made a path');
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('applying to rows', () => {
  it('marks that a note exists without carrying its text', () => {
    const store = new NoteStore(file);
    store.set('claude', 'abc', 'the why');

    const rows = store.apply([row({ sessionId: 'abc' }), row({ sessionId: 'other' })]);
    expect(rows[0].hasNote).toBe(true);
    expect(rows[1].hasNote).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('the why');
  });

  it('returns the input untouched when nothing is noted', () => {
    const input = [row({ sessionId: 'abc' })];
    expect(new NoteStore(file).apply(input)).toBe(input);
  });
});
