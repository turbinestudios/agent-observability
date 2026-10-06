import { describe, expect, it } from 'vitest';
import { DEFAULT_EVIDENCE_TAB, EVIDENCE_TABS, neighbourTab, readStoredTab, toEvidenceTab } from './tabs';

describe('evidence tabs', () => {
  it('opens on Retrospectives, then Completion, then Tools', () => {
    expect(DEFAULT_EVIDENCE_TAB).toBe('retrospectives');
    expect(EVIDENCE_TABS.map((tab) => tab.id)).toEqual(['retrospectives', 'completion', 'tools', 'rework']);
    expect(EVIDENCE_TABS.every((tab) => tab.label.length > 0 && tab.hint.length > 0)).toBe(true);
  });

  it('narrows anything unknown to the default', () => {
    expect(toEvidenceTab('tools')).toBe('tools');
    expect(toEvidenceTab('not-a-tab')).toBe(DEFAULT_EVIDENCE_TAB);
    expect(toEvidenceTab(null)).toBe(DEFAULT_EVIDENCE_TAB);
  });

  it('falls back to the default where storage is unavailable', () => {
    // The node test environment has no window; the read must not throw.
    expect(readStoredTab()).toBe(DEFAULT_EVIDENCE_TAB);
  });

  it('moves between neighbours with wrap-around', () => {
    const first = EVIDENCE_TABS[0].id;
    const last = EVIDENCE_TABS[EVIDENCE_TABS.length - 1].id;
    expect(neighbourTab(first, -1)).toBe(last);
    expect(neighbourTab(last, 1)).toBe(first);
    expect(neighbourTab(first, 1)).toBe(EVIDENCE_TABS[1].id);
  });
});
