import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { ContextInventoryFile, OverviewWindow, RepoHubData } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import type { SessionFilters } from '../sessions/filters';
import { formatCost, formatRelative, formatTokens, shortRepo, sourceLabel } from '../sessions/format';
import { showsVerdictChip, themeLabel, verdictLabel } from '../sessions/retro';
import { HorizontalBars, Legend } from '../overview/charts';
import { VERDICT_SERIES, themeTitle } from '../overview/insights';
import { WindowSelector } from '../overview/WindowSelector';
import { windowDescription, windowRange } from '../overview/window';
import { isOversized } from '../hotspots/hotspots';
import { DigestDialog } from './DigestDialog';
import { LiveBoard } from './LiveBoard';
import { VerdictBar } from './RepositoryCards';
import { agentLabel, kindLabel, trend } from './workspace';
import type { LiveBoardSnapshot } from '../../../../shared/rpc';

/**
 * One repository's hub: what is running in it now, what ran recently, how
 * those sessions went against the previous period, what friction recurs, the
 * rules and skills on disk with how often agents load or skip them, and the
 * improvement plans written for it. Every figure comes from the local index;
 * the digest and the AI door are the only ways anything leaves this page, and
 * both are the user's own explicit action.
 */
interface Props {
  repository: string;
  window: OverviewWindow;
  onWindow: (next: OverviewWindow) => void;
  live: LiveBoardSnapshot | undefined;
  onBack: () => void;
  onOpenSession: (source: string, sessionId: string) => void;
  onOpenSessions: (filters: SessionFilters) => void;
  onAskAi: (prefill: string) => void;
  onImprove: (repository: string) => void;
  onOpenHotspot: (file?: string) => void;
}

