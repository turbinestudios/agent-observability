import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { EvidenceReworkResult, OverviewWindow } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import type { SessionFilters } from '../sessions/filters';
import { formatRelative, shortRepo, sourceLabel } from '../sessions/format';
import { describeProgress } from '../hotspots/hotspots';
import { WindowSelector } from '../overview/WindowSelector';
import { persistWindow, readStoredWindow, windowDescription, windowRange } from '../overview/window';
import { REWORK_EXPLANATION, reworkRateLine, reworkSessionLine, reworkedFilter } from './rework';

/**
 * Evidence > Rework: which sessions kept going back over the same files, and
 * which files they went back to. A proxy for thrashing, labelled as one.
 */
interface Props {
  onOpenSessions: (filters: SessionFilters) => void;
  onOpenSession: (source: string, sessionId: string) => void;
}

export function ReworkTab({ onOpenSessions, onOpenSession }: Props): JSX.Element {
  const [chosen, setChosen] = useState<OverviewWindow>(readStoredWindow);
  const [repository, setRepository] = useState('');
  const [data, setData] = useState<EvidenceReworkResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    dataHost
      .call('evidence.rework', { window: chosen, ...(repository !== '' ? { repository } : {}) })
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [chosen, repository]);

  useEffect(() => {
    load();
    return dataHost.on('analysis.progress', () => load());
  }, [load]);

  const chooseWindow = (next: OverviewWindow): void => {
    setChosen(next);
    persistWindow(next);
  };

  if (data === undefined) {
    return error !== undefined ? (
      <div className="evidence-rework">
        <p className="settings-error">{error}</p>
      </div>
    ) : (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
      </div>
    );
  }

  const base: SessionFilters = { ...(repository !== '' ? { repository } : {}), ...windowRange(chosen) };
  const progress = describeProgress(data.status);

  return (
    <div className="evidence-rework">
      <div className="hotspots-controls">
        <WindowSelector value={chosen} onChange={chooseWindow} />
        <label className="hotspots-repo">
          Repository
          <select value={repository} onChange={(e) => setRepository(e.target.value)}>
            <option value="">All repositories</option>
            {data.repositories.map((repo) => (
              <option key={repo} value={repo} title={repo}>
                {shortRepo(repo)}
              </option>
            ))}
          </select>
        </label>
        {progress !== undefined && <span className="hotspots-progress">{progress}</span>}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Sessions with rework</h2>
          <span className="card-note">{windowDescription(chosen)}</span>
        </div>
        <p className="completion-headline">
          <button
            type="button"
            className="table-link"
            disabled={data.reworkedSessions === 0}
            onClick={() => onOpenSessions(reworkedFilter(base))}
          >
            {reworkRateLine(data.reworkedSessions, data.editedSessions)}
          </button>
        </p>
        <p className="card-caption">{REWORK_EXPLANATION} Claude Code sessions only for now.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Most rework</h2>
        </div>
        {data.sessions.length === 0 ? (
          <p className="chart-empty">No session in this window crossed the rework thresholds.</p>
        ) : (
          <table className="source-table">
            <tbody>
              {data.sessions.map((row) => (
                <tr key={`${row.source}:${row.sessionId}`} className="row-selectable">
                  <td>
                    <button type="button" className="table-link" onClick={() => onOpenSession(row.source, row.sessionId)}>
                      {row.title ?? 'Untitled session'}
                    </button>
                  </td>
                  <td>{sourceLabel(row.source)}</td>
                  <td title={row.repository}>{shortRepo(row.repository)}</td>
                  <td>{reworkSessionLine(row)}</td>
                  <td>{formatRelative(row.endedAtMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Files edited repeatedly</h2>
          <span className="card-note">shown relative to their repository</span>
        </div>
        {data.files.length === 0 ? (
          <p className="chart-empty">No file was edited repeatedly in this window.</p>
        ) : (
          <table className="source-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Repository</th>
                <th className="n">Sessions</th>
                <th className="n">Turns</th>
                <th className="n">Lines reworked</th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((file) => (
                <tr key={`${file.repository}:${file.path}`}>
                  <td>
                    <code>{file.path}</code>
                    {file.outsideRepo && <span className="card-caption"> (outside the repository)</span>}
                  </td>
                  <td title={file.repository}>{shortRepo(file.repository)}</td>
                  <td className="n">{file.sessions}</td>
                  <td className="n">{file.editTurns}</td>
                  <td className="n">{file.reworkedLines}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
