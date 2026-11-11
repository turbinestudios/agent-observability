import { describe, expect, it } from 'vitest';
import { droppedShareFile, formatBytes, importNotice, isSharedSession, shareRedactionNote } from './share';

describe('share helpers', () => {
  it('formats sizes without locale', () => {
    expect(formatBytes(812)).toBe('812 bytes');
    expect(formatBytes(14 * 1024)).toBe('14 KB');
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3.2 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatBytes(Number.NaN)).toBe('');
  });

  it('always calls redaction best effort', () => {
    expect(shareRedactionNote(0)).toContain('No secret-looking strings were found.');
    expect(shareRedactionNote(1)).toContain('1 secret-looking string was replaced.');
    expect(shareRedactionNote(3)).toContain('3 secret-looking strings were replaced.');
    for (const count of [0, 1, 3]) {
      expect(shareRedactionNote(count)).toContain('best effort');
    }
  });

  it('picks the first JSON file from a drop', () => {
    expect(droppedShareFile([{ name: 'a.png' }, { name: 'S.AOSESSION.JSON' }])?.name).toBe('S.AOSESSION.JSON');
    expect(droppedShareFile([{ name: 'a.png' }])).toBeUndefined();
  });

  it('knows an imported session and says what an import did', () => {
    expect(isSharedSession('shared')).toBe(true);
    expect(isSharedSession('claude')).toBe(false);
    expect(importNotice(true)).toContain('Updated');
    expect(importNotice(false)).toContain('Compare');
  });
});
