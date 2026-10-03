import type { JSX } from 'react';
import type { LiveBoardSnapshot, LiveSessionRow } from '../../../../shared/rpc';
import { formatCost, formatRelative, formatTokens, shortRepo, sourceLabel } from '../sessions/format';
import { liveSummary, pendingHint, sortLiveRows, statusHint, statusLabel } from './workspace';

/**
 * The live board: one card per session active in the last half hour, across
 * every repository, with the status derived from its own transcript.
 */
interface Props {
  snapshot: LiveBoardSnapshot | undefined;
  error?: string;
  nowMs?: number;
  onOpenSession: (source: string, sessionId: string) => void;
  /** Narrow the board to one repository (the hub's "Live now" section). */
  repository?: string;
}

export function LiveBoard({ snapshot, error, nowMs, onOpenSession, repository }: Props): JSX.Element {
  const now = nowMs ?? Date.now();
  const rows = sortLiveRows(
    (snapshot?.rows ?? []).filter((row) => repository === undefined || row.repository === repository),
  );
  return (
    <section className="card live-board" aria-label="Live sessions">
      <div className="card-head">
        <h2>{repository === undefined ? 'Now' : 'Live now'}</h2>
        <span className="card-note">{snapshot === undefined ? 'Loading…' : liveSummary(rows)}</span>
      </div>
      {error !== undefined && <p className="card-caption live-error">{error}</p>}
      {snapshot?.note !== undefined && <p className="card-caption">{snapshot.note}</p>}
      {snapshot !== undefined && rows.length === 0 && (
        <p className="chart-empty">
          No sessions in the last {Math.round(snapshot.finishedMs / 60_000)} minutes. Start an agent and its card
          appears here.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="live-grid">
          {rows.map((row) => (
            <LiveCard key={`${row.source}:${row.sessionId}`} row={row} nowMs={now} onOpen={onOpenSession} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LiveCard({
  row,
  nowMs,
  onOpen,
}: {
  row: LiveSessionRow;
  nowMs: number;
  onOpen: (source: string, sessionId: string) => void;
}): JSX.Element {
  const hint = pendingHint(row, nowMs);
  return (
    <li className={`live-card live-${row.status}`}>
      <button type="button" className="live-card-button" onClick={() => onOpen(row.source, row.sessionId)}>
        <span className="live-card-top">
          <span className={`live-status live-status-${row.status}`} title={statusHint(row)}>
            {statusLabel(row.status)}
          </span>
          <span className="live-source">{sourceLabel(row.source)}</span>
        </span>
        <span className="live-title">{row.title ?? 'Untitled session'}</span>
        <span className="live-meta">
          <span title={row.repository}>{shortRepo(row.repository)}</span>
          {row.branch !== undefined && (
            <span className="live-branch" title="Branch (shown on this computer only)">
              {row.branch}
            </span>
          )}
        </span>
        <span className="live-meta live-meta-muted">
          <span>started {formatRelative(row.startedAtMs, nowMs)}</span>
          <span>active {formatRelative(row.lastActivityMs, nowMs)}</span>
        </span>
        <span className="live-meta live-meta-muted">
          <span>{formatTokens(row.inputTokens + row.outputTokens)}</span>
          {row.costMicros !== undefined && <span>{formatCost(row.costMicros)}</span>}
          {row.model !== undefined && <span>{row.model}</span>}
        </span>
        {hint !== undefined && <span className="live-hint">{hint}</span>}
      </button>
    </li>
  );
}