export function RepoHub({
  repository,
  window: chosen,
  onWindow,
  live,
  onBack,
  onOpenSession,
  onOpenSessions,
  onAskAi,
  onImprove,
  onOpenHotspot,
}: Props): JSX.Element {
  const [hub, setHub] = useState<RepoHubData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [digestOpen, setDigestOpen] = useState(false);

  const load = useCallback(() => {
    dataHost
      .call('workspace.repoHub', repository, { window: chosen })
      .then((next) => {
        setHub(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [repository, chosen]);

  useEffect(() => {
    load();
    const offProgress = dataHost.on('index.progress', (event) => {
      if (event.event === 'index.progress' && event.status.phase === 'idle') {
        load();
      }
    });
    const offAnalysis = dataHost.on('analysis.progress', () => load());
    return () => {
      offProgress();
      offAnalysis();
    };
  }, [load]);

  const range = windowRange(chosen);
  const question = `What patterns do you see in my recent sessions in ${repository}? Which friction recurs, and what should I change in its context files?`;

  return (
    <div className="repo-hub">
      <header className="workspace-header">
        <button type="button" className="hub-back" onClick={onBack}>
          ← All repositories
        </button>
        <div className="workspace-title">
          <h1 title={repository}>{shortRepo(repository)}</h1>
          <WindowSelector value={chosen} onChange={onWindow} />
        </div>
        <p>
          {repository}
          {hub !== undefined && 'root' in hub.inventory && (
            <>
              {' · '}
              <span className="hub-root" title="Local checkout (shown on this computer only)">
                {hub.inventory.root}
              </span>
            </>
          )}
        </p>
        <div className="hub-actions">
          <button
            type="button"
            className="modal-btn"
            onClick={() => onOpenSessions({ repository, ...range })}
          >
            See all sessions
          </button>
          <button type="button" className="modal-btn" onClick={() => onImprove(repository)}>
            Improve context files
          </button>
          <button type="button" className="modal-btn" onClick={() => setDigestOpen(true)}>
            Copy digest as Markdown
          </button>
          <button
            type="button"
            className="modal-btn"
            title="Opens the AI Helper with this question filled in. Nothing is sent until you press Send."
            onClick={() => onAskAi(question)}
          >
            Ask AI Helper about this repository
          </button>
        </div>
      </header>

      {error !== undefined && <div className="settings-error">{error}</div>}

      <LiveBoard snapshot={live} repository={repository} onOpenSession={onOpenSession} />

      {hub === undefined && error === undefined && (
        <div className="detail-loading" role="status" aria-live="polite">
          <Spinner size={36} stroke={3} />
          <p className="detail-loading-title">Reading the repository…</p>
        </div>
      )}

      {hub !== undefined && (
        <>
          <Totals hub={hub} />

          <div className="overview-split">
            <section className="card" aria-label="How sessions went">
              <div className="card-head">
                <h2>How sessions went</h2>
                <span className="card-note">
                  {hub.status.running ? 'analysis running…' : `${hub.status.analyzed} of ${hub.status.total} analyzed`}
                </span>
              </div>
              <VerdictBar verdicts={hub.verdicts} />
              <Legend series={VERDICT_SERIES} />
              <ul className="hub-verdict-list">
                {VERDICT_SERIES.map((series) => {
                  const key = series.key as keyof RepoHubData['verdicts'];
                  const t = trend(hub.verdicts[key], hub.previousVerdicts[key]);
                  return (
                    <li key={series.key}>
                      <button
                        type="button"
                        className="table-link"
                        disabled={series.key === 'unjudged' || hub.verdicts[key] === 0}
                        onClick={() =>
                          series.key !== 'unjudged' &&
                          onOpenSessions({ repository, verdict: key as Exclude<typeof key, 'unjudged'>, ...range })
                        }
                      >
                        {series.label}
                      </button>
                      <span className="n">{hub.verdicts[key]}</span>
                      {hub.window !== 'all' && <span className="hub-trend">{t.label}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="card" aria-label="Recurring friction">
              <div className="card-head">
                <h2>Recurring friction</h2>
                <span className="card-note">sessions affected, {windowDescription(hub.window)}</span>
              </div>
              <HorizontalBars
                rows={hub.themes.map((theme) => ({
                  label:
                    hub.window === 'all' || theme.previousSessions === theme.sessions
                      ? themeLabel(theme.signalId)
                      : `${themeLabel(theme.signalId)} (${trend(theme.sessions, theme.previousSessions).label})`,
                  value: theme.sessions,
                  title: themeTitle(theme),
                }))}
                colorVar="--verdict-struggled"
                emptyMessage="No recurring friction in this window."
                onSelect={(index) => onOpenSessions({ repository, signal: hub.themes[index].signalId, ...range })}
              />
            </section>
          </div>

          <section className="card" aria-label="Recent sessions">
            <div className="card-head">
              <h2>Recent sessions</h2>
              <button type="button" className="table-link" onClick={() => onOpenSessions({ repository, ...range })}>
                See all
              </button>
            </div>
            {hub.recent.length === 0 ? (
              <p className="chart-empty">No sessions in this window.</p>
            ) : (
              <table className="source-table hub-sessions">
                <tbody>
                  {hub.recent.map((row) => (
                    <tr key={`${row.source}:${row.sessionId}`} className="row-selectable">
                      <td>
                        <button
                          type="button"
                          className="table-link"
                          onClick={() => onOpenSession(row.source, row.sessionId)}
                        >
                          {row.title ?? 'Untitled session'}
                        </button>
                      </td>
                      <td>{sourceLabel(row.source)}</td>
                      <td>{showsVerdictChip(row.verdict) ? verdictLabel(row.verdict) : '—'}</td>
                      <td className="n">{formatTokens(row.inputTokens + row.outputTokens)}</td>
                      <td className="n">{row.costMicros !== undefined ? formatCost(row.costMicros) : 'n/a'}</td>
                      <td>{formatRelative(row.endedAtMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <RulesAndSkills hub={hub} onOpenHotspot={onOpenHotspot} />

          <div className="overview-split">
            <section className="card" aria-label="Context improvement plans">
              <div className="card-head">
                <h2>Context improvement plans</h2>
                <button type="button" className="table-link" onClick={() => onImprove(repository)}>
                  Open Improve
                </button>
              </div>
              {hub.plans.length === 0 ? (
                <p className="chart-empty">No plans written for this repository yet.</p>
              ) : (
                <ul className="hub-plans">
                  {hub.plans.map((plan) => (
                    <li key={plan.id}>
                      <span>{plan.summary ?? `${plan.editCount} proposed ${plan.editCount === 1 ? 'edit' : 'edits'}`}</span>
                      <span className="card-caption">
                        {formatRelative(plan.createdAtMs)} · {plan.backendLabel} · {plan.appliedCount} of {plan.editCount}{' '}
                        applied
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-label="Models">
              <div className="card-head">
                <h2>Models</h2>
              </div>
              {hub.models.length === 0 ? (
                <p className="chart-empty">No sessions in this window.</p>
              ) : (
                <table className="source-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="n">Sessions</th>
                      <th className="n">Tokens</th>
                      <th className="n">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hub.models.map((row) => (
                      <tr key={row.model}>
                        <td>{row.model}</td>
                        <td className="n">{row.sessions}</td>
                        <td className="n">{formatTokens(row.inputTokens + row.outputTokens).replace(' tokens', '')}</td>
                        <td className="n">{row.costMicros === null ? 'n/a' : formatCost(row.costMicros) || '$0.00'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}

      {digestOpen && (
        <DigestDialog repository={repository} window={chosen} onClose={() => setDigestOpen(false)} />
      )}
    </div>
  );
}

function Totals({ hub }: { hub: RepoHubData }): JSX.Element {
  const sessions = trend(hub.totals.sessions, hub.previousTotals.sessions);
  const previous = hub.window === 'all' ? '' : ` (${sessions.label} vs previous ${hub.windowDays} days)`;
  return (
    <div className="tiles tiles-compact">
      <Tile label={`Sessions${previous}`} value={String(hub.totals.sessions)} />
      <Tile label="Tool calls" value={hub.totals.toolCalls.toLocaleString()} />
      <Tile label="Tokens" value={formatTokens(hub.totals.inputTokens + hub.totals.outputTokens).replace(' tokens', '')} />
      <Tile
        label={hub.totals.costSessions === 0 ? 'Est. cost' : `Est. cost (${hub.totals.costSessions} of ${hub.totals.sessions} priced)`}
        value={hub.totals.costSessions === 0 ? 'n/a' : formatCost(hub.totals.costMicros)}
      />
      <Tile label="Models" value={String(hub.totals.models)} />
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="tile">
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function RulesAndSkills({
  hub,
  onOpenHotspot,
}: {
  hub: RepoHubData;
  onOpenHotspot: (file?: string) => void;
}): JSX.Element {
  const inventory = hub.inventory;
  return (
    <section className="card" aria-label="Rules and skills">
      <div className="card-head">
        <h2>Rules &amp; skills</h2>
        <button type="button" className="table-link" onClick={() => onOpenHotspot()}>
          Open Context Hotspots
        </button>
      </div>
      {'error' in inventory ? (
        <p className="card-caption">{inventory.error}</p>
      ) : inventory.files.length === 0 ? (
        <p className="chart-empty">No context files found in this checkout.</p>
      ) : (
        <>
          <p className="card-caption">
            Found on disk in the checkout, with how often indexed sessions loaded or skipped each file.
            {inventory.truncated && ' The scan hit its file budget; some files may be missing.'}
          </p>
          <table className="source-table hub-inventory">
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>For</th>
                <th className="n">Est. tokens</th>
                <th className="n">Loaded</th>
                <th className="n">Skipped</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inventory.files.map((file) => (
                <InventoryRow key={file.relPath} file={file} onOpenHotspot={onOpenHotspot} />
              ))}
            </tbody>
          </table>
          {inventory.outsideRepo.length > 0 && (
            <p className="card-caption">
              Also loaded from outside the checkout:{' '}
              {inventory.outsideRepo.map((row, i) => (
                <span key={row.file}>
                  {i > 0 && ', '}
                  <button type="button" className="table-link" onClick={() => onOpenHotspot(row.file)} title={row.file}>
                    {row.name}
                  </button>
                </span>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function InventoryRow({
  file,
  onOpenHotspot,
}: {
  file: ContextInventoryFile;
  onOpenHotspot: (file?: string) => void;
}): JSX.Element {
  const usage = file.usage;
  const oversized = isOversized(file.estTokens);
  return (
    <tr className={usage === undefined ? 'hub-inventory-unused' : undefined}>
      <td>
        <code>{file.relPath}</code>
      </td>
      <td>{kindLabel(file.kind)}</td>
      <td>{agentLabel(file.agent)}</td>
      <td className="n" title={oversized ? 'Over the size guideline; loaded in full every time' : undefined}>
        {file.estTokens.toLocaleString()}
        {oversized && ' ⚠'}
      </td>
      <td className="n">{usage === undefined ? '—' : `${usage.appliedCount} of ${usage.sessionCount}`}</td>
      <td className="n">{usage === undefined ? '—' : usage.skippedCount}</td>
      <td>
        {usage !== undefined ? (
          <button type="button" className="table-link" onClick={() => onOpenHotspot(usage.file)}>
            Review
          </button>
        ) : (
          <span className="card-caption">unused so far</span>
        )}
      </td>
    </tr>
  );
}
