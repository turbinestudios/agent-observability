import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { copilotFingerprint } from './copilotFingerprint';

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copilot-fingerprint-'));
  file = path.join(root, 'source.db');
  fs.writeFileSync(file, 'synthetic database');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('copilotFingerprint', () => {
  it('is stable while neither the database nor its WAL changes', () => {
    const before = copilotFingerprint(file);
    expect(before).toBeDefined();
    expect(copilotFingerprint(file)).toBe(before);
  });

  it('includes the database timestamp even when the size is unchanged', () => {
    const before = copilotFingerprint(file);
    const timestamp = new Date(2000, 0, 1);
    fs.utimesSync(file, timestamp, timestamp);
    expect(copilotFingerprint(file)).not.toBe(before);
  });

  it('includes WAL creation, growth, and removal without a main-file write', () => {
    const main = fs.statSync(file);
    const withoutWal = copilotFingerprint(file);
    fs.writeFileSync(`${file}-wal`, 'first transaction');
    const first = copilotFingerprint(file);
    expect(first).not.toBe(withoutWal);
    fs.appendFileSync(`${file}-wal`, 'second transaction');
    expect(copilotFingerprint(file)).not.toBe(first);
    expect(fs.statSync(file).mtimeMs).toBe(main.mtimeMs);
    fs.rmSync(`${file}-wal`);
    expect(copilotFingerprint(file)).toBe(withoutWal);
  });

  it('ignores SHM changes made by readers', () => {
    const before = copilotFingerprint(file);
    fs.writeFileSync(`${file}-shm`, 'reader state');
    expect(copilotFingerprint(file)).toBe(before);
  });

  it('includes source identity rather than comparing only size and mtime', () => {
    const other = path.join(root, 'replacement.db');
    fs.copyFileSync(file, other);
    const timestamp = new Date(2000, 0, 1);
    fs.utimesSync(file, timestamp, timestamp);
    fs.utimesSync(other, timestamp, timestamp);
    expect(copilotFingerprint(other)).not.toBe(copilotFingerprint(file));
  });

  it('returns unknown for an absent database or non-file sidecar', () => {
    expect(copilotFingerprint(path.join(root, 'absent.db'))).toBeUndefined();
    fs.mkdirSync(`${file}-wal`);
    expect(copilotFingerprint(file)).toBeUndefined();
  });
});