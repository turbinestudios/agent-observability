import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { RetroResult, RetroVerdict } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import { formatRelative, sourceLabel } from '../sessions/format';
import { verdictLabel } from '../sessions/retro';
import { describeProgress } from '../hotspots/hotspots';
import { VERDICT_FILTERS, describeRetroCoverage, frictionSummary, verdictChipClass } from './retro';
import type { SessionFilters } from '../sessions/filters';
import { ToolsTab } from './ToolsTab';
import { CompletionTab } from './CompletionTab';
import { ReworkTab } from './ReworkTab';
import { EVIDENCE_TABS, neighbourTab, persistTab, readStoredTab, type EvidenceTabId } from './tabs';
import './retro.css';

/**
 * Every judged session, worst first — the place to ask "which of my recent
 * runs fought me, and why?".
 *
 * Same construction as the Context Hotspots view: one aggregate query over
 * what the background analysis has read so far, partial results shown honestly
 * with a progress note, and each row opening the session itself — the verdict
 * is a pointer at the story, never a substitute for it.
 */

interface RetrospectivesProps {
  /** Opens a session in the Sessions view. */
  onOpenSession: (source: string, sessionId: string) => void;
  /** Opens the Improve view scoped to the selected repository. */
  onImprove?: (repository: string) => void;
}

interface Props extends RetrospectivesProps {
  /** Opens the Sessions view narrowed by filters, for the Tools drill-down. */
  onOpenSessions: (filters: SessionFilters) => void;
}

/**
 * Evidence: what the local analysis found about how sessions went. One rail
 * entry, several tabs, so new kinds of evidence do not each claim a place in
 * the sidebar. The ViewId stays `retro`; only the label changed.
 */
export function RetroView({ onOpenSession, onImprove, onOpenSessions }: Props): JSX.Element {
  const [tab, setTab] = useState<EvidenceTabId>(readStoredTab);
  const choose = (next: EvidenceTabId): void => {
    setTab(next);
    persistTab(next);
  };
  return (
    <div className="evidence">
      <div
        className="evidence-tabs"
        role="tablist"
        aria-label="Evidence"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            choose(neighbourTab(tab, 1));
          } else if (e.key === 'ArrowLeft') {
            choose(neighbourTab(tab, -1));
          }
        }}
      >
        {EVIDENCE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="evidence-tab"
            aria-selected={entry.id === tab}
            tabIndex={entry.id === tab ? 0 : -1}
            title={entry.hint}
            onClick={() => choose(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="evidence-body" role="tabpanel">
        {tab === 'tools' ? (
          <ToolsTab onOpenSessions={onOpenSessions} />
        ) : tab === 'completion' ? (
          <CompletionTab onOpenSessions={onOpenSessions} />
        ) : tab === 'rework' ? (
          <ReworkTab onOpenSessions={onOpenSessions} onOpenSession={onOpenSession} />
        ) : (
          <RetrospectivesTab onOpenSession={onOpenSession} {...(onImprove !== undefined ? { onImprove } : {})} />
        )}
      </div>
    </div>
  );
}

function RetrospectivesTab({ onOpenSession, onImprove }: RetrospectivesProps): JSX.Element {
  const [data, setData] = useState<RetroResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [repository, setRepository] = useState<string>('');
  /** `undefined` shows every tier. */
  const [tier, setTier] = useState<RetroVerdict | undefined>(undefined);

  const load = useCallback(() => {
    dataHost
      .call('retro.get', repository === '' ? {} : { repository })
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [repository]);

  useEffect(() => {
    load();
    // Verdicts land with the analysis, so the table follows its progress.
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
          <h2>Could not load the retrospectives</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
        <p className="detail-loading-title">Reading sessions…</p>
      </div>
    );
  }

  const progress = describeProgress(data.status);
  const rows = tier === undefined ? data.rows : data.rows.filter((r) => r.verdict === tier);
  const tierCounts = new Map<RetroVerdict, number>();
  for (const row of data.rows) {
    tierCounts.set(row.verdict, (tierCounts.get(row.verdict) ?? 0) + 1);
  }

  return (
    <div className="retro-view">
      <header className="retro-view-header">
        <h1>Retrospectives</h1>
        <p>
          How your recent sessions actually went — what each one set out to do, where the friction
          was, and which ones deserve a second look. Read from your own sessions, on this machine.
        </p>
        <div className="retro-view-controls">
          <div className="retro-view-tiers" role="group" aria-label="Filter by verdict">
            <button
              type="button"
              className="filter-chip"
              aria-pressed={tier === undefined}
              onClick={() => setTier(undefined)}
            >
              All<span className="filter-count">{data.rows.length.toLocaleString()}</span>
            </button>
            {VERDICT_FILTERS.map((v) => (
              <button
                key={v}
                type="button"
                className="filter-chip"
                aria-pressed={tier === v}
                onClick={() => setTier((current) => (current === v ? undefined : v))}
              >
                {verdictLabel(v)}
                <span className="filter-count">{(tierCounts.get(v) ?? 0).toLocaleString()}</span>
              </button>
            ))}
          </div>
          <label className="retro-view-repo">
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
          <span className="retro-view-coverage">{describeRetroCoverage(data.rows, data.status)}</span>
          {onImprove !== undefined && (
            <button
              type="button"
              className="retro-view-improve"
              // Plans are single-repository by definition, so the door opens
              // only once one is chosen here.
              disabled={repository === ''}
              title={
                repository === ''
                  ? 'Pick a repository first — improvement plans cover one repository at a time'
                  : `Build an improvement plan for ${repository}`
              }
              onClick={() => onImprove(repository)}
            >
              Improve context…
            </button>
          )}
        </div>
        {progress !== undefined && (
          <p className="retro-view-progress" role="status">
            {progress}
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <EmptyState building={progress !== undefined} filtered={tier !== undefined || repository !== ''} />
      ) : (
        <div className="retro-view-table-wrap">
          <table className="retro-view-table">
            <thead>
              <tr>
                <th>How it went</th>
                <th>Session</th>
                <th>Source</th>
                <th>Repository</th>
                <th>When</th>
                <th>Friction</th>
                <th className="n" title="Suggestions the retrospective made">
                  Tips
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.source}:${row.sessionId}`}
                  className="retro-view-row"
                  tabIndex={0}
                  onClick={() => onOpenSession(row.source, row.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenSession(row.source, row.sessionId);
                    }
                  }}
                  title="Open the session and its retrospective"
                >
                  <td>
                    <span className={`retro-view-chip ${verdictChipClass(row.verdict)}`}>
                      {verdictLabel(row.verdict)}
                    </span>
                  </td>
                  <td className="retro-view-title" title={row.title ?? row.sessionId}>
                    {row.title ?? row.sessionId}
                  </td>
                  <td>{sourceLabel(row.source)}</td>
                  <td className="retro-view-repo-cell" title={row.repository}>
                    {row.repository}
                  </td>
                  <td>{formatRelative(row.endedAtMs)}</td>
                  <td className="retro-view-friction">{frictionSummary(row)}</td>
                  <td className="n">{row.tipCount > 0 ? row.tipCount : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState({ building, filtered }: { building: boolean; filtered: boolean }): JSX.Element {
  return (
    <div className="placeholder">
      <div>
        <h2>{building ? 'Judging sessions…' : 'Nothing to show'}</h2>
        <p>
          {building
            ? 'Retrospectives appear here as the background analysis reads your recent sessions.'
            : filtered
              ? 'No judged session matches the current filter.'
              : 'No sessions have been judged yet — run some agent sessions and check back.'}
        </p>
      </div>
    </div>
  );
}
