import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SessionRef, SessionRow } from '../../../../shared/rpc';
import { sessionKey } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { useSessions } from './useSessions';
import { SessionDetail } from './SessionDetail';
import { CompareDetail } from './CompareDetail';
import { CompareBar } from './CompareBar';
import { IndexStatusBar } from './IndexStatusBar';
import { SourceFilter } from './SourceFilter';
import { Spinner } from '../../components/Spinner';
import { DeleteDialog } from './DeleteDialog';
import { toggleSelection } from './selection';
import { showsVerdictChip, verdictLabel } from './retro';
import { formatCost, formatDuration, formatRelative, formatTokens, sourceLabel } from './format';
import './sessions.css';

/**
 * A session another view asked to open. The timestamp is what makes a repeat
 * request register: asking twice for the same session must open it twice, which
 * comparing source and id alone could not tell apart.
 */
export interface OpenSessionIntent {
  source: string;
  sessionId: string;
  at: number;
}

/**
 * Sessions: the app's primary view and its left-hand navigation.
 *
 * The list is virtualized because a developer accumulates thousands of sessions
 * and the desktop app deliberately does not cap them the way the extension must
 * — with an index behind it there is no per-row parsing cost to bound.
 */
export function SessionsView({
  openIntent,
  onAskAi,
}: {
  openIntent?: OpenSessionIntent;
  /** Attach a session to the AI Helper and switch to it. */
  onAskAi?: (source: string, sessionId: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // Ticked for comparison. Kept as keys rather than rows, so narrowing the list
  // with a search or a source filter hides rows without untickng them.
  const [checked, setChecked] = useState<readonly string[]>([]);
  // The comparison currently open, frozen at the moment Compare was pressed —
  // so ticking more sessions afterwards does not redraw it underneath the user.
  const [comparing, setComparing] = useState<readonly string[] | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  // A session opened from another view. Held separately from the list because
  // it may be outside the loaded page, or filtered out of it entirely — the
  // detail pane must still show it rather than silently doing nothing.
  const [pinned, setPinned] = useState<SessionRow | undefined>(undefined);
  const [confirming, setConfirming] = useState<SessionRow | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  // Orthogonal to the source chips: it narrows whichever set is on screen.
  const [onlyDeviations, setOnlyDeviations] = useState(false);
  const [onlyFriction, setOnlyFriction] = useState(false);
  const {
    rows,
    groups,
    status,
    connection,
    loading,
    error,
    refresh,
    rebuild,
    reload,
    hiddenCount,
    deviationCount,
    frictionCount,
  } = useSessions(query, source, showHidden, onlyDeviations, onlyFriction);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 12,
  });

  const selectedRow =
    rows.find((r) => sessionKey(r.source, r.sessionId) === selected) ??
    (pinned !== undefined && sessionKey(pinned.source, pinned.sessionId) === selected
      ? pinned
      : undefined);
  const toggleChecked = useCallback((key: string) => {
    setChecked((current) => toggleSelection(current, key));
  }, []);
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

  // Another view asked for a session: fetch its row by key rather than hoping
  // it is on the current page, and close any comparison so the pane shows it.
  useEffect(() => {
    if (openIntent === undefined) {
      return;
    }
    let cancelled = false;
    void dataHost
      .call('sessions.row', openIntent.source, openIntent.sessionId)
      .then((row) => {
        if (cancelled || row === undefined) {
          return;
        }
        setPinned(row);
        setSelected(sessionKey(row.source, row.sessionId));
        setComparing(undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openIntent]);

  // …and bring the list to it, so the selection is visible, not just the
  // detail pane. Rows may still be loading when the intent lands, hence the
  // rows dependency; the ref makes each intent scroll once, so live row
  // updates afterwards don't yank the list back.
  const scrolledIntentAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (openIntent === undefined || scrolledIntentAt.current === openIntent.at) {
      return;
    }
    const index = rows.findIndex(
      (r) => r.source === openIntent.source && r.sessionId === openIntent.sessionId,
    );
    if (index >= 0) {
      scrolledIntentAt.current = openIntent.at;
      virtualizer.scrollToIndex(index, { align: 'center' });
    }
  }, [openIntent, rows, virtualizer]);

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
            const gone = sessionKey(confirming.source, confirming.sessionId);
            if (selected === gone) {
              setSelected(undefined);
            }
            setChecked((current) => current.filter((k) => k !== gone));
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
            // The hidden list is a different set of sessions; carrying a
            // selection across would compare rows the user can no longer see.
            setChecked([]);
            setComparing(undefined);
          }}
          deviationCount={deviationCount}
          showingDeviations={onlyDeviations}
          onToggleDeviations={() => setOnlyDeviations((v) => !v)}
          frictionCount={frictionCount}
          showingFriction={onlyFriction}
          onToggleFriction={() => setOnlyFriction((v) => !v)}
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

        <div className="sessions-list-area">
          {/*
            A slow re-query with rows already on screen (a search, a filter
            chip) replaces them with no other sign of life — this floats a big
            spinner over the middle of the list so the wait is unmistakable.
            pointer-events stays off: the stale rows remain scrollable.
          */}
          {loading && rows.length > 0 && (
            <div className="sessions-list-loading" role="status" aria-label="Updating list">
              <span className="sessions-list-loading-chip">
                <Spinner size={44} stroke={3} />
              </span>
            </div>
          )}
          <div className="sessions-scroll" ref={scrollRef}>
          {/*
            An empty list has three quite different meanings, and showing the
            wrong one is worse than showing nothing: still working, genuinely
            empty, or filtered to nothing. "No sessions yet" is only true once
            nothing is still arriving — during the first index pass it would
            flash a wrong answer before the rows land — so the working case gets
            a spinner of its own here, in the list, where the user is looking
            for the rows.
          */}
          {rows.length === 0 && (loading || busy) ? (
            <ListLoading busy={busy} />
          ) : rows.length === 0 ? (
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
                      checked={checked.includes(key)}
                      renaming={renaming === key}
                      hidden={showHidden}
                      // Opening a session closes a comparison: the pane shows
                      // one or the other, and a click that changed nothing on
                      // screen would read as a dead row.
                      onSelect={() => {
                        setSelected(key);
                        setComparing(undefined);
                      }}
                      onToggleCheck={() => toggleChecked(key)}
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
        </div>

        <CompareBar
          keys={checked}
          onCompare={() => setComparing(checked)}
          onClear={() => {
            setChecked([]);
            setComparing(undefined);
          }}
        />
      </aside>

      <section className="detail-pane">
        {comparing !== undefined ? (
          <CompareDetail refs={comparing.map(toRef)} onClose={() => setComparing(undefined)} />
        ) : selectedRow === undefined ? (
          <div className="placeholder">
            <div>
              <h2>No session selected</h2>
              <p>Pick a session on the left to see its turns, tokens, and tool calls.</p>
            </div>
          </div>
        ) : (
          <SessionDetail
            key={`${selectedRow.source}:${selectedRow.sessionId}`}
            row={selectedRow}
            onAskAi={onAskAi}
          />
        )}
      </section>
    </>
  );
}

