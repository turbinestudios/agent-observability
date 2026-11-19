import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { EvidenceSummaryResult, OverviewWindow, RetroVerdict } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import type { SessionFilters } from '../sessions/filters';
import { isoDayRange } from '../sessions/filters';
import { formatCost, formatDuration, formatTokens, shortRepo, sourceLabel } from '../sessions/format';
import { describeProgress } from '../hotspots/hotspots';
import { HorizontalBars, Legend, StackedBarChart } from '../overview/charts';
import type { SeriesStyle, StackedColumn } from '../overview/charts';
import { VERDICT_SERIES } from '../overview/insights';
import { SOURCE_SERIES, sourceColorVar } from '../overview/series';
import { WindowSelector } from '../overview/WindowSelector';
import { persistWindow, readStoredWindow, windowDescription, windowRange } from '../overview/window';
import {
  buildSummaryDays,
  codeCoverageLine,
  codeRecorded,
  editRecordingAgents,
  costCoverageLine,
  persistScope,
  readStoredScope,
  scopeDescription,
  scopeFilters,
  scopeParams,
  type SummaryScope,
} from './summary';
import '../overview/overview.css';

/**
 * Evidence > Summary: everything one repository, or one tag, adds up to —
 * tokens, cost, run time, code changed, which agents did the work and how it
 * went. Aggregated in SQL over the local index; tags never leave the machine.
 */
interface Props {
  onOpenSessions: (filters: SessionFilters) => void;
}

const LINE_SERIES: SeriesStyle[] = [
  { key: 'added', label: 'Added', colorVar: '--series-3' },
  { key: 'removed', label: 'Removed', colorVar: '--series-4' },
];

