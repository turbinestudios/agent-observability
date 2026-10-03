import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fsWatchFactory } from './fsWatchFactory';

/**
 * Against the real filesystem, since the whole point is the OS watch. Each
 * assertion polls for its condition rather than sleeping a fixed time; the
 * timeout is generous for a loaded runner and nothing asserts on elapsed time.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-watch-'));
  fs.mkdirSync(path.join(dir, 'proj', 'abc', 'subagents'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('fsWatchFactory', () => {
  it(
    'reports a transcript written below the watched tree and ignores other extensions',
    async () => {
      const seen: string[] = [];
      const handle = fsWatchFactory({ recursive: true, extension: '.jsonl' }).watch(dir, (p) => seen.push(p));
      try {
        // Give the OS a moment to arm the watch before writing.
        await new Promise((resolve) => setTimeout(resolve, 200));
        fs.writeFileSync(path.join(dir, 'proj', 'notes.txt'), 'x');
        fs.writeFileSync(path.join(dir, 'proj', 'abc.jsonl'), '{"type":"user"}\n');
        await until(() => seen.some((p) => p.endsWith('abc.jsonl')));
        expect(seen.some((p) => p.endsWith('notes.txt'))).toBe(false);
        expect(seen.every((p) => p.startsWith(path.normalize(dir)))).toBe(true);
      } finally {
        handle.dispose();
      }
    },
    20_000,
  );

  it('disposes without throwing, twice', () => {
    const handle = fsWatchFactory().watch(dir, () => undefined);
    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });

  it('never throws out of the event callback', async () => {
    const handle = fsWatchFactory({ extension: '.jsonl' }).watch(dir, () => {
      throw new Error('handler bug');
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => fs.writeFileSync(path.join(dir, 'x.jsonl'), '{}\n')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      handle.dispose();
    }
  }, 20_000);
});
