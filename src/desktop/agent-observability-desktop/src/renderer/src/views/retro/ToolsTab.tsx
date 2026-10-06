import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { EvidenceToolsResult, OverviewWindow } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import type { SessionFilters } from '../sessions/filters';
import { formatRelative, shortRepo } from '../sessions/format';
import { describeProgress } from '../hotspots/hotspots';
import { WindowSelector } from '../overview/WindowSelector';
import { persistWindow, readStoredWindow, windowDescription, windowRange } from '../overview/window';
import {
  TOOL_COLUMNS,
  TOOL_SCOPE_NOTE,
  defaultDescending,
  failureBarWidth,
  formatFailureRate,
  formatToolDuration,
  groupCount,
  sortTools,
  toolsEmptyMessage,
  visibleTools,
  type ToolSortKey,
} from './tools';

/**
 * Which tools the agents call, how often they fail, and how long they take.
 *
 * One aggregate query over what the background analysis has already read, so
 * it opens instantly and fills in while the analysis runs. A row drills into
 * the Sessions view filtered to that tool; with "Failed only" on, to the
 * sessions where it failed.
 */
interface Props {
  onOpenSessions: (filters: SessionFilters) => void;
}

const SOURCES: readonly { id: string; label: string }[] = [
  { id: '', label: 'All sources' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'copilot-cli', label: 'Copilot CLI' },
];

export function ToolsTab({ onOpenSessions }: Props): JSX.Element {
  const [chosen, setChosen] = useState<OverviewWindow>(readStoredWindow);
  const [source, setSource] = useState('');
  const [repository, setRepository] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<ToolSortKey>('calls');
  const [descending, setDescending] = useState(true);
  const [data, setData] = useState<EvidenceToolsResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    dataHost
      .call('evidence.tools', {
        window: chosen,
        ...(source !== '' ? { source } : {}),
        ...(repository !== '' ? { repository } : {}),
      })
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [chosen, source, repository]);

  useEffect(() => {
    load();
    return dataHost.on('analysis.progress', () => load());
  }, [load]);

  const chooseWindow = (next: OverviewWindow): void => {
    setChosen(next);
    persistWindow(next);
  };

  const chooseSort = (key: ToolSortKey): void => {
    if (key === sortKey) {
      setDescending((current) => !current);
    } else {
      setSortKey(key);
      setDescending(defaultDescending(key));
    }
  };

  const open = (tool: string): void =>
    onOpenSessions({
      ...windowRange(chosen),
      ...(source !== '' ? { source } : {}),
      ...(repository !== '' ? { repository } : {}),
      tool,
      ...(failedOnly ? { toolFailed: true } : {}),
    });

  const rows = data === undefined ? [] : sortTools(visibleTools(data.rows, failedOnly), sortKey, descending);

  return (
    <div className="tools-tab">
      <header className="retro-view-header">
        <div className="tools-tab-title">
          <h1>Tools</h1>
          <WindowSelector value={chosen} onChange={chooseWindow} />
        </div>
        <p>
          Every tool your agents called in {windowDescription(chosen)}, with how often it failed and how long it took.
          Click a tool to see the sessions behind it. Everything here is computed on this computer.
        </p>
        <div className="retro-view-controls">
          <label className="retro-view-repo">
            Source
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="retro-view-repo">
            Repository
            <select value={repository} onChange={(e) => setRepository(e.target.value)}>
              <option value="">All repositories</option>
              {(data?.repositories ?? []).map((repo) => (
                <option key={repo} value={repo}>
                  {shortRepo(repo)}
                </option>
              ))}
            </select>
          </label>
          <label className="tools-tab-toggle">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
            Failed only
          </label>
        </div>
        {data !== undefined && data.status.running && (
          <p className="retro-view-progress" role="status">
            {describeProgress(data.status)}
          </p>
        )}
      </header>

      {error !== undefined && <div className="settings-error">{error}</div>}

      {data === undefined && error === undefined ? (
        <div className="detail-loading" role="status" aria-live="polite">
          <Spinner size={36} stroke={3} />
          <p className="detail-loading-title">Reading tool calls…</p>
        </div>
      ) : rows.length === 0 ? (
        <p className="chart-empty">{toolsEmptyMessage(data?.status, failedOnly, data?.rows.length ?? 0)}</p>
      ) : (
        <div className="retro-view-table-wrap">
          <table className="retro-view-table tools-tab-table">
            <thead>
              <tr>
                {TOOL_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    className={column.numeric ? 'n' : undefined}
                    title={column.title}
                    aria-sort={sortKey === column.key ? (descending ? 'descending' : 'ascending') : 'none'}
                  >
                    <button type="button" className="tools-tab-sort" onClick={() => chooseSort(column.key)}>
                      {column.label}
                      {sortKey === column.key ? (descending ? ' ↓' : ' ↑') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tool} className="retro-view-row" onClick={() => open(row.tool)}>
                  <td>
                    <button
                      type="button"
                      className="table-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        open(row.tool);
                      }}
                    >
                      {row.tool}
                    </button>
                  </td>
                  <td className="n">{groupCount(row.calls)}</td>
                  <td className="n">{groupCount(row.failures)}</td>
                  <td className="n">
                    <span className="tools-tab-rate">
                      <span className="tools-tab-bar" aria-hidden="true">
                        <span className="tools-tab-bar-fill" style={{ width: `${failureBarWidth(row)}%` }} />
                      </span>
                      {formatFailureRate(row)}
                    </span>
                  </td>
                  <td className="n">{formatToolDuration(row.p50Ms)}</td>
                  <td className="n">{formatToolDuration(row.p90Ms, row.p90Overflow)}</td>
                  <td className="n">{groupCount(row.sessions)}</td>
                  <td className="n">{row.lastUsedMs > 0 ? formatRelative(row.lastUsedMs) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tools-tab-note">{TOOL_SCOPE_NOTE}</p>
    </div>
  );
}
