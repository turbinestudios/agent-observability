import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { HotspotRow, HotspotSessionRow, HotspotsResult } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import { formatRelative, sourceLabel } from '../sessions/format';
import {
  OVERSIZED_THRESHOLD_TOKENS,
  categoryLabel,
  describeCoverage,
  describeProgress,
  isOversized,
  shortPath,
} from './hotspots';
import './hotspots.css';

/**
 * Which instruction and customization files your agents actually load.
 *
 * The ranking is a single aggregate query over what the background analysis has
 * read, so opening the view costs milliseconds — but that analysis is what makes
 * it possible, and it fills in over the first few minutes on a fresh index. A
 * partial ranking is shown rather than a spinner, with a note saying it is
 * partial: it is already ordered correctly, and waiting in silence would be
 * worse than an answer that grows.
 */

interface Props {
  /** Opens a session in the Sessions view, from the expanded row. */
  onOpenSession: (source: string, sessionId: string) => void;
}

export function HotspotsView({ onOpenSession }: Props): JSX.Element {
  const [data, setData] = useState<HotspotsResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [repository, setRepository] = useState<string>('');
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    dataHost
      .call('hotspots.get', repository === '' ? {} : { repository })
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [repository]);

  useEffect(() => {
    load();
    // The ranking grows as sessions are read, so it follows the analysis rather
    // than the index: a batch landing is exactly when a new row can appear.
    return dataHost.on('analysis.progress', (event) => {
      if (event.event === 'analysis.progress') {
        load();
      }
    });
  }, [load]);

  if (error !== undefined) {
    return (
      <div className="placeholder">
        <div>
          <h2>Could not load context hotspots</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
        <p className="detail-loading-title">Reading context…</p>
      </div>
    );
  }

  const progress = describeProgress(data.status);

  return (
    <div className="hotspots">
      <header className="hotspots-header">
        <h1>Context Hotspots</h1>
        <p>
          Which instruction and customization files your agents actually load, ranked by how often
          they are pulled into context. Read from your own sessions, on this machine.
        </p>
        <div className="hotspots-controls">
          <label className="hotspots-repo">
            Repository
            <select value={repository} onChange={(e) => setRepository(e.target.value)}>
              <option value="">All repositories</option>
              {data.repositories.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </label>
          <span className="hotspots-coverage">{describeCoverage(data.rows, data.status)}</span>
        </div>
        {progress !== undefined && (
          <p className="hotspots-progress" role="status">
            {progress}
          </p>
        )}
      </header>

      {data.rows.length === 0 ? (
        <EmptyState building={progress !== undefined} />
      ) : (
        <div className="hotspots-table-wrap">
          <table className="hotspots-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th className="n">Sessions</th>
                <th className="n">Applied</th>
                <th className="n" title="Discovered but left out of the context window">
                  Skipped
                </th>
                <th className="n" title="Opened with a tool call rather than loaded automatically">
                  Read
                </th>
                <th className="n" title="Largest estimated size seen in any one session">
                  Est. tokens
                </th>
                <th className="n" title="Sessions using this file that also had a failed step">
                  Errors
                </th>
                <th className="n" title="Sessions using this file that were flagged as diverging">
                  Flagged
                </th>
                <th className="n">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <HotspotRowItem
                  key={row.file}
                  row={row}
                  expanded={expanded === row.file}
                  repository={repository}
                  onToggle={() => setExpanded((current) => (current === row.file ? undefined : row.file))}
                  onOpenSession={onOpenSession}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState({ building }: { building: boolean }): JSX.Element {
  return (
    <div className="placeholder">
      <div>
        <h2>{building ? 'Reading your sessions' : 'No context files found'}</h2>
        <p>
          {building
            ? 'This view fills in as sessions are read. It only has to happen once per session.'
            : 'Nothing in the sessions read so far pulled an instruction, skill, agent, hook, or prompt file into context.'}
        </p>
      </div>
    </div>
  );
}

/**
 * One file, expandable to the sessions behind it.
 *
 * The sessions are fetched on expand rather than with the ranking: most rows are
 * never opened, and shipping every file's session list would make the first
 * paint pay for all of them.
 */
function HotspotRowItem({
  row,
  expanded,
  repository,
  onToggle,
  onOpenSession,
}: {
  row: HotspotRow;
  expanded: boolean;
  repository: string;
  onToggle: () => void;
  onOpenSession: (source: string, sessionId: string) => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<HotspotSessionRow[] | undefined>(undefined);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    let cancelled = false;
    dataHost
      .call('hotspots.sessions', row.file, repository === '' ? {} : { repository })
      .then((next) => {
        if (!cancelled) {
          setSessions(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, row.file, repository]);

  const oversized = isOversized(row.estTokensMax);

  return (
    <>
      <tr className={`hotspot-row${expanded ? ' hotspot-row-open' : ''}`}>
        <td>
          <button
            type="button"
            className="hotspot-file"
            aria-expanded={expanded}
            onClick={onToggle}
            title={row.file}
          >
            <span className={`hotspot-caret${expanded ? ' hotspot-caret-open' : ''}`} aria-hidden="true">
              ▸
            </span>
            <span className="hotspot-name">{row.name}</span>
            <span className="hotspot-path">{shortPath(row.file)}</span>
          </button>
        </td>
        <td>{categoryLabel(row.category)}</td>
        <td className="n">{row.sessionCount.toLocaleString()}</td>
        <td className="n">{row.appliedCount.toLocaleString()}</td>
        <td className="n">{row.skippedCount.toLocaleString()}</td>
        <td className="n">{row.readCount.toLocaleString()}</td>
        <td className="n">
          {row.estTokensMax.toLocaleString()}
          {oversized && (
            <span
              className="hotspot-oversized"
              title={`Over the ${OVERSIZED_THRESHOLD_TOKENS.toLocaleString()}-token guideline — worth splitting up`}
            >
              Oversized
            </span>
          )}
        </td>
        <td className="n">{row.errorSessions.toLocaleString()}</td>
        <td className="n">{row.deviationSessions.toLocaleString()}</td>
        <td className="n">{formatRelative(row.lastSeenMs)}</td>
      </tr>
      {expanded && (
        <tr className="hotspot-detail-row">
          <td colSpan={10}>
            {sessions === undefined ? (
              <p className="hotspot-sessions-note">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p className="hotspot-sessions-note">No sessions to show.</p>
            ) : (
              <ul className="hotspot-sessions">
                {sessions.map((session) => (
                  <li key={`${session.source}:${session.sessionId}`}>
                    <button
                      type="button"
                      className="hotspot-session"
                      onClick={() => onOpenSession(session.source, session.sessionId)}
                    >
                      <span className={`chip chip-${session.source}`}>{sourceLabel(session.source)}</span>
                      <span className="hotspot-session-title">
                        {session.title ?? session.sessionId.slice(0, 8)}
                      </span>
                      <span className="hotspot-session-meta">{session.repository}</span>
                      {session.hadDeviation && (
                        <span className="hotspot-session-flag" title="This session was flagged">
                          Flagged
                        </span>
                      )}
                      {session.hadError && (
                        <span className="hotspot-session-flag" title="This session had a failed step">
                          Errors
                        </span>
                      )}
                      <span className="hotspot-session-meta">{formatRelative(session.endedAtMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
