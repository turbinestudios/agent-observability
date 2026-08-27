import type { JSX } from 'react';
import type { SessionGroup } from '../../../../shared/rpc';
import { sourceLabel } from './format';

/**
 * Narrows the list to one agent tool.
 *
 * The choices are fixed rather than derived from what happens to be indexed, so
 * the filter does not appear and disappear between runs — a source with no
 * sessions yet shows a zero, which answers "is Copilot being picked up?" that
 * an absent chip would leave open. Any source found in the index but not listed
 * here is appended, so a new one is never silently unreachable.
 */

const KNOWN_SOURCES = ['claude', 'copilot'];

interface Props {
  groups: SessionGroup[];
  /** `undefined` means All. */
  active: string | undefined;
  onSelect: (source: string | undefined) => void;
  hiddenCount: number;
  showingHidden: boolean;
  onToggleHidden: () => void;
}

export function SourceFilter({
  groups,
  active,
  onSelect,
  hiddenCount,
  showingHidden,
  onToggleHidden,
}: Props): JSX.Element {
  const counts = new Map<string, number>();
  for (const group of groups) {
    counts.set(group.source, (counts.get(group.source) ?? 0) + group.count);
  }
  const extras = [...counts.keys()].filter((s) => !KNOWN_SOURCES.includes(s)).sort();
  const sources = [...KNOWN_SOURCES, ...extras];
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  return (
    <div className="source-filter" role="group" aria-label="Filter by source">
      <Chip label="All" count={total} selected={active === undefined} onClick={() => onSelect(undefined)} />
      {sources.map((id) => (
        <Chip
          key={id}
          label={sourceLabel(id)}
          count={counts.get(id) ?? 0}
          selected={active === id}
          onClick={() => onSelect(id)}
        />
      ))}
      {/*
        Only offered once something is hidden — otherwise it is a control that
        does nothing, and it would imply sessions are missing when none are.
      */}
      {hiddenCount > 0 && (
        <Chip
          label="Hidden"
          count={hiddenCount}
          selected={showingHidden}
          onClick={onToggleHidden}
        />
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="filter-chip" aria-pressed={selected} onClick={onClick}>
      {label}
      <span className="filter-count">{count.toLocaleString()}</span>
    </button>
  );
}
