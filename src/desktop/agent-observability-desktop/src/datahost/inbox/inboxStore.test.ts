import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InboxStore } from './inboxStore';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-inbox-store-'));
  file = path.join(dir, 'nested', 'inbox.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('InboxStore', () => {
  it('records the first run immediately, so a restart keeps the same floor', () => {
    const first = new InboxStore(file, () => 1_000);
    expect(first.createdAtMs).toBe(1_000);
    expect(fs.existsSync(file)).toBe(true);
    const second = new InboxStore(file, () => 9_000);
    expect(second.createdAtMs).toBe(1_000);
    expect(second.lastVisitMs).toBe(1_000);
  });

  it('round-trips items, endings and the last visit, leaving no temp file', () => {
    const store = new InboxStore(file, () => 1_000);
    store.save({
      items: { 'claude:a|waiting': { state: 'snoozed', episodeMs: 5, firstSeenMs: 4, snoozedUntilMs: 99 } },
      terminals: { 'claude:a': { event: 'tool-result', failed: true, atMs: 7 } },
      lastVisitMs: 2_000,
    });
    const reopened = new InboxStore(file, () => 3_000);
    expect(reopened.items()).toEqual({
      'claude:a|waiting': { state: 'snoozed', episodeMs: 5, firstSeenMs: 4, snoozedUntilMs: 99 },
    });
    expect(reopened.terminals()).toEqual({ 'claude:a': { event: 'tool-result', failed: true, atMs: 7 } });
    expect(reopened.lastVisitMs).toBe(2_000);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('does not rewrite the file when nothing changed', () => {
    const store = new InboxStore(file, () => 1_000);
    const before = fs.statSync(file).mtimeMs;
    const content = fs.readFileSync(file, 'utf8');
    store.save({ items: {}, terminals: {} });
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('drops malformed entries instead of failing, and starts over from an unreadable file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        createdAtMs: 500,
        items: {
          good: { state: 'seen', episodeMs: 1, firstSeenMs: 1 },
          badState: { state: 'loud', episodeMs: 1, firstSeenMs: 1 },
          badNumber: { state: 'new', episodeMs: 'soon', firstSeenMs: 1 },
          notAnObject: 7,
        },
        terminals: { ok: { event: 'interruption', atMs: 3 }, bad: { event: 'exploded', atMs: 3 } },
      }),
    );
    const store = new InboxStore(file, () => 9_000);
    expect(Object.keys(store.items())).toEqual(['good']);
    expect(store.terminals()).toEqual({ ok: { event: 'interruption', failed: false, atMs: 3 } });
    expect(store.createdAtMs).toBe(500);

    fs.writeFileSync(file, '{ not json');
    expect(new InboxStore(file, () => 9_000).createdAtMs).toBe(9_000);
  });
});
