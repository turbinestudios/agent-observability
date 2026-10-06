import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type {
  IndexStatus,
  OverviewData,
  OverviewInsights,
  OverviewWindow,
  RetroVerdict,
} from '../../../../shared/rpc';
import {
  formatCost,
  formatDuration,
  formatTokens,
  shortRepo,
  sourceLabel,
  splitNotes,
} from '../sessions/format';
import type { SessionFilters } from '../sessions/filters';
import { isoDayRange } from '../sessions/filters';
import { themeLabel } from '../sessions/retro';
import { categoryLabel, describeProgress, shortPath } from '../hotspots/hotspots';
import { Spinner } from '../../components/Spinner';
import { HorizontalBars, Legend, StackedBarChart } from './charts';
import type { SeriesStyle, StackedColumn } from './charts';
import { VERDICT_SERIES, themeTitle, verdictColumns } from './insights';
import { persistWindow, readStoredWindow, windowDescription, windowRange } from './window';
import { WindowSelector } from './WindowSelector';
import { reportedDoneFilter, reportedDoneLine } from '../retro/completionCounts';
import { REWORK_EXPLANATION, reworkRateLine, reworkSessionLine, reworkedFilter } from '../retro/rework';
import { TOOL_FAILURE_MIN_CALLS } from '../../../../shared/rpc';
import './overview.css';

/**
 * What this machine's agent activity adds up to.
 *
 * Everything here is aggregated in SQL over the session index, so opening the
 * view costs a few milliseconds and never re-reads a transcript. It loads on
 * first open rather than at startup, so it cannot compete with the session
 * list for the launch path.
 */

/**
 * Fixed hue order, assigned by identity rather than by rank — a source keeps
 * its color when another one out-counts it. Slots come from the validated
 * categorical palette; see overview.css for the values.
 */
const SOURCE_SERIES: SeriesStyle[] = [
  { key: 'claude', label: 'Claude Code', colorVar: '--series-1' },
  { key: 'copilot', label: 'Copilot', colorVar: '--series-2' },
  { key: 'copilot-cli', label: 'Copilot CLI', colorVar: '--series-cli' },
  { key: 'copilot-app', label: 'Copilot app', colorVar: '--series-app' },
  { key: 'copilot-jetbrains', label: 'Copilot (JetBrains)', colorVar: '--series-jetbrains' },
];

const TOKEN_SERIES: SeriesStyle[] = [
  { key: 'input', label: 'Input', colorVar: '--series-3' },
  { key: 'output', label: 'Output', colorVar: '--series-4' },
];

interface Props {
  /**
   * Open the session list narrowed to what was clicked. Every drill-down also
   * carries the active window, so the list answers the same question the mark
   * did — a repository whose bar reads 12 must not open 400 sessions.
   */
  onOpenSessions?: (filters: SessionFilters) => void;
  /**
   * Open the Context Hotspots view, focused on one file — or on nothing, for
   * the card's "view all". Optional for the same reason `onOpenSessions` is.
   */
  onOpenHotspot?: (file?: string) => void;
}

