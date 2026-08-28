import { describe, it, expect } from 'vitest';
import { describeStatus, downloadingStatus, formatBytes, formatPercent, formatTransfer } from './updates';

describe('downloadingStatus', () => {
  it('passes a normal progress event through', () => {
    expect(
      downloadingStatus('1.2.0', {
        percent: 42.7,
        transferred: 1_000,
        total: 2_000,
        bytesPerSecond: 500,
      }),
    ).toEqual({
      phase: 'downloading',
      version: '1.2.0',
      percent: 42.7,
      transferred: 1_000,
      total: 2_000,
      bytesPerSecond: 500,
    });
  });

  it('turns a NaN percent into 0 rather than a bar of width NaN%', () => {
    const status = downloadingStatus('1.2.0', {
      percent: Number.NaN,
      transferred: 10,
      total: 0,
      bytesPerSecond: 0,
    });

    expect(status.phase === 'downloading' && status.percent).toBe(0);
  });

  it('clamps a percentage that overshoots', () => {
    const over = downloadingStatus('1.2.0', {
      percent: 118,
      transferred: 5,
      total: 4,
      bytesPerSecond: 1,
    });
    const under = downloadingStatus('1.2.0', {
      percent: -3,
      transferred: 0,
      total: 4,
      bytesPerSecond: 1,
    });

    expect(over.phase === 'downloading' && over.percent).toBe(100);
    expect(under.phase === 'downloading' && under.percent).toBe(0);
  });
});

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatBytes(96 * 1024 * 1024)).toBe('96 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('describeStatus', () => {
  const downloading = downloadingStatus('1.2.0', {
    percent: 50,
    transferred: 48 * 1024 * 1024,
    total: 96 * 1024 * 1024,
    bytesPerSecond: 3 * 1024 * 1024,
  });

  it('names the version, the size and the rate', () => {
    expect(describeStatus(downloading)).toBe('Downloading 1.2.0 — 48 MB of 96 MB, 3.0 MB/s');
  });

  it('omits the total when the feed did not report one', () => {
    const noTotal = downloadingStatus('1.2.0', {
      percent: 0,
      transferred: 1024,
      total: 0,
      bytesPerSecond: 0,
    });

    expect(describeStatus(noTotal)).toBe('Downloading 1.2.0 — 1.0 KB');
  });

  it('explains the finished and failed states', () => {
    expect(describeStatus({ phase: 'downloaded', version: '1.2.0' })).toContain('ready');
    expect(describeStatus({ phase: 'failed', message: 'socket hang up' })).toContain('socket hang up');
  });
});

describe('formatTransfer', () => {
  it('names the size and rate the way the tooltip does — shared on purpose', () => {
    const status = downloadingStatus('1.2.0', {
      percent: 50,
      transferred: 12 * 1024 * 1024,
      total: 87 * 1024 * 1024,
      bytesPerSecond: 2.1 * 1024 * 1024,
    });
    expect(status.phase === 'downloading' && formatTransfer(status)).toBe('12 MB of 87 MB, 2.1 MB/s');
    expect(describeStatus(status)).toContain(formatTransfer(status as never));
  });

  it('degrades to what is known when the feed reports no total or rate', () => {
    const status = downloadingStatus('1.2.0', {
      percent: 0,
      transferred: 5 * 1024,
      total: 0,
      bytesPerSecond: 0,
    });
    expect(status.phase === 'downloading' && formatTransfer(status)).toBe('5.0 KB');
  });
});

describe('formatPercent', () => {
  it('rounds to whole percent, and is empty when nothing is downloading', () => {
    const status = downloadingStatus('1.2.0', {
      percent: 42.7,
      transferred: 1,
      total: 2,
      bytesPerSecond: 1,
    });

    expect(formatPercent(status)).toBe('43%');
    expect(formatPercent({ phase: 'downloaded', version: '1.2.0' })).toBe('');
  });
});