/** Split a `sessionKey()` string back into its parts. Session ids carry no colon. */
function toRef(key: string): SessionRef {
  const at = key.indexOf(':');
  return { source: key.slice(0, at), sessionId: key.slice(at + 1) };
}

/**
 * The list is working. Deliberately brief: while the index is building, the
 * status bar directly above already explains what is happening and how far
 * along it is, so repeating it here would just be louder, not clearer.
 */
function ListLoading({ busy }: { busy: boolean }): JSX.Element {
  return (
    <div className="sessions-loading" role="status" aria-live="polite">
      <Spinner size={36} stroke={3} />
      <p>{busy ? 'Finding your sessions…' : 'Loading sessions…'}</p>
    </div>
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
  checked,
  renaming,
  hidden,
  onSelect,
  onToggleCheck,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onRemove,
  onRestore,
}: {
  row: SessionRow;
  selected: boolean;
  /** Ticked for comparison — independent of `selected`, which opens the session. */
  checked: boolean;
  renaming: boolean;
  /** True while the list is showing hidden sessions, where the action is restore. */
  hidden: boolean;
  onSelect: () => void;
  onToggleCheck: () => void;
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
      className={`session-row${checked ? ' session-row-checked' : ''}`}
      aria-current={selected}
      // Ctrl/Cmd-click is the list convention for adding to a selection rather
      // than replacing it, and saves aiming at the tick box.
      onClick={(e) => (e.ctrlKey || e.metaKey ? onToggleCheck() : onSelect())}
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
        {/*
          A span, not an <input type="checkbox">: the row is itself a button,
          and nesting a control inside one is invalid. Same shape as the rename
          and remove affordances below.
        */}
        <span
          className="row-check"
          role="checkbox"
          tabIndex={-1}
          aria-checked={checked}
          aria-label="Select for comparison"
          title="Select for comparison"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck();
          }}
        >
          {checked && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" />
            </svg>
          )}
        </span>
        <span className="session-title">{title}</span>
        {row.originalTitle !== undefined && (
          <span className="renamed-dot" aria-label="Renamed" title="Renamed" />
        )}
        {/*
          Only for a count above zero: an unanalyzed session has no count at
          all, and marking it would claim something nobody has checked.
        */}
        {row.deviationCount !== undefined && row.deviationCount > 0 && (
          <span
            className="deviation-dot"
            aria-label={`${row.deviationCount} deviation(s)`}
            title={
              row.deviationCount === 1
                ? '1 turn diverged — open the session to see why'
                : `${row.deviationCount} turns diverged — open the session to see why`
            }
          />
        )}
        {/*
          Only the two worst verdicts mark a row (see showsVerdictChip) —
          the retrospective card in the detail still states the others.
        */}
        {showsVerdictChip(row.verdict) && (
          <span
            className={`verdict-chip verdict-${row.verdict}`}
            title={`${verdictLabel(row.verdict)} — open the session for the retrospective`}
          >
            {verdictLabel(row.verdict)}
          </span>
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
            {/* Silence, not "n/a", when unpriced: the meta line would say it on
                every unpriced row; the Dashboard carries the explicit n/a. */}
            {row.costMicros !== undefined && <> · {formatCost(row.costMicros)}</>}
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

