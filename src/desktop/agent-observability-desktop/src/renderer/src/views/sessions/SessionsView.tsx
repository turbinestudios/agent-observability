import type { JSX } from 'react';
import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SessionRow } from '../../../../shared/rpc';
import { sessionKey } from '../../../../shared/rpc';
import { useSessions } from './useSessions';
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
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const { rows, status, loading, error, refresh, rebuild } = useSessions(query);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 12,
  });

  const selectedRow = rows.find((r) => sessionKey(r.source, r.sessionId) === selected);

  return (
    <>
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

        <IndexBanner status={status} loading={loading} rowCount={rows.length} />

        {error !== undefined && (
          <div className="sessions-error">
            <p>{error}</p>
            <button type="button" onClick={rebuild}>
              Rebuild index
            </button>
          </div>
        )}

        <div className="sessions-scroll" ref={scrollRef}>
          {rows.length === 0 && !loading ? (
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
                      onSelect={() => setSelected(key)}
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
          <SessionStub row={selectedRow} />
        )}
      </section>
    </>
  );
}

/** Progress while the indexer is still hydrating rows. */
function IndexBanner({
  status,
  loading,
  rowCount,
}: {
  status: { indexed: number; total: number; phase: string; message?: string };
  loading: boolean;
  rowCount: number;
}): JSX.Element | null {
  if (status.phase === 'error') {
    return <div className="sessions-banner error">Indexing failed: {status.message}</div>;
  }
  const busy = status.phase === 'discovering' || status.phase === 'hydrating';
  if (!busy && !loading) {
    return rowCount > 0 ? (
      <div className="sessions-banner subtle">{rowCount.toLocaleString()} sessions</div>
    ) : null;
  }
  const pct = status.total === 0 ? 0 : Math.round((status.indexed / status.total) * 100);
  return (
    <div className="sessions-banner">
      <span>
        {status.phase === 'discovering'
          ? 'Finding sessions…'
          : `Reading sessions — ${status.indexed.toLocaleString()} of ${status.total.toLocaleString()}`}
      </span>
      <div className="progress" role="progressbar" aria-valuenow={pct}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
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
  onSelect,
}: {
  row: SessionRow;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const title = row.title ?? row.sessionId.slice(0, 8);
  return (
    <button
      type="button"
      className="session-row"
      aria-current={selected}
      onClick={onSelect}
      title={row.title ?? row.sessionId}
    >
      <div className="session-row-top">
        <span className="session-title">{title}</span>
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
 * Interim detail pane. The shared HTML renderer gets wired in at the detail
 * milestone; until then this shows the indexed facts so selection is useful.
 */
function SessionStub({ row }: { row: SessionRow }): JSX.Element {
  const fields: [string, string][] = [
    ['Repository', row.repository],
    ['Source', sourceLabel(row.source)],
    ['Model', row.model],
    ['Steps', row.interactionCount.toLocaleString()],
    ['LLM calls', row.llmCalls.toLocaleString()],
    ['Tool calls', row.toolCalls.toLocaleString()],
    ['Input tokens', row.inputTokens.toLocaleString()],
    ['Output tokens', row.outputTokens.toLocaleString()],
    ['Cached tokens', row.cachedTokens.toLocaleString()],
    ['Duration', formatDuration(row.durationMs)],
  ];
  return (
    <div className="detail-stub">
      <h1>{row.title ?? row.sessionId}</h1>
      <p className="detail-sub">{row.sessionId}</p>
      <dl>
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="detail-note">
        Full turn-by-turn detail arrives with the shared session renderer in the next milestone.
      </p>
    </div>
  );
}
