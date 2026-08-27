import type { JSX } from 'react';
import type { IndexStatus } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import { splitNotes } from './format';

/**
 * Says what the app is doing while the list fills in.
 *
 * The distinction that matters is between "nothing has happened yet" and
 * "working, here is how far along". Showing a count before one exists reads as
 * a broken app, so a phase with no numbers yet gets a spinner and a sentence
 * instead of "0 of 0".
 */

export type ConnectionState = 'connecting' | 'connected' | 'failed';

interface Props {
  status: IndexStatus;
  connection: ConnectionState;
  /** Rows currently on screen, which may exceed `indexed` mid-pass. */
  rowCount: number;
  onRebuild: () => void;
}

export function IndexStatusBar({ status, connection, rowCount, onRebuild }: Props): JSX.Element | null {
  if (connection === 'failed' || status.phase === 'error') {
    return (
      <div className="status-bar status-error">
        <WarningIcon />
        <div className="status-text">
          <span className="status-line">
            {connection === 'failed' ? 'Cannot reach the data process' : 'Indexing failed'}
          </span>
          {status.message !== undefined && <span className="status-sub">{status.message}</span>}
        </div>
        <button type="button" className="status-action" onClick={onRebuild}>
          Retry
        </button>
      </div>
    );
  }

  if (connection === 'connecting') {
    return (
      <div className="status-bar">
        <Spinner />
        <div className="status-text">
          <span className="status-line">Starting up…</span>
          <span className="status-sub">Connecting to the session reader</span>
        </div>
      </div>
    );
  }

  if (status.phase === 'discovering') {
    return (
      <div className="status-bar">
        <Spinner />
        <div className="status-text">
          <span className="status-line">Looking for sessions…</span>
          <span className="status-sub">Scanning your agent transcript folders</span>
        </div>
      </div>
    );
  }

  if (status.phase === 'hydrating') {
    const remaining = Math.max(0, status.total - status.indexed);
    const pct = status.total === 0 ? 0 : Math.round((status.indexed / status.total) * 100);
    return (
      <div className="status-bar">
        <Spinner />
        <div className="status-text">
          <span className="status-line">
            Reading sessions — {status.indexed.toLocaleString()} of {status.total.toLocaleString()}
          </span>
          <span className="status-sub">
            {remaining === 0
              ? 'Finishing up'
              : `${remaining.toLocaleString()} left · the list is usable now, details fill in as they load`}
          </span>
          <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    );
  }

  // Idle with advisory notes: a skipped or turned-off source is information,
  // not a failure — without it a locked Copilot database and "no sessions"
  // look identical. Info styling, never error red.
  if (status.message !== undefined) {
    return (
      <div className="status-bar status-info">
        <InfoIcon />
        <div className="status-text">
          {rowCount > 0 && (
            <span className="status-line">
              {rowCount.toLocaleString()} session{rowCount === 1 ? '' : 's'}
            </span>
          )}
          {splitNotes(status.message).map((note) => (
            <span key={note} className="status-sub">
              {note}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // Idle. Stay quiet unless there is something to say.
  if (rowCount === 0) {
    return null;
  }
  return (
    <div className="status-bar status-quiet">
      <span className="status-sub">
        {rowCount.toLocaleString()} session{rowCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function InfoIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm.9 8.4a.9.9 0 0 1-1.8 0V8a.9.9 0 0 1 1.8 0v4Z" />
    </svg>
  );
}

function WarningIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5 15 14H1L8 1.5Zm0 4a.9.9 0 0 0-.9 1v3a.9.9 0 0 0 1.8 0v-3a.9.9 0 0 0-.9-1Zm0 6.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
    </svg>
  );
}