export function SummaryTab({ onOpenSessions }: Props): JSX.Element {
  const [chosen, setChosen] = useState<OverviewWindow>(readStoredWindow);
  const [scope, setScope] = useState<SummaryScope>(readStoredScope);
  const [data, setData] = useState<EvidenceSummaryResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Guards against a slow answer for an earlier scope landing after a later one. */
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = (generation.current += 1);
    dataHost
      .call('evidence.summary', { window: chosen, ...scopeParams(scope) })
      .then((next) => {
        if (generation.current === mine) {
          setData(next);
          setError(undefined);
        }
      })
      .catch((err: Error) => {
        if (generation.current === mine) {
          setError(err.message);
        }
      });
  }, [chosen, scope]);

  useEffect(() => {
    load();
    // Code figures and verdicts land with the analysis, so the tab follows it.
    return dataHost.on('analysis.progress', () => load());
  }, [load]);

  const chooseWindow = (next: OverviewWindow): void => {
    setChosen(next);
    persistWindow(next);
  };
  const chooseScope = (next: SummaryScope): void => {
    setScope(next);
    persistScope(next);
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

  const { totals, code } = data;
  const base: SessionFilters = { ...scopeFilters(scope), ...windowRange(chosen) };
  const progress = describeProgress(data.status);
  const codeCoverage = codeCoverageLine(data);
  const recorded = codeRecorded(code);
  const codeHint = (what: string): string =>
    `${what}, from the file edits the analysis read. ${
      codeCoverage === undefined ? '' : `${codeCoverage[0].toUpperCase()}${codeCoverage.slice(1)}.`
    }`.trim();
  const spanNote = data.dailyCapped === true ? `charts cover the last ${data.windowDays} days` : undefined;

  const days = buildSummaryDays(data.daily, data.windowDays);
  const column = (day: (typeof days)[number]): Pick<StackedColumn, 'label' | 'fullLabel'> => ({
    label: day.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    fullLabel: day.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
  });
  const sessionColumns: StackedColumn[] = days.map((day) => ({
    ...column(day),
    segments: SOURCE_SERIES.map((s) => ({ key: s.key, value: day.sessionsBySource[s.key] ?? 0 })),
  }));
  const costColumns: StackedColumn[] = days.map((day) => ({
    ...column(day),
    segments: SOURCE_SERIES.map((s) => ({ key: s.key, value: day.costBySource[s.key] ?? 0 })),
  }));
  const lineColumns: StackedColumn[] = days.map((day) => ({
    ...column(day),
    segments: [
      { key: 'added', value: day.linesAdded },
      { key: 'removed', value: day.linesRemoved },
    ],
  }));

  /** A day column opens exactly that day, within the same scope. */
  const openDay = (index: number): void => {
    const day = days[index];
    if (day !== undefined) {
      onOpenSessions({ ...scopeFilters(scope), ...isoDayRange(day.iso) });
    }
  };
  const openDaySource = (index: number, seriesKey: string): void => {
    const day = days[index];
    if (day !== undefined) {
      onOpenSessions({ ...scopeFilters(scope), ...isoDayRange(day.iso), source: seriesKey });
    }
  };

  // "Not analyzed" is coverage, not a verdict the list can filter by, so it is
  // a note on the card rather than a clickable bar.
  const verdictRows = VERDICT_SERIES.filter((s) => s.key !== 'unjudged')
    .map((s) => ({
      key: s.key as RetroVerdict,
      label: s.label,
      colorVar: s.colorVar,
      value: data.verdicts[s.key as RetroVerdict] ?? 0,
    }))
    .filter((row) => row.value > 0);

  const options =
    scope.kind === 'repository'
      ? data.repositories.map((repo) => ({ value: repo, label: shortRepo(repo), title: repo }))
      : data.tags.map((t) => ({ value: t.tag, label: `#${t.tag} (${t.count.toLocaleString()})`, title: t.tag }));
  // A remembered choice that no longer exists (tag removed, repository gone)
  // stays selectable, so the control never shows something it is not doing.
  if (scope.value !== '' && !options.some((o) => o.value === scope.value)) {
    options.unshift({
      value: scope.value,
      label: scope.kind === 'tag' ? `#${scope.value}` : shortRepo(scope.value),
      title: scope.value,
    });
  }

  return (
    <div className="evidence-rework evidence-summary">
      <div className="hotspots-controls">
        <WindowSelector value={chosen} onChange={chooseWindow} />
        <div className="window-selector" role="group" aria-label="Summarize by">
          {(['repository', 'tag'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className="window-option"
              aria-pressed={scope.kind === kind}
              onClick={() => {
                if (scope.kind !== kind) {
                  chooseScope({ kind, value: '' });
                }
              }}
            >
              {kind === 'repository' ? 'Repository' : 'Tag'}
            </button>
          ))}
        </div>
        <label className="hotspots-repo">
          {scope.kind === 'repository' ? 'Repository' : 'Tag'}
          <select value={scope.value} onChange={(e) => chooseScope({ kind: scope.kind, value: e.target.value })}>
            <option value="">{scope.kind === 'repository' ? 'All repositories' : 'All sessions'}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value} title={o.title}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {progress !== undefined && <span className="hotspots-progress">{progress}</span>}
      </div>

      <p className="summary-scope">
        {scopeDescription(scope)}, {chosen === 'all' ? 'all time' : windowDescription(chosen)}.
        {scope.kind === 'tag' && data.tags.length === 0 && ' No session has a tag yet — add one from a session row.'}
      </p>

      {totals.sessions === 0 ? (
        <section className="card">
          <p className="chart-empty">No sessions match this scope in {windowDescription(chosen)}.</p>
        </section>
      ) : (
        <>
          <section className="tiles tiles-compact" aria-label="Totals">
            <Tile label="Sessions" value={totals.sessions.toLocaleString()} onClick={() => onOpenSessions(base)} />
            <Tile
              label="Session time"
              value={formatDuration(totals.durationMs)}
              hint={
                `Summed wall-clock length of every session, first message to last, idle time included. ` +
                `Average ${formatDuration(totals.avgSessionMs)}.`
              }
            />
            <Tile label="Steps" value={totals.steps.toLocaleString()} />
            <Tile label="LLM calls" value={totals.llmCalls.toLocaleString()} />
            <Tile label="Tool calls" value={totals.toolCalls.toLocaleString()} />
            <Tile label="Input tokens" value={tokens(totals.inputTokens)} />
            <Tile label="Output tokens" value={tokens(totals.outputTokens)} />
            <Tile label="Cached" value={tokens(totals.cachedTokens)} hint="Prompt tokens served from cache" />
            <Tile
              label="Est. cost"
              value={totals.costSessions === 0 ? 'n/a' : formatCost(totals.costMicros) || '$0.00'}
              hint={costCoverageLine(totals)}
            />
            <Tile
              label="Lines added"
              value={recorded ? `+${code.linesAdded.toLocaleString()}` : 'n/a'}
              hint={codeHint('Lines the agents wrote')}
            />
            <Tile
              label="Lines removed"
              value={recorded ? `−${code.linesRemoved.toLocaleString()}` : 'n/a'}
              hint={codeHint('Lines the agents removed')}
            />
            <Tile
              label="Files edited"
              value={recorded ? code.filesEdited.toLocaleString() : 'n/a'}
              hint={codeHint('Distinct files the agents edited')}
            />
            {scope.kind === 'tag' && <Tile label="Repositories" value={totals.repositories.toLocaleString()} />}
            <Tile label="Models" value={totals.models.toLocaleString()} />
          </section>
          {codeCoverage !== undefined && (
            <p className="card-caption summary-caption">
              Lines and files: {codeCoverage[0].toLowerCase()}
              {codeCoverage.slice(1)}.
            </p>
          )}

          <div className="overview-split" style={{ marginBottom: 14 }}>
            <section className="card">
              <div className="card-head">
                <h2>Sessions by agent</h2>
              </div>
              <HorizontalBars
                rows={data.bySource.map((row) => ({
                  label: sourceLabel(row.source),
                  value: row.sessions,
                  colorVar: sourceColorVar(row.source),
                  title:
                    `${sourceLabel(row.source)}: ${row.sessions.toLocaleString()} sessions, ` +
                    `${tokens(row.inputTokens + row.outputTokens)} tokens, ` +
                    `${formatCost(row.costMicros) || '$0.00'}, ${formatDuration(row.durationMs)} run time`,
                }))}
                colorVar="--series-1"
                emptyMessage="No sessions."
                onSelect={(index) => onOpenSessions({ ...base, source: data.bySource[index].source })}
              />
            </section>
            <section className="card">
              <div className="card-head">
                <h2>How it went</h2>
                {data.verdicts.unjudged > 0 && (
                  <span className="card-note">{data.verdicts.unjudged.toLocaleString()} not analyzed</span>
                )}
              </div>
              <HorizontalBars
                rows={verdictRows.map(({ label, value, colorVar }) => ({ label, value, colorVar }))}
                colorVar="--series-1"
                emptyMessage="No sessions judged yet."
                onSelect={(index) => onOpenSessions({ ...base, verdict: verdictRows[index].key })}
              />
            </section>
          </div>

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
              onSelectSegment={openDaySource}
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
              onSelectSegment={openDaySource}
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Lines changed per day</h2>
              {spanNote !== undefined && <span className="card-note">{spanNote}</span>}
              <Legend series={LINE_SERIES} />
            </div>
            <StackedBarChart
              columns={lineColumns}
              series={LINE_SERIES}
              formatValue={(v) => v.toLocaleString()}
              emptyMessage={`No file edits read in the last ${data.windowDays} days.`}
              onSelect={openDay}
            />
            <p className="card-caption">
              From the file edits the background analysis reads. Only {editRecordingAgents()} sessions
              record their edits; other agents' sessions are not counted here.
            </p>
          </section>

          <div className="overview-split">
            <section className="card">
              <div className="card-head">
                <h2>Cost by model</h2>
              </div>
              <HorizontalBars
                rows={data.byModel.map((row) => ({
                  label: row.model,
                  value: row.costMicros ?? 0,
                  display: row.costMicros === undefined ? 'n/a' : formatCost(row.costMicros) || '$0.00',
                  title: `${row.model}: ${row.sessions.toLocaleString()} sessions`,
                }))}
                colorVar="--series-2"
                emptyMessage="No sessions."
              />
              <p className="card-caption">A session's whole cost counts toward its most-used model.</p>
            </section>
            {scope.kind === 'tag' && (
              <section className="card">
                <div className="card-head">
                  <h2>Repositories</h2>
                  {totals.repositories > data.topRepositories.length && (
                    <span className="card-note">
                      top {data.topRepositories.length} of {totals.repositories}
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
                  onSelect={(index) =>
                    onOpenSessions({ ...base, repository: data.topRepositories[index].repository })
                  }
                />
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function tokens(n: number): string {
  return formatTokens(n).replace(' tokens', '');
}

function Tile({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
}): JSX.Element {
  const body = (
    <>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </>
  );
  return onClick === undefined ? (
    <div className="tile" title={hint}>
      {body}
    </div>
  ) : (
    <button type="button" className="tile tile-button" title={hint ?? `Show these sessions`} onClick={onClick}>
      {body}
    </button>
  );
}
