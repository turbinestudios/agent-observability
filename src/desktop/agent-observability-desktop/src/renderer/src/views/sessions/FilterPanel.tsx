import type { JSX } from 'react';
import type { SessionGroup, TagCount } from '../../../../shared/rpc';
import type { SessionFilters } from './filters';
import { fromDateInput, toDateInput } from './format';

/**
 * Repository, date range and tag, in a panel that opens from the header.
 *
 * A panel rather than a third row of always-visible controls: the pane is 340px
 * wide and already carries a search box, two chip rows and a status bar, so four
 * more controls would wrap to three lines and permanently shrink the list for
 * filters most sessions are spent not using. What is ACTIVE stays visible
 * regardless — the chips above the list say so whether this is open or shut, so
 * closing the panel never hides why a list is short.
 */

interface Props {
  filters: SessionFilters;
  onChange: (filters: SessionFilters) => void;
  /** Source × repository groups from the index; repositories are read off them. */
  groups: SessionGroup[];
  tags: TagCount[];
  onClose: () => void;
}

export function FilterPanel({ filters, onChange, groups, tags, onClose }: Props): JSX.Element {
  // Repositories the CURRENT source filter can actually reach: offering one
  // that would return nothing next to a source chip is a dead end the user has
  // to discover by clicking it.
  const repositories = [
    ...new Set(
      groups
        .filter((g) => filters.source === undefined || g.source === filters.source)
        .map((g) => g.repository),
    ),
  ].sort((a, b) => a.localeCompare(b));

  /** Set one dimension, or drop it when the control is cleared. */
  const patch = (next: Partial<SessionFilters>): void => {
    const merged: SessionFilters = { ...filters, ...next };
    for (const [field, value] of Object.entries(next)) {
      if (value === undefined || value === '') {
        delete merged[field as keyof SessionFilters];
      }
    }
    onChange(merged);
  };

  return (
    <div className="filter-panel" role="group" aria-label="Filter sessions">
      <label className="filter-field">
        <span>Repository</span>
        <select
          value={filters.repository ?? ''}
          onChange={(e) => patch({ repository: e.target.value })}
        >
          <option value="">All repositories</option>
          {repositories.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-field">
        <span>Tag</span>
        <select value={filters.tag ?? ''} onChange={(e) => patch({ tag: e.target.value })}>
          <option value="">Any tag</option>
          {tags.map((tag) => (
            <option key={tag.tag} value={tag.tag}>
              {tag.tag} ({tag.count})
            </option>
          ))}
          {/*
            A tag arriving from elsewhere — a drill-down, or one whose last
            session is hidden — may not be in the list. Kept as an option so the
            control shows what is actually applied instead of snapping to "Any".
          */}
          {filters.tag !== undefined && !tags.some((t) => t.tag === filters.tag) && (
            <option value={filters.tag}>{filters.tag}</option>
          )}
        </select>
      </label>

      <div className="filter-dates">
        <label className="filter-field">
          <span>From</span>
          <input
            type="date"
            value={filters.endedAfterMs === undefined ? '' : toDateInput(filters.endedAfterMs)}
            // Both ends are inclusive, so "from" is that day's first instant and
            // "to" is its last — otherwise picking the same day twice would
            // select nothing.
            onChange={(e) => patch({ endedAfterMs: fromDateInput(e.target.value, 'start') })}
          />
        </label>
        <label className="filter-field">
          <span>To</span>
          <input
            type="date"
            value={filters.endedBeforeMs === undefined ? '' : toDateInput(filters.endedBeforeMs)}
            onChange={(e) => patch({ endedBeforeMs: fromDateInput(e.target.value, 'end') })}
          />
        </label>
      </div>

      <div className="filter-panel-actions">
        {/*
          Clears what this panel shows, and only that. The source has its own
          visible chip row above; resetting a control the user can see from here
          would look like a glitch rather than a choice.
        */}
        <button
          type="button"
          className="filter-panel-btn"
          onClick={() => onChange(filters.source === undefined ? {} : { source: filters.source })}
        >
          Clear all
        </button>
        <button type="button" className="filter-panel-btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
