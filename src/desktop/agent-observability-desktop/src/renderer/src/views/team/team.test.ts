import { describe, expect, it } from 'vitest';
import {
  costBasisNote,
  deltaLabel,
  emptyState,
  folderStateLabel,
  groupThousands,
  problemLabel,
  shortDay,
  shortDeveloperId,
  staleLabel,
  teamWindowLabel,
} from './team';

describe('shortDeveloperId', () => {
  it('keeps the prefix and the first eight hex characters', () => {
    expect(shortDeveloperId('dev_0123456789abcdef0123456789abcdef')).toBe('dev_01234567…');
  });
});

describe('staleLabel', () => {
  it('says when the shard was shared and marks stale ones', () => {
    const now = 40 * 86_400_000;
    expect(staleLabel({ generatedAtMs: now - 5 * 60_000, stale: false }, now)).toBe('shared 5m');
    expect(staleLabel({ generatedAtMs: now - 10_000, stale: false }, now)).toBe('shared just now');
    expect(staleLabel({ generatedAtMs: now - 3 * 86_400_000, stale: true }, now)).toBe('shared 3d · stale');
  });
});

describe('folderStateLabel', () => {
  it('names every folder state and distinguishes the watch mode', () => {
    expect(folderStateLabel({ folderState: 'unset', watchMode: 'off' })).toBe('No team folder chosen');
    expect(folderStateLabel({ folderState: 'missing', watchMode: 'poll' })).toContain('not found');
    expect(folderStateLabel({ folderState: 'unreadable', watchMode: 'poll' })).toContain('could not be read');
    expect(folderStateLabel({ folderState: 'ok', watchMode: 'events+poll' })).toBe('Watching the team folder');
    expect(folderStateLabel({ folderState: 'ok', watchMode: 'poll' })).toContain('every minute');
  });
});

describe('emptyState', () => {
  const me = { developerId: 'dev_a', isMe: true } as never;
  const other = { developerId: 'dev_b', isMe: false } as never;
  it('picks no-folder, no-shards, only-me, or nothing', () => {
    expect(emptyState({ folderState: 'unset', memberCount: 0 }, undefined)).toBe('no-folder');
    expect(emptyState({ folderState: 'ok', memberCount: 0 }, { members: [] })).toBe('no-shards');
    expect(emptyState({ folderState: 'ok', memberCount: 1 }, { members: [me] })).toBe('only-me');
    expect(emptyState({ folderState: 'ok', memberCount: 2 }, { members: [me, other] })).toBeUndefined();
    expect(emptyState({ folderState: 'missing', memberCount: 0 }, undefined)).toBe('no-shards');
  });
});

describe('problemLabel', () => {
  it('explains every skip reason in words', () => {
    expect(problemLabel({ fileName: 'x', reason: 'unknown-schema-version' })).toContain('newer version');
    expect(problemLabel({ fileName: 'x', reason: 'invalid' })).toBe('Skipped: not a valid team file');
    expect(problemLabel({ fileName: 'x', reason: 'id-mismatch' })).toContain('does not match its id');
    expect(problemLabel({ fileName: 'x', reason: 'too-large' })).toContain('too large');
    expect(problemLabel({ fileName: 'x', reason: 'unreadable' })).toBe('Could not be read yet');
  });
});

describe('deltaLabel', () => {
  it('formats the relative difference by hand', () => {
    expect(deltaLabel(112, 100)).toBe('+12%');
    expect(deltaLabel(95, 100)).toBe('-5%');
    expect(deltaLabel(100, 100)).toBe('same');
    expect(deltaLabel(0, 0)).toBe('same');
    expect(deltaLabel(5, 0)).toBe('n/a');
  });
});

describe('costBasisNote', () => {
  it('names a single basis, lists mixed ones, and says when nothing is priced', () => {
    expect(costBasisNote({ usd: 10, aiu: 0, credits: 0 })).toBe('All members price in USD');
    expect(costBasisNote({ usd: 12, aiu: 3, credits: 0 })).toBe(
      'Mixed billing bases: 12 in USD, 3 in AIU — totals are summed as US dollars',
    );
    expect(costBasisNote({ usd: 0, aiu: 0, credits: 0 })).toBe('No priced sessions yet');
  });
});

describe('labels and numbers', () => {
  it('labels windows, shortens days by slicing and groups thousands by hand', () => {
    expect(teamWindowLabel(7)).toBe('7d');
    expect(shortDay('2026-10-03')).toBe('10-03');
    expect(shortDay('bad')).toBe('bad');
    expect(groupThousands(1234567)).toBe('1,234,567');
    expect(groupThousands(999)).toBe('999');
  });
});
