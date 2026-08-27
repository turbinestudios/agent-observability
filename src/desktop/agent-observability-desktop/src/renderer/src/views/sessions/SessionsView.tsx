import type { JSX } from 'react';
import { useCallback, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SessionRow } from '../../../../shared/rpc';
import { sessionKey } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { useSessions } from './useSessions';
import { SessionDetail } from './SessionDetail';
import { IndexStatusBar } from './IndexStatusBar';
import { SourceFilter } from './SourceFilter';
import { DeleteDialog } from './DeleteDialog';
import { formatDuration, formatRelative, formatTokens, sourceLabel } from './format';
import './sessions.css';

/**
 * Sessions: the app's primary view and its left-hand navigation.
 *
 * The list is virtualized because a developer accumulates thousands of sessions
 * and the desktop app deliberately does not cap them the way the extension must
 * — with an index behind it there is no per-row parsing cost to bound.
 */
export function SessionsView(): JSX.Element {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<SessionRow | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const { rows, groups, status, connection, loading, error, refresh, rebuild, reload, hiddenCount } =
    useSessions(query, source, showHidden);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 12,
  });

  const selectedRow = rows.find((r) => sessionKey(r.source, r.sessionId) === selected);
  const busy =
    connection === 'connecting' || status.phase === 'discovering' || status.phase === 'hydrating';

  const commitRename = useCallback(
    (row: SessionRow, title: string) => {
      setRenaming(undefined);
      const current = row.title ?? '';
      if (title.trim() === current.trim()) {
        return;
      }
      void dataHost
        .call('sessions.rename', row.source, row.sessionId, title)
        // A search may no longer match the new name, so re-query rather than
        // patching the row in place and leaving a stale result set.
        .then(() => (query.length > 0 ? reload() : undefined))
        .catch(() => undefined);
    },
    [query, reload],
  );

  const restore = useCallback(
    (row: SessionRow) => {
      void dataHost
        .call('sessions.hide', row.source, row.sessionId, false)
        .then(() => reload())
        .catch(() => undefined);
    },
    [reload],
  );

  return (
    <>
      {confirming !== undefined && (
        <DeleteDialog
          row={confirming}
          onClose={() => setConfirming(undefined)}
          onRemoved={() => {
            if (selected === sessionKey(confirming.source, confirming.sessionId)) {
              setSelected(undefined);
            }
            reload();
          }}
        />
      )}
      <aside className="sessions-pane">
        <header className="sessions-header">
          <input
            className="sessions-search"
            type="search"
            placeholder="Search sessions"
            value={query}
            aria-label="Search sessions"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="icon-button" onClick={refresh} title="Refresh">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 4a8 8 0 0 1 7.4 5h-2.2A6 6 0 0 0 6 12h3l-4 4.5L1 12h3a8 8 0 0 1 8-8Z" />
            </svg>
          </button>
        </header>

        <SourceFilter
          groups={groups}
          active={source}
          onSelect={setSource}
          hiddenCount={hiddenCount}
          showingHidden={showHidden}
          onToggleHidden={() => {
            setShowHidden((v) => !v);
            setSelected(undefined);
          }}
        />

        <IndexStatusBar
          status={status}
          connection={connection}
          rowCount={rows.length}
          onRebuild={rebuild}
        />

        {error !== undefined && connection === 'connected' && (
          <div className="sessions-error">
            <p>{error}</p>
            <button type="button" onClick={rebuild}>
              Rebuild index
            </button>
          </div>
        )}

        <div className="sessions-scroll" ref={scrollRef}>
          {/*
            "No sessions yet" is only true once nothing is still arriving.
            Showing it during the first index pass would flash a wrong answer
            before the rows land.
          */}
          {rows.length === 0 && !loading && !busy ? (
            <EmptyState query={query} />
          ) : (
            <div className="sessions-virtual" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                const key = sessionKey(row.source, row.sessionId);
                return (
                  <div
                    key={key}
                    className="sessions-row-wrap"
                    style={{ transform: `translateY(${item.start}px)`, height: item.size }}
                  >
                    <SessionRowItem
                      row={row}
                      selected={key === selected}
                      renaming={renaming === key}
                      hidden={showHidden}
                      onSelect={() => setSelected(key)}
                      onStartRename={() => setRenaming(key)}
                      onCancelRename={() => setRenaming(undefined)}
                      onCommitRename={(title) => commitRename(row, title)}
                      onRemove={() => setConfirming(row)}
                      onRestore={() => restore(row)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <section className="detail-pane">
        {selectedRow === undefined ? (
          <div className="placeholder">
            <div>
              <h2>No session selected</h2>
              <p>Pick a session on the left to see its turns, tokens, and tool calls.</p>
            </div>
          </div>
        ) : (
          <SessionDetail key={`${selectedRow.source}:${selectedRow.sessionId}`} row={selectedRow} />
        )}
      </section>
    </>
  );
}

function EmptyState({ query }: { query: string }): JSX.Element {
  return (
    <div className="placeholder">
      <div>
        <h2>{query.length > 0 ? 'No matching sessions' : 'No sessions yet'}</h2>
        <p>
          {query.length > 0
            ? 'Try a different search term.'
            : 'Sessions appear here once you have used Claude Code or Copilot on this machine.'}
        </p>
      </div>
    </div>
  );
}

function SessionRowItem({
  row,
  selected,
  renaming,
  hidden,
  onSelect,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onRemove,
  onRestore,
}: {
  row: SessionRow;
  selected: boolean;
  renaming: boolean;
  /** True while the list is showing hidden sessions, where the action is restore. */
  hidden: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: (title: string) => void;
  onRemove: () => void;
  onRestore: () => void;
}): JSX.Element {
  const title = row.title ?? row.sessionId.slice(0, 8);

  if (renaming) {
    return (
      <div className="session-row session-row-renaming" aria-current={selected}>
        <RenameInput
          initial={row.title ?? ''}
          originalTitle={row.originalTitle}
          onCancel={onCancelRename}
          onCommit={onCommitRename}
        />
      </div>
    );
  }

  const tooltip =
    row.originalTitle === undefined
      ? (row.title ?? row.sessionId)
      : `${row.title} — renamed, originally "${row.originalTitle}"`;

  return (
    <button
      type="button"
      className="session-row"
      aria-current={selected}
      onClick={onSelect}
      // F2 is the conventional rename key, and a double-click is what people
      // try first; both beat hunting for the hover button.
      onDoubleClick={onStartRename}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          onStartRename();
        }
      }}
      title={tooltip}
    >
      <div className="session-row-top">
        <span className="session-title">{title}</span>
        {row.originalTitle !== undefined && (
          <span className="renamed-dot" aria-label="Renamed" title="Renamed" />
        )}
        <span
          className="row-rename"
          role="button"
          tabIndex={-1}
          aria-label="Rename session"
          title="Rename"
          onClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" />
          </svg>
        </span>
        <span
          className="row-remove"
          role="button"
          tabIndex={-1}
          aria-label={hidden ? 'Restore session' : 'Remove session'}
          title={hidden ? 'Restore to the list' : 'Remove…'}
          onClick={(e) => {
            // The row itself selects; this must not also open the session.
            e.stopPropagation();
            if (hidden) {
              onRestore();
            } else {
              onRemove();
            }
          }}
        >
          {hidden ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M9 3h6l1 1h4v2H4V4h4l1-1ZM6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z" />
            </svg>
          )}
        </span>
        <span className="session-time">{formatRelative(row.endedAtMs)}</span>
      </div>
      <div className="session-row-bottom">
        <span className={`chip chip-${row.source}`}>{sourceLabel(row.source)}</span>
        <span className="session-repo">{row.repository}</span>
        {row.pending === true ? (
          <span className="session-meta dim">reading…</span>
        ) : (
          <span className="session-meta">
            {row.interactionCount.toLocaleString()} steps · {formatTokens(row.inputTokens + row.outputTokens)} ·{' '}
            {formatDuration(row.durationMs)}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Inline editor for a session name.
 *
 * Committing on blur as well as Enter, because clicking away is a normal way to
 * finish typing and losing the edit there would be surprising. Escape is the
 * explicit discard.
 */
function RenameInput({
  initial,
  originalTitle,
  onCancel,
  onCommit,
}: {
  initial: string;
  originalTitle?: string;
  onCancel: () => void;
  onCommit: (title: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const committed = useRef(false);

  const commit = (next: string): void => {
    if (committed.current) {
      return; // blur fires after Enter; only the first one counts
    }
    committed.current = true;
    onCommit(next);
  };

  return (
    <div className="rename-row">
      <input
        className="rename-input"
        autoFocus
        value={value}
        aria-label="Session name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            committed.current = true;
            onCancel();
          }
        }}
      />
      {originalTitle !== undefined && (
        <button
          type="button"
          className="rename-reset"
          // Mouse-down, not click: the input's blur would commit first and
          // unmount this button before a click could land.
          onMouseDown={(e) => {
            e.preventDefault();
            commit('');
          }}
          title={`Restore "${originalTitle}"`}
        >
          Reset
        </button>
      )}
    </div>
  );
}

