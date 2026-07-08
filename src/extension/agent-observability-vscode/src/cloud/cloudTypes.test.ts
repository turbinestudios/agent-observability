import { describe, it, expect } from 'vitest';
import {
  cloudRepoId,
  cloudStateLabel,
  isTerminalCloudState,
  normalizeEpochMs,
  rfc3339ToMs,
  stripCloudModelPrefix,
} from './cloudTypes';

describe('normalizeEpochMs', () => {
  it('scales a unix-seconds value up to ms', () => {
    // 1_700_000_000s ≈ 2023-11-14; the common SSE `created` magnitude.
    expect(normalizeEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('keeps a value already in ms (> 1e12) as-is', () => {
    expect(normalizeEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(normalizeEpochMs(2_500_000_000_000)).toBe(2_500_000_000_000);
  });

  it('floors fractional seconds after scaling', () => {
    // 1_700_000_000.5s → 1_700_000_000_500ms exactly (already integral).
    expect(normalizeEpochMs(1_700_000_000.5)).toBe(1_700_000_000_500);
    // A value whose *1000 has a fractional remainder must be floored.
    expect(normalizeEpochMs(1_700_000_000.0009)).toBe(Math.floor(1_700_000_000.0009 * 1000));
  });

  it('floors an already-ms value (no scaling) via Math.floor', () => {
    expect(normalizeEpochMs(1_700_000_000_000.9)).toBe(1_700_000_000_000);
  });

  it('treats the 1e12 boundary as seconds (not > 1e12)', () => {
    // Exactly 1e12 is NOT > 1e12, so it is scaled as seconds.
    expect(normalizeEpochMs(1e12)).toBe(1e15);
  });

  it('returns undefined for undefined', () => {
    expect(normalizeEpochMs(undefined)).toBeUndefined();
  });

  it('returns undefined for zero and negative values', () => {
    expect(normalizeEpochMs(0)).toBeUndefined();
    expect(normalizeEpochMs(-1)).toBeUndefined();
    expect(normalizeEpochMs(-1_700_000_000)).toBeUndefined();
  });

  it('returns undefined for non-finite values', () => {
    expect(normalizeEpochMs(Number.NaN)).toBeUndefined();
    expect(normalizeEpochMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeEpochMs(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });
});

describe('stripCloudModelPrefix', () => {
  it('strips the CAPI provider prefix at the first colon', () => {
    expect(stripCloudModelPrefix('sweagent-capi:claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
  });

  it('passes through a value with no colon unchanged', () => {
    expect(stripCloudModelPrefix('claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
  });

  it('splits only on the first colon, keeping later colons', () => {
    expect(stripCloudModelPrefix('prefix:sub:model')).toBe('sub:model');
  });

  it('trims surrounding whitespace before splitting', () => {
    expect(stripCloudModelPrefix('  sweagent-capi:claude-sonnet-4.6  ')).toBe('claude-sonnet-4.6');
    expect(stripCloudModelPrefix('  claude-opus  ')).toBe('claude-opus');
  });

  it('returns "unknown" for undefined', () => {
    expect(stripCloudModelPrefix(undefined)).toBe('unknown');
  });

  it('returns "unknown" for empty / whitespace-only input', () => {
    expect(stripCloudModelPrefix('')).toBe('unknown');
    expect(stripCloudModelPrefix('   ')).toBe('unknown');
  });

  it('returns "unknown" for a literal "unknown" (case-insensitive)', () => {
    expect(stripCloudModelPrefix('unknown')).toBe('unknown');
    expect(stripCloudModelPrefix('UNKNOWN')).toBe('unknown');
    expect(stripCloudModelPrefix('  Unknown  ')).toBe('unknown');
  });
});

describe('rfc3339ToMs', () => {
  it('parses a plain UTC RFC3339 timestamp to epoch ms', () => {
    expect(rfc3339ToMs('2026-07-07T12:00:00Z')).toBe(Date.UTC(2026, 6, 7, 12, 0, 0));
  });

  it('parses millisecond precision', () => {
    expect(rfc3339ToMs('2026-07-07T12:00:00.123Z')).toBe(Date.UTC(2026, 6, 7, 12, 0, 0, 123));
  });

  it('parses nanosecond precision, truncating to ms', () => {
    // The extra sub-millisecond digits are dropped; only .123 survives.
    expect(rfc3339ToMs('2026-07-07T12:00:00.123456789Z')).toBe(
      Date.UTC(2026, 6, 7, 12, 0, 0, 123),
    );
  });

  it('honours a timezone offset', () => {
    // 12:00:00+02:00 == 10:00:00Z.
    expect(rfc3339ToMs('2026-07-07T12:00:00+02:00')).toBe(Date.UTC(2026, 6, 7, 10, 0, 0));
  });

  it('returns undefined for undefined', () => {
    expect(rfc3339ToMs(undefined)).toBeUndefined();
  });

  it('returns undefined for the empty string', () => {
    expect(rfc3339ToMs('')).toBeUndefined();
  });

  it('returns undefined for an unparseable string', () => {
    expect(rfc3339ToMs('not-a-date')).toBeUndefined();
    expect(rfc3339ToMs('2026-13-99T99:99:99Z')).toBeUndefined();
  });
});

describe('cloudRepoId', () => {
  it('extracts the id from the object shape { id } (current preview API)', () => {
    expect(cloudRepoId({ id: 1199256812 })).toBe(1199256812);
    expect(cloudRepoId({ id: '1199256812' })).toBe(1199256812);
  });

  it('accepts a bare number or numeric string', () => {
    expect(cloudRepoId(999)).toBe(999);
    expect(cloudRepoId('999')).toBe(999);
  });

  it('returns undefined for missing / null / non-numeric / empty values', () => {
    expect(cloudRepoId(undefined)).toBeUndefined();
    expect(cloudRepoId(null)).toBeUndefined();
    expect(cloudRepoId({})).toBeUndefined();
    expect(cloudRepoId({ id: undefined })).toBeUndefined();
    expect(cloudRepoId('not-a-number')).toBeUndefined();
    expect(cloudRepoId('')).toBeUndefined();
  });
});

describe('isTerminalCloudState', () => {
  it.each(['completed', 'failed', 'cancelled', 'timed_out'])(
    'is terminal for %s',
    (state) => {
      expect(isTerminalCloudState(state)).toBe(true);
    },
  );

  it.each(['queued', 'in_progress', 'idle', 'waiting_for_user'])(
    'is not terminal for active state %s',
    (state) => {
      expect(isTerminalCloudState(state)).toBe(false);
    },
  );

  it('is not terminal for undefined', () => {
    expect(isTerminalCloudState(undefined)).toBe(false);
  });

  it('is not terminal for an unrecognized state', () => {
    expect(isTerminalCloudState('bogus')).toBe(false);
    expect(isTerminalCloudState('')).toBe(false);
  });
});

describe('cloudStateLabel', () => {
  it('returns undefined for the plain completed state (no badge)', () => {
    expect(cloudStateLabel('completed')).toBeUndefined();
  });

  it.each([
    ['queued', 'queued'],
    ['in_progress', 'in progress'],
    ['idle', 'idle'],
    ['waiting_for_user', 'waiting for user'],
    ['failed', 'failed'],
    ['timed_out', 'timed out'],
    ['cancelled', 'cancelled'],
  ])('labels %s as "%s"', (state, label) => {
    expect(cloudStateLabel(state)).toBe(label);
  });

  it('returns undefined for undefined (default branch)', () => {
    expect(cloudStateLabel(undefined)).toBeUndefined();
  });

  it('returns undefined for an unrecognized state (default branch)', () => {
    expect(cloudStateLabel('bogus')).toBeUndefined();
    expect(cloudStateLabel('')).toBeUndefined();
  });
});
