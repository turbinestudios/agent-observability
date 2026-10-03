import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTranscriptTail, tailText } from './transcriptTail';

function line(n: number, extra = ''): string {
  return JSON.stringify({ type: 'user', n, extra }) + '\n';
}

describe('tailText', () => {
  it('returns the whole buffer when the window started at byte 0', () => {
    expect(tailText(Buffer.from('a\nb\n', 'utf8'), false)).toBe('a\nb\n');
  });

  it('drops the partial first line when the window started mid-file', () => {
    expect(tailText(Buffer.from('tail-of-line\n{"type":"x"}\n', 'utf8'), true)).toBe('{"type":"x"}\n');
  });

  it('returns nothing when a mid-file window holds no newline', () => {
    expect(tailText(Buffer.from('no newline here', 'utf8'), true)).toBe('');
  });
});

describe('readTranscriptTail', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tail-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a whole small file untruncated', () => {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, line(1) + line(2) + line(3));
    const tail = readTranscriptTail(file, 1024 * 1024);
    expect(tail).toBeDefined();
    expect(tail?.truncated).toBe(false);
    expect(tail?.records.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(tail?.skipped).toBe(0);
    expect(tail?.sizeBytes).toBe(fs.statSync(file).size);
    expect(tail?.mtimeMs).toBe(fs.statSync(file).mtimeMs);
  });

  it('drops the partial first line of a truncated window and keeps every later record', () => {
    const file = path.join(dir, 's.jsonl');
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(line(i, 'x'.repeat(40)));
    }
    fs.writeFileSync(file, lines.join(''));
    const size = fs.statSync(file).size;
    // A window that starts somewhere inside line 40.
    const windowBytes = size - Buffer.byteLength(lines.slice(0, 40).join('')) + 10;
    const tail = readTranscriptTail(file, windowBytes);
    expect(tail?.truncated).toBe(true);
    expect(tail?.skipped).toBe(0);
    expect(tail?.records.map((r) => r.n)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
  });

  it('still parses the rest when the cut lands inside a multibyte character', () => {
    const file = path.join(dir, 's.jsonl');
    const first = JSON.stringify({ type: 'user', text: '…'.repeat(100) }) + '\n';
    const rest = line(1) + line(2);
    fs.writeFileSync(file, first + rest);
    // Cut 1 byte into the middle of the first line's ellipsis run (3-byte chars).
    const cut = Buffer.byteLength(rest) + 50 * 3 + 1;
    const tail = readTranscriptTail(file, cut);
    expect(tail?.truncated).toBe(true);
    expect(tail?.records.map((r) => r.n)).toEqual([1, 2]);
    expect(tail?.skipped).toBe(0);
  });

  it('returns undefined for a missing file instead of throwing', () => {
    expect(readTranscriptTail(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  });

  it('handles an empty file', () => {
    const file = path.join(dir, 'e.jsonl');
    fs.writeFileSync(file, '');
    const tail = readTranscriptTail(file);
    expect(tail?.records).toEqual([]);
    expect(tail?.truncated).toBe(false);
    expect(tail?.sizeBytes).toBe(0);
  });

  it('closes the descriptor even when the seam fails mid-read', () => {
    const closed: number[] = [];
    const tail = readTranscriptTail('whatever', 64, {
      openSync: () => 7,
      fstatSync: () => ({ size: 10, mtimeMs: 5 }),
      readSync: () => {
        throw new Error('boom');
      },
      closeSync: (fd) => {
        closed.push(fd);
      },
    });
    expect(tail).toBeUndefined();
    expect(closed).toEqual([7]);
  });
});
