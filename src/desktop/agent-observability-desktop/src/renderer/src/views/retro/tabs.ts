/**
 * The Evidence view's tabs: which exist, what they are called, and which one
 * was open last. Split from the view so it tests under the node-only vitest
 * setup, like `views/overview/window.ts`.
 *
 * Adding a tab is one entry in {@link EVIDENCE_TABS} plus its component in
 * `RetroView.tsx`; the completion check and rework proposals each add one.
 */

export type EvidenceTabId = 'retrospectives' | 'completion' | 'tools' | 'rework';

export interface EvidenceTab {
  id: EvidenceTabId;
  label: string;
  /** One line under the tab strip saying what the tab answers. */
  hint: string;
}

export const EVIDENCE_TABS: readonly EvidenceTab[] = [
  {
    id: 'retrospectives',
    label: 'Retrospectives',
    hint: 'How each session went, worst first.',
  },
  {
    id: 'completion',
    label: 'Completion',
    hint: 'Whether a check was seen after the last code edit, and how it ended.',
  },
  {
    id: 'tools',
    label: 'Tools',
    hint: 'Which tools your agents call, how often they fail and how long they take.',
  },
  {
    id: 'rework',
    label: 'Rework',
    hint: 'Sessions that kept going back over the same files. A signal, not a score.',
  },
];

export const DEFAULT_EVIDENCE_TAB: EvidenceTabId = 'retrospectives';

const STORAGE_KEY = 'agent-observability.evidenceTab';

/** Narrow an untrusted value to a tab, falling back to the default. */
export function toEvidenceTab(value: unknown): EvidenceTabId {
  return EVIDENCE_TABS.some((tab) => tab.id === value) ? (value as EvidenceTabId) : DEFAULT_EVIDENCE_TAB;
}

/** Best-effort, like the theme and the Dashboard window: no storage, no memory. */
export function readStoredTab(): EvidenceTabId {
  try {
    return toEvidenceTab(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_EVIDENCE_TAB;
  }
}

export function persistTab(tab: EvidenceTabId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    // Storage unavailable; the choice still applies for this run.
  }
}

/** The tab reached by an arrow key from `current`, wrapping at both ends. */
export function neighbourTab(current: EvidenceTabId, direction: 1 | -1): EvidenceTabId {
  const index = EVIDENCE_TABS.findIndex((tab) => tab.id === current);
  const next = (index + direction + EVIDENCE_TABS.length) % EVIDENCE_TABS.length;
  return EVIDENCE_TABS[next].id;
}
