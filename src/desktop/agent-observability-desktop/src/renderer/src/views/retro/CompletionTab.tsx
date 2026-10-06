import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { EvidenceCompletionResult, OverviewWindow } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import type { SessionFilters } from '../sessions/filters';
import { shortRepo } from '../sessions/format';
import { completionTooltip } from '../sessions/completion';
import { describeProgress } from '../hotspots/hotspots';
import { WindowSelector } from '../overview/WindowSelector';
import { persistWindow, readStoredWindow, windowDescription, windowRange } from '../overview/window';
import { completionRows, reportedDoneFilter, reportedDoneLine, statusFilter } from './completionCounts';

/**
 * "Did it really finish?" across sessions: for the ones that changed code,
 * whether a test, build, lint or type-check was seen after the last edit and
 * how it ended. Counts only; each row opens the sessions behind it, where the
 * detail card lists the checks with links to the turns that hold the evidence.
 *
 * Nothing here judges the agent. A check run in CI, another terminal or a
 * hook is invisible to a session's own log, and the note under the table says so.
 */
interface Props {
  onOpenSessions: (filters: SessionFilters) => void;
}

export function CompletionTab({ onOpenSessions }: Props): JSX.Element {
  const [chosen, setChosen] = useState<OverviewWindow>(readStoredWindow);
  const [repository, setRepository] = useState('');
  const [data, setData] = useState<EvidenceCompletionResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    dataHost
      .call('evidence.completion', { window: chosen, ...(repository !== '' ? { repository } : {}) })
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
      <div className="evidence-completion">
        <p className="settings-error">{error}</p>
      </div>
    ) : (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
      </div>
    );
  }

  const base: SessionFilters = { ...(repository !== '' ? { repository } : {}), ...windowRange(chosen) };
  const rows = completionRows(data.summary);
  const progress = describeProgress(data.status);

  return (
    <div className="evidence-completion">
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
          <h2>Reported done, not verified</h2>
          <span className="card-note">{windowDescription(chosen)}</span>
        </div>
        <p className="completion-headline">
          <button
            type="button"
            className="table-link"
            disabled={data.summary.reportedDoneUnverified === 0}
            onClick={() => onOpenSessions(reportedDoneFilter(base))}
          >
            {reportedDoneLine(data.summary)}
          </button>
        </p>
        <p className="card-caption">
          Sessions whose last reply reported the work as done, where no check with an observed result was seen after
          the last code edit, or the last check seen had failed.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>What was observed after the last code edit</h2>
          <span className="card-note">
            {data.summary.changedCode === 1 ? '1 session' : `${data.summary.changedCode} sessions`} that changed code
          </span>
        </div>
        {data.summary.changedCode === 0 ? (
          <p className="chart-empty">No analysed session in this window changed code.</p>
        ) : (
          <table className="source-table">
            <thead>
              <tr>
                <th>Status</th>
                <th className="n">Sessions</th>
                <th className="n">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.status} className="row-selectable">
                  <td>
                    <button
                      type="button"
                      className="table-link"
                      disabled={row.sessions === 0}
                      title={completionTooltip(row.status, false)}
                      onClick={() => onOpenSessions(statusFilter(base, row.status))}
                    >
                      {row.label}
                    </button>
                  </td>
                  <td className="n">{row.sessions}</td>
                  <td className="n">{row.pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="card-caption">
          Based only on what each session recorded. A check run in CI, another terminal or a hook is not visible here,
          and a command whose result was piped or run in the background counts as run but not as passed. Claude Code
          sessions only for now.
        </p>
      </section>
    </div>
  );
}
