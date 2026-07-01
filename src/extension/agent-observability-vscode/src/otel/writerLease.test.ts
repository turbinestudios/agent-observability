import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriterLease, WriterLeaseClock } from './writerLease';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/** A hand-cranked clock. */
function clockAt(t: { ms: number }): WriterLeaseClock {
  return { now: () => t.ms };
}

describe('WriterLease', () => {
  it('acquires on an empty dir and creates the lock file', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    const lock = path.join(tmp, 'writer.lock');
    const lease = new WriterLease(lock, 90_000);
    expect(lease.tryAcquire()).toBe(true);
    expect(lease.isHeld).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  it('a second lease cannot acquire while the first holds a fresh lock', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    const lock = path.join(tmp, 'writer.lock');
    const t = { ms: 1000 };
    const a = new WriterLease(lock, 90_000, clockAt(t), 111, 'hostA');
    const b = new WriterLease(lock, 90_000, clockAt(t), 222, 'hostB');
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(b.isHeld).toBe(false);
  });

  it('reclaims a stale lock past staleMs', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    const lock = path.join(tmp, 'writer.lock');
    const t = { ms: 1000 };
    const a = new WriterLease(lock, 90_000, clockAt(t), 111, 'hostA');
    const b = new WriterLease(lock, 90_000, clockAt(t), 222, 'hostB');
    expect(a.tryAcquire()).toBe(true);

    // b still can't take a fresh lock...
    expect(b.tryAcquire()).toBe(false);
    // ...but once a's heartbeat is older than staleMs, b reclaims it.
    t.ms = 1000 + 90_001;
    expect(b.tryAcquire()).toBe(true);
    expect(b.isHeld).toBe(true);
  });

  it('a held lease steps down on heartbeat if it was preempted (no split-brain)', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    const lock = path.join(tmp, 'writer.lock');
    const t = { ms: 1000 };
    const a = new WriterLease(lock, 90_000, clockAt(t), 111, 'hostA');
    const b = new WriterLease(lock, 90_000, clockAt(t), 222, 'hostB');
    expect(a.tryAcquire()).toBe(true);
    // a goes stale and b takes over.
    t.ms += 90_001;
    expect(b.tryAcquire()).toBe(true);
    // a wakes up and tries to heartbeat/re-acquire → must NOT reclaim; it steps down.
    expect(a.tryAcquire()).toBe(false);
    expect(a.isHeld).toBe(false);
    expect(b.isHeld).toBe(true);
  });

  it('release removes the lock so another instance can acquire immediately', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    const lock = path.join(tmp, 'writer.lock');
    const t = { ms: 1000 };
    const a = new WriterLease(lock, 90_000, clockAt(t), 111, 'hostA');
    const b = new WriterLease(lock, 90_000, clockAt(t), 222, 'hostB');
    expect(a.tryAcquire()).toBe(true);
    a.release();
    expect(a.isHeld).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(b.tryAcquire()).toBe(true);
  });

  it('release does not delete a successor’s lock', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    const lock = path.join(tmp, 'writer.lock');
    const t = { ms: 1000 };
    const a = new WriterLease(lock, 90_000, clockAt(t), 111, 'hostA');
    const b = new WriterLease(lock, 90_000, clockAt(t), 222, 'hostB');
    expect(a.tryAcquire()).toBe(true);
    t.ms += 90_001;
    expect(b.tryAcquire()).toBe(true); // b reclaimed
    a.release(); // a thinks it held; must not remove b's lock
    expect(existsSync(lock)).toBe(true);
  });
});
