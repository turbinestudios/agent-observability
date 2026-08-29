import type { JSX } from 'react';
import type { SessionGroup } from '../../../../shared/rpc';
import type { FilterChip, FilterKey } from './filters';
import { sourceLabel } from './format';

/**
 * Narrows the list, in rows that answer different questions:
 * WHICH TOOL (All / Claude Code / Copilot) on the first, WHAT STATE
 * (Flagged / Struggled / Hidden) on the second — mixing them in one strip read
 * as if "Flagged" were a source — and, when any are set, what the filter panel
 * is currently narrowing to on a third.
 *
 * The source choices are fixed rather than derived from what happens to be
 * indexed, so the filter does not appear and disappear between runs — a source
 * with no sessions yet shows a zero, which answers "is Copilot being picked
 * up?" that an absent chip would leave open. Any source found in the index but
 * not listed here is appended, so a new one is never silently unreachable. The
 * state chips keep the opposite rule — offered only once they would select
 * something — so the second row vanishes entirely when there is nothing to
 * narrow to.
 *
 * The panel's chips are always shown while they are applied, even with the
 * panel shut. That is the whole contract: a filter the user cannot see is
 * indistinguishable from an empty index.
 */

const KNOWN_SOURCES = ['claude', 'copilot'];

interface Props {
  groups: SessionGroup[];
  /** `undefined` means All. */
  active: string | undefined;
  onSelect: (source: string | undefined) => void;
  /** What the filter panel is narrowing to right now; each is clearable. */
  chips: FilterChip[];
  onClearFilter: (key: FilterKey) => void;
  hiddenCount: number;
  showingHidden: boolean;
  onToggleHidden: () => void;
  /** How many analyzed sessions the detector flagged. */
  deviationCount: number;
  showingDeviations: boolean;
  onToggleDeviations: () => void;
  /** How many sessions the retrospective judged struggled or abandoned. */
  frictionCount: number;
  showingFriction: boolean;
  onToggleFriction: () => void;
}

export function SourceFilter({
  groups,
  active,
  onSelect,
  chips,
  onClearFilter,
  hiddenCount,
  showingHidden,
  onToggleHidden,
  deviationCount,
  showingDeviations,
  onToggleDeviations,
  frictionCount,
  showingFriction,
  onToggleFriction,
}: Props): JSX.Element {
  const counts = new Map<string, number>();
  for (const group of groups) {
    counts.set(group.source, (counts.get(group.source) ?? 0) + group.count);
  }
  const extras = [...counts.keys()].filter((s) => !KNOWN_SOURCES.includes(s)).sort();
  const sources = [...KNOWN_SOURCES, ...extras];
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  const hasStateChips = deviationCount > 0 || frictionCount > 0 || hiddenCount > 0;

  return (
    <div className="session-filters">
      <div className="filter-row" role="group" aria-label="Filter by source">
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
      </div>
      {hasStateChips && (
        <div className="filter-row" role="group" aria-label="Filter by state">
          {/*
            Each offered only once it would select something: a chip reading
            zero invites the reader to wonder what is wrong, when the honest
            answer is that nothing has been flagged (or hidden).
          */}
          {deviationCount > 0 && (
            <Chip
              label="Flagged"
              count={deviationCount}
              selected={showingDeviations}
              onClick={onToggleDeviations}
              title="Sessions where a turn failed unusually often or ran unusually long. Only the most recent sessions are analyzed."
            />
          )}
          {frictionCount > 0 && (
            <Chip
              label="Struggled"
              count={frictionCount}
              selected={showingFriction}
              onClick={onToggleFriction}
              title="Sessions the retrospective judged struggled or left unfinished. Only the most recent sessions are analyzed."
            />
          )}
          {hiddenCount > 0 && (
            <Chip
              label="Hidden"
              count={hiddenCount}
              selected={showingHidden}
              onClick={onToggleHidden}
            />
          )}
        </div>
      )}
      {chips.length > 0 && (
        <div className="filter-row" role="group" aria-label="Active filters">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="filter-chip filter-chip-clearable"
              aria-pressed={true}
              title={`${chip.title ?? chip.label} — click to clear`}
              onClick={() => onClearFilter(chip.key)}
            >
              {chip.label}
              <span className="filter-chip-clear" aria-hidden="true">
                ×
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  selected,
  onClick,
  title,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
  title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="filter-chip"
      aria-pressed={selected}
      onClick={onClick}
      title={title}
    >
      {label}
      <span className="filter-count">{count.toLocaleString()}</span>
    </button>
  );
}