export function OverviewView({ onOpenSessions, onOpenHotspot }: Props): JSX.Element {
  const [data, setData] = useState<OverviewData | undefined>(undefined);
  const [insights, setInsights] = useState<OverviewInsights | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<IndexStatus | undefined>(undefined);
  const [chosen, setChosen] = useState<OverviewWindow>(readStoredWindow);
  /**
   * A window change is in flight.
   *
   * Re-aggregating is usually milliseconds, but the data host is single-threaded
   * — behind an index pass it can be ten seconds or more. Until it answers, the
   * page still shows the PREVIOUS window's numbers under a control that has
   * already moved, which reads as the button having done nothing.
   */
  const [switching, setSwitching] = useState(false);

  /**
   * Set just before a user-initiated change, and consumed by the fetch it
   * causes. Only that case earns the spinner: the background refresh after an
   * index pass would otherwise flash one over the page unprompted.
   */
  const userChanged = useRef(false);
  /** Guards against a slow window's answer landing after a later one's. */
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = (generation.current += 1);
    const blocking = userChanged.current;
    userChanged.current = false;
    if (blocking) {
      setSwitching(true);
    }
    dataHost
      .call('overview.get', { window: chosen })
      .then((next) => {
        if (generation.current !== mine) {
          return; // a later window was chosen while this was in flight
        }
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => {
        if (generation.current === mine) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (generation.current === mine) {
          setSwitching(false);
        }
      });
  }, [chosen]);

  /**
   * The insight section loads beside the cost data, not with it: it follows the
   * ANALYSIS pass rather than the indexer, so it refreshes as verdicts land. A
   * generation guard drops a slow window's answer arriving after a later one's,
   * exactly like `load`'s; a failure degrades to the section's pending line
   * rather than taking the whole page down.
   */
  const insightsGeneration = useRef(0);
  const loadInsights = useCallback(() => {
    const mine = (insightsGeneration.current += 1);
    dataHost
      .call('overview.insights', { window: chosen })
      .then((next) => {
        if (insightsGeneration.current === mine) {
          setInsights(next);
        }
      })
      .catch(() => undefined);
  }, [chosen]);

  useEffect(() => {
    load();
    loadInsights();
    void dataHost
      .call('index.status')
      .then(setStatus)
      .catch(() => undefined);
    // Totals shift as the indexer hydrates; refresh once a pass settles rather
    // than on every batch, which would make the numbers flicker upward.
    const offIndex = dataHost.on('index.progress', (event) => {
      if (event.event === 'index.progress') {
        setStatus(event.status);
        if (event.status.phase === 'idle') {
          load();
          loadInsights();
        }
      }
    });
    // Verdicts and findings land batch by batch; the hero fills in as they do,
    // the way the Retro and Hotspots views already follow this event.
    const offAnalysis = dataHost.on('analysis.progress', (event) => {
      if (event.event === 'analysis.progress') {
        loadInsights();
      }
    });
    return () => {
      offIndex();
      offAnalysis();
    };
  }, [load, loadInsights]);

  const days = useMemo(() => (data === undefined ? [] : buildDays(data)), [data]);

  const chooseWindow = useCallback(
    (next: OverviewWindow) => {
      if (next === chosen) {
        return; // re-picking the active window would spin for nothing
      }
      // The control itself moves immediately; the numbers follow when the data
      // host answers, and the spinner covers the gap between the two.
      userChanged.current = true;
      setChosen(next);
      persistWindow(next);
    },
    [chosen],
  );

  /**
   * Everything a drill-down carries by default: the window that produced the
   * figure being clicked. A mark opens the sessions BEHIND it, which means the
   * same slice, not the whole history.
   */
  const baseFilters = useMemo((): SessionFilters => windowRange(chosen), [chosen]);

  const selector = <WindowSelector value={chosen} onChange={chooseWindow} />;

  /**
   * Floats over the middle of the view while a new window is being aggregated.
   *
   * The stale figures stay on screen beneath it rather than being blanked:
   * they are what the page said a moment ago, and replacing them with an empty
   * frame would lose the comparison the user is in the middle of making.
   * Pointer events stay off so the page underneath is still scrollable.
   */
  const busy = switching ? (
    <div className="overview-busy" role="status" aria-label="Updating the dashboard">
      <span className="overview-busy-chip">
        <Spinner size={44} stroke={3} />
      </span>
    </div>
  ) : null;

  if (error !== undefined) {
    return (
      <div className="placeholder">
        <div>
          <h2>Could not load the overview</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  // An empty answer mid-scan is not the real answer; keep the spinner until
  // the pass settles so a fresh machine never flashes zeros that then fill in.
  const scanning = status?.phase === 'discovering' || status?.phase === 'hydrating';
  if (data === undefined || (data.totals.sessions === 0 && scanning)) {
    return (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
        <p className="detail-loading-title">Reading totals…</p>
      </div>
    );
  }

  if (data.totals.sessions === 0) {
    // Two very different empty pages, and telling them apart matters: an
    // all-time zero really is a first run, but a windowed zero is a quiet week
    // — and saying "no sessions yet" to someone with two years of history,
    // with no way back to them, would be the worst thing this window could do.
    const notes = splitNotes(status?.message);
    const quietWindow = chosen !== 'all';
    return (
      <>
        {busy}
        <div className="overview">
        <header className="overview-header">
          <div className="overview-title">
            <h1>Dashboard</h1>
            {selector}
          </div>
        </header>
        <div className="placeholder">
          <div>
            <h2>{quietWindow ? `Nothing in ${windowDescription(chosen)}` : 'No sessions yet'}</h2>
            <p>
              {quietWindow
                ? 'No sessions ended in this window. Try a longer one — All time covers everything recorded on this machine.'
                : 'Sessions appear here once you have used Claude Code or GitHub Copilot on this machine. Everything stays local — nothing is uploaded.'}
            </p>
            {!quietWindow && notes.length > 0 && (
              <ul className="overview-empty-notes">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {!quietWindow && (
              <p style={{ marginTop: 12, color: 'var(--fg-subtle)' }}>
                Sources and paths can be adjusted in Settings (the gear icon).
              </p>
            )}
          </div>
        </div>
        </div>
      </>
    );
  }

  const { totals } = data;
  const sessionColumns: StackedColumn[] = days.map((day) => ({
    label: day.short,
    fullLabel: day.long,
    segments: SOURCE_SERIES.map((s) => ({ key: s.key, value: day.sessionsBySource[s.key] ?? 0 })),
  }));
  const tokenColumns: StackedColumn[] = days.map((day) => ({
    label: day.short,
    fullLabel: day.long,
    segments: [
      { key: 'input', value: day.inputTokens },
      { key: 'output', value: day.outputTokens },
    ],
  }));
  const costColumns: StackedColumn[] = days.map((day) => ({
    label: day.short,
    fullLabel: day.long,
    segments: SOURCE_SERIES.map((s) => ({ key: s.key, value: day.costBySource[s.key] ?? 0 })),
  }));

  // Only where the chart span is narrower than the tiles above it, which is
  // exactly when the two could be misread as answering the same question.
  const spanNote =
    data.dailyCapped === true ? `charts cover the last ${data.windowDays} days` : undefined;

  /**
   * Clicking a day column opens exactly that day — a one-day range replacing
   * the window's, since the column counted one day, not the window.
   */
  const openDay =
    onOpenSessions === undefined
      ? undefined
      : (index: number): void => {
          const day = days[index];
          if (day !== undefined) {
            onOpenSessions(isoDayRange(day.iso));
          }
        };

  const heroColumns = insights === undefined ? [] : verdictColumns(days, insights.verdictDaily);
  const progressNote = insights === undefined ? undefined : describeProgress(insights.status);
  // How the analysis is doing, for the cards that can only be as complete as it
  // is. The hero needs no such line — its gray "not analyzed" series says the
  // same thing in the chart itself.
  const analysisPending =
    insights !== undefined &&
    (insights.status.running || insights.status.analyzed < insights.status.total);

  /**
   * A colored slice answers with that day AND that verdict; the gray coverage
   * slice declines (returns false) and falls through to the whole day — "the
   * sessions nobody has judged yet" is not a question this page can pose
   * honestly while the analysis is still running through them.
   */
  const openVerdictSegment =
    onOpenSessions === undefined
      ? undefined
      : (index: number, seriesKey: string): boolean | void => {
          const day = days[index];
          if (day === undefined || !isVerdictKey(seriesKey)) {
            return false;
          }
          onOpenSessions({ ...isoDayRange(day.iso), verdict: seriesKey });
        };

  return (
    <>
    {busy}
    <div className="overview">
      <header className="overview-header">
        <div className="overview-title">
          <h1>Dashboard</h1>
          {selector}
        </div>
        <p>
          {chosen === 'all'
            ? 'Everything recorded on this machine.'
            : `Sessions from ${windowDescription(chosen)}.`}{' '}
          Nothing here has been uploaded — all of it is read from your own agent logs. Click a bar,
          a row, or a day to see the sessions behind it.
        </p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>How sessions went</h2>
          {progressNote !== undefined && <span className="card-note">{progressNote}</span>}
          <Legend series={VERDICT_SERIES} />
        </div>
        {insights === undefined ? (
          <div className="chart-loading" role="status" aria-live="polite">
            <Spinner size={28} stroke={3} />
            <span>Reading how sessions went…</span>
          </div>
        ) : (
          <StackedBarChart
            columns={heroColumns}
            series={VERDICT_SERIES}
            formatValue={(v) => v.toLocaleString()}
            emptyMessage={`No sessions in the last ${insights.windowDays} days.`}
            onSelect={openDay}
            onSelectSegment={openVerdictSegment}
          />
        )}
      </section>

      <div className="overview-split" style={{ marginBottom: 14 }}>
        <section className="card">
          <div className="card-head">
            <h2>Recurring friction themes</h2>
          </div>
          {insights === undefined || insights.themes.length === 0 ? (
            <p className="chart-empty">
              {insights === undefined || analysisPending
                ? 'No recurring friction found yet — the analysis is still reading sessions.'
                : 'No recurring friction in this window.'}
            </p>
          ) : (
            <>
              <HorizontalBars
                rows={insights.themes.map((theme) => ({
                  label: themeLabel(theme.signalId),
                  value: theme.sessions,
                  title: themeTitle(theme),
                }))}
                colorVar="--verdict-bumpy"
                emptyMessage="No recurring friction in this window."
                onSelect={
                  onOpenSessions === undefined
                    ? undefined
                    : (index) =>
                        onOpenSessions({ ...baseFilters, signal: insights.themes[index].signalId })
                }
              />
              <p className="card-caption">
                Retrospective findings ranked by how many sessions raised them in this window.
              </p>
            </>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Reported done, not verified</h2>
            <span className="card-note">sessions that changed code</span>
          </div>
          {insights?.evidence?.completion === undefined ? (
            <p className="chart-empty">Not analysed yet.</p>
          ) : (
            <>
              <p className="completion-headline">
                {onOpenSessions !== undefined && insights.evidence.completion.reportedDoneUnverified > 0 ? (
                  <button
                    type="button"
                    className="table-link"
                    onClick={() => onOpenSessions(reportedDoneFilter(baseFilters))}
                  >
                    {reportedDoneLine(insights.evidence.completion)}
                  </button>
                ) : (
                  reportedDoneLine(insights.evidence.completion)
                )}
              </p>
              <p className="card-caption">
                The last reply reported the work as done, and no test, build, lint or type-check with an observed
                result was seen after the last code edit. Checks run elsewhere are not visible.
              </p>
            </>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Rework</h2>
            <span className="card-note">sessions that edited files</span>
          </div>
          {insights?.evidence?.rework === undefined ? (
            <p className="chart-empty">Not analysed yet.</p>
          ) : (
            <>
              <p className="completion-headline">
                {onOpenSessions !== undefined && insights.evidence.rework.reworkedSessions > 0 ? (
                  <button type="button" className="table-link" onClick={() => onOpenSessions(reworkedFilter(baseFilters))}>
                    {reworkRateLine(insights.evidence.rework.reworkedSessions, insights.evidence.rework.editedSessions)}
                  </button>
                ) : (
                  reworkRateLine(insights.evidence.rework.reworkedSessions, insights.evidence.rework.editedSessions)
                )}
              </p>
              {insights.evidence.rework.sessions.length > 0 && (
                <ul className="rework-top">
                  {insights.evidence.rework.sessions.map((row) => (
                    <li key={`${row.source}:${row.sessionId}`}>
                      <span>{row.title ?? 'Untitled session'}</span>{' '}
                      <span className="card-caption">{reworkSessionLine(row)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="card-caption">{REWORK_EXPLANATION}</p>
            </>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Tools that fail most</h2>
            <span className="card-note">
              failure rate in percent, tools with at least {TOOL_FAILURE_MIN_CALLS} calls
            </span>
          </div>
          {insights === undefined || (insights.evidence?.tools.length ?? 0) === 0 ? (
            <p className="chart-empty">No tool failed often enough to rank in this window.</p>
          ) : (
            <HorizontalBars
              rows={(insights.evidence?.tools ?? []).map((tool) => ({
                label: tool.tool,
                value: Math.round((tool.failures / tool.calls) * 100),
                title: `${tool.failures} of ${tool.calls} calls failed`,
              }))}
              colorVar="--verdict-struggled"
              emptyMessage="No tool failed often enough to rank in this window."
              {...(onOpenSessions !== undefined
                ? {
                    onSelect: (index: number) => {
                      const tool = insights.evidence?.tools[index];
                      if (tool !== undefined) {
                        onOpenSessions({ ...baseFilters, tool: tool.tool, toolFailed: true });
                      }
                    },
                  }
                : {})}
            />
          )}
        </section>

        <section className="card card-wide">
          <div className="card-head">
            <h2>Context hotspots to review</h2>
            {onOpenHotspot !== undefined && insights !== undefined && insights.hotspots.length > 0 && (
              <button
                type="button"
                className="table-link card-note"
                onClick={() => onOpenHotspot()}
              >
                View all
              </button>
            )}
          </div>
          {insights === undefined || insights.hotspots.length === 0 ? (
            <p className="chart-empty">
              {insights === undefined || analysisPending
                ? 'No context files seen yet — the analysis is still reading sessions.'
                : 'No context files seen in this window.'}
            </p>
          ) : (
            <>
              <div className="card-table-scroll">
              <table className="source-table">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Kind</th>
                    <th scope="col" className="n">Score</th>
                    <th scope="col" className="n">Skipped</th>
                    <th scope="col" className="n">Max tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {insights.hotspots.map((row) => (
                    <tr
                      key={row.file}
                      className={onOpenHotspot === undefined ? undefined : 'row-selectable'}
                    >
                      <th scope="row" title={row.file}>
                        {onOpenHotspot === undefined ? (
                          shortPath(row.file)
                        ) : (
                          <button
                            type="button"
                            className="table-link"
                            aria-label={`${row.file} — review in Context Hotspots`}
                            onClick={() => onOpenHotspot(row.file)}
                          >
                            {shortPath(row.file)}
                          </button>
                        )}
                      </th>
                      <td>{categoryLabel(row.category)}</td>
                      <td className="n">{Math.round(row.score)}</td>
                      <td className="n">
                        {row.skippedCount.toLocaleString()} of{' '}
                        {(row.appliedCount + row.skippedCount).toLocaleString()}
                      </td>
                      <td className="n">{row.estTokensMax.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="card-caption">
                Scored 0–100 from skip rate, error and deviation co-occurrence, token weight, and
                how often the file is applied. Higher means look first.
              </p>
            </>
          )}
        </section>
      </div>

      <section className="tiles tiles-compact" aria-label="Totals">
        <Tile label="Sessions" value={totals.sessions.toLocaleString()} />
        <Tile label="Steps" value={totals.steps.toLocaleString()} />
        <Tile
          label="LLM calls"
          value={totals.llmCalls.toLocaleString()}
          hint="Model calls across every session"
        />
        <Tile
          label="Tool calls"
          value={totals.toolCalls.toLocaleString()}
          hint="Tool executions across every session (file edits, searches, commands)"
        />
        <Tile label="Input tokens" value={formatTokens(totals.inputTokens).replace(' tokens', '')} />
        <Tile label="Output tokens" value={formatTokens(totals.outputTokens).replace(' tokens', '')} />
        <Tile
          label="Cached"
          value={formatTokens(totals.cachedTokens).replace(' tokens', '')}
          hint="Prompt tokens served from cache rather than re-read"
        />
        <Tile
          label="Est. cost"
          value={totals.costSessions === 0 ? 'n/a' : formatCost(totals.costMicros)}
          hint={
            `Estimated from token rates (Claude Code) and billed premium-unit usage (Copilot). ` +
            `Covers ${totals.costSessions.toLocaleString()} of ${totals.sessions.toLocaleString()} sessions; ` +
            `the rest could not be priced.`
          }
        />
        <Tile label="Repositories" value={totals.repositories.toLocaleString()} />
        <Tile label="Models" value={totals.models.toLocaleString()} />
        <Tile
          label="Avg session"
          value={formatDuration(totals.avgSessionMs)}
          hint="Mean wall-clock length of a session"
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Sessions per day</h2>
          {spanNote !== undefined && <span className="card-note">{spanNote}</span>}
          <Legend series={SOURCE_SERIES} />
        </div>
        <StackedBarChart
          columns={sessionColumns}
          series={SOURCE_SERIES}
          formatValue={(v) => v.toLocaleString()}
          emptyMessage={`No sessions in the last ${data.windowDays} days.`}
          onSelect={openDay}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Tokens per day</h2>
          {spanNote !== undefined && <span className="card-note">{spanNote}</span>}
          <Legend series={TOKEN_SERIES} />
        </div>
        <StackedBarChart
          columns={tokenColumns}
          series={TOKEN_SERIES}
          formatValue={(v) => formatTokens(v).replace(' tokens', '')}
          emptyMessage={`No token usage recorded in the last ${data.windowDays} days.`}
          onSelect={openDay}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Cost per day</h2>
          {spanNote !== undefined && <span className="card-note">{spanNote}</span>}
          <Legend series={SOURCE_SERIES} />
        </div>
        <StackedBarChart
          columns={costColumns}
          series={SOURCE_SERIES}
          formatValue={(v) => formatCost(v) || '$0.00'}
          emptyMessage={`No cost data in the last ${data.windowDays} days.`}
          onSelect={openDay}
        />
      </section>

      <div className="overview-split">
        <section className="card">
          <div className="card-head">
            <h2>Busiest repositories</h2>
            {data.totals.repositories > data.topRepositories.length && (
              // Say what is being left out, rather than letting a truncated
              // list read as the whole picture.
              <span className="card-note">
                top {data.topRepositories.length} of {data.totals.repositories}
              </span>
            )}
          </div>
          <HorizontalBars
            rows={data.topRepositories.map((r) => ({
              label: shortRepo(r.repository),
              value: r.sessions,
              title: r.repository,
            }))}
            colorVar="--series-1"
            emptyMessage="No sessions have a resolved repository yet."
            onSelect={
              onOpenSessions === undefined
                ? undefined
                : (index) =>
                    onOpenSessions({
                      ...baseFilters,
                      repository: data.topRepositories[index].repository,
                    })
            }
          />
        </section>

        {/*
          The same numbers as the charts, in text. Beyond being useful on its
          own, this is the relief for series colors that fall below 3:1 on the
          light surface — identity is never left to color alone.
        */}
        <section className="card">
          <div className="card-head">
            <h2>By source</h2>
          </div>
          <table className="source-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col" className="n">Sessions</th>
                <th scope="col" className="n">Steps</th>
                <th scope="col" className="n">Tokens</th>
                <th scope="col" className="n">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {data.bySource.map((row) => (
                <tr
                  key={row.source}
                  className={onOpenSessions === undefined ? undefined : 'row-selectable'}
                >
                  <th scope="row">
                    <span
                      className="legend-swatch"
                      style={{ background: `var(${colorVarFor(row.source)})` }}
                    />
                    {onOpenSessions === undefined ? (
                      sourceLabel(row.source)
                    ) : (
                      <button
                        type="button"
                        className="table-link"
                        aria-label={`${sourceLabel(row.source)} — show these sessions`}
                        onClick={() => onOpenSessions({ ...baseFilters, source: row.source })}
                      >
                        {sourceLabel(row.source)}
                      </button>
                    )}
                  </th>
                  <td className="n">{row.sessions.toLocaleString()}</td>
                  <td className="n">{row.steps.toLocaleString()}</td>
                  <td className="n">
                    {formatTokens(row.inputTokens + row.outputTokens).replace(' tokens', '')}
                  </td>
                  <td className="n">{formatCost(row.costMicros) || '$0.00'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Cost by model</h2>
            {data.totals.models > data.byModel.length && (
              <span className="card-note">
                top {data.byModel.length} of {data.totals.models}
              </span>
            )}
          </div>
          <table className="source-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="n">Sessions</th>
                <th scope="col" className="n">LLM calls</th>
                <th scope="col" className="n">Tokens</th>
                <th scope="col" className="n">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((row) => (
                <tr key={row.model}>
                  <th scope="row" title={row.model}>{row.model}</th>
                  <td className="n">{row.sessions.toLocaleString()}</td>
                  <td className="n">{row.llmCalls.toLocaleString()}</td>
                  <td className="n">
                    {formatTokens(row.inputTokens + row.outputTokens).replace(' tokens', '')}
                  </td>
                  <td className="n">
                    {row.costMicros === null ? (
                      <span className="cost-na" title="No session of this model could be priced">
                        n/a
                      </span>
                    ) : (
                      formatCost(row.costMicros) || '$0.00'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="card-caption">
            A session's cost is attributed to its most-used model. "n/a" means the model could not
            be priced — not that it was free.
          </p>
        </section>
      </div>
    </div>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="tile" title={hint}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}


interface DayBucket {
  /** `YYYY-MM-DD`, local — the identity a click on this column drills into. */
  iso: string;
  short: string;
  long: string;
  sessionsBySource: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  /** Estimated micro-USD per source; unpriced sessions contribute nothing. */
  costBySource: Record<string, number>;
}

/**
 * Expand the sparse daily rows into one bucket per day.
 *
 * The query omits days with no activity; leaving them out of the chart would
 * compress the gaps and make a quiet week look continuous.
 */
function buildDays(data: OverviewData): DayBucket[] {
  const byDay = new Map<string, DayBucket>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = data.windowDays - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const iso = isoDay(date);
    byDay.set(iso, {
      iso,
      short: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      long: date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      sessionsBySource: {},
      inputTokens: 0,
      outputTokens: 0,
      costBySource: {},
    });
  }

  for (const point of data.daily) {
    const bucket = byDay.get(point.day);
    if (bucket === undefined) {
      continue; // outside the window (clock skew, or a future-dated row)
    }
    bucket.sessionsBySource[point.source] = (bucket.sessionsBySource[point.source] ?? 0) + point.sessions;
    bucket.inputTokens += point.inputTokens;
    bucket.outputTokens += point.outputTokens;
    bucket.costBySource[point.source] = (bucket.costBySource[point.source] ?? 0) + point.costMicros;
  }

  return [...byDay.values()];
}

/** `YYYY-MM-DD` in local time, matching the SQL grouping. */
function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function colorVarFor(source: string): string {
  const known = SOURCE_SERIES.findIndex((s) => s.key === source);
  return known >= 0 ? SOURCE_SERIES[known].colorVar : '--series-3';
}

/** Whether a hero series key is a real verdict — 'unjudged' is coverage, not one. */
function isVerdictKey(key: string): key is RetroVerdict {
  return key === 'smooth' || key === 'bumpy' || key === 'struggled' || key === 'abandoned';
}
