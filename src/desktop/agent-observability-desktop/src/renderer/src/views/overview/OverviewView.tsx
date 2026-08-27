import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { dataHost } from '../../api/client';
import type { OverviewData } from '../../../../shared/rpc';
import { formatDuration, formatTokens, sourceLabel } from '../sessions/format';
import { HorizontalBars, Legend, StackedBarChart } from './charts';
import type { SeriesStyle, StackedColumn } from './charts';
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
];

const TOKEN_SERIES: SeriesStyle[] = [
  { key: 'input', label: 'Input', colorVar: '--series-3' },
  { key: 'output', label: 'Output', colorVar: '--series-4' },
];

export function OverviewView(): JSX.Element {
  const [data, setData] = useState<OverviewData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    dataHost
      .call('overview.get')
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    // Totals shift as the indexer hydrates; refresh once a pass settles rather
    // than on every batch, which would make the numbers flicker upward.
    return dataHost.on('index.progress', (event) => {
      if (event.event === 'index.progress' && event.status.phase === 'idle') {
        load();
      }
    });
  }, [load]);

  const days = useMemo(() => (data === undefined ? [] : buildDays(data)), [data]);

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

  if (data === undefined) {
    return (
      <div className="placeholder">
        <div>
          <p>Reading totals…</p>
        </div>
      </div>
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

  return (
    <div className="overview">
      <header className="overview-header">
        <h1>Local Overview</h1>
        <p>
          Everything recorded on this machine. Nothing here has been uploaded — all of it is read
          from your own agent logs.
        </p>
      </header>

      <section className="tiles" aria-label="Totals">
        <Tile label="Sessions" value={totals.sessions.toLocaleString()} />
        <Tile label="Steps" value={totals.steps.toLocaleString()} />
        <Tile label="Input tokens" value={formatTokens(totals.inputTokens).replace(' tokens', '')} />
        <Tile label="Output tokens" value={formatTokens(totals.outputTokens).replace(' tokens', '')} />
        <Tile
          label="Cached"
          value={formatTokens(totals.cachedTokens).replace(' tokens', '')}
          hint="Prompt tokens served from cache rather than re-read"
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
          <Legend series={SOURCE_SERIES} />
        </div>
        <StackedBarChart
          columns={sessionColumns}
          series={SOURCE_SERIES}
          formatValue={(v) => v.toLocaleString()}
          emptyMessage={`No sessions in the last ${data.windowDays} days.`}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Tokens per day</h2>
          <Legend series={TOKEN_SERIES} />
        </div>
        <StackedBarChart
          columns={tokenColumns}
          series={TOKEN_SERIES}
          formatValue={(v) => formatTokens(v).replace(' tokens', '')}
          emptyMessage={`No token usage recorded in the last ${data.windowDays} days.`}
        />
      </section>

      <div className="overview-split">
        <section className="card">
          <div className="card-head">
            <h2>Busiest repositories</h2>
          </div>
          <HorizontalBars
            rows={data.topRepositories.map((r) => ({
              label: shortRepo(r.repository),
              value: r.sessions,
              title: r.repository,
            }))}
            colorVar="--series-1"
            emptyMessage="No sessions have a resolved repository yet."
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
              </tr>
            </thead>
            <tbody>
              {data.bySource.map((row) => (
                <tr key={row.source}>
                  <th scope="row">
                    <span
                      className="legend-swatch"
                      style={{ background: `var(${colorVarFor(row.source)})` }}
                    />
                    {sourceLabel(row.source)}
                  </th>
                  <td className="n">{row.sessions.toLocaleString()}</td>
                  <td className="n">{row.steps.toLocaleString()}</td>
                  <td className="n">
                    {formatTokens(row.inputTokens + row.outputTokens).replace(' tokens', '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
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
  short: string;
  long: string;
  sessionsBySource: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
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
    byDay.set(isoDay(date), {
      short: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      long: date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      sessionsBySource: {},
      inputTokens: 0,
      outputTokens: 0,
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

/** `owner/repo` — the part that identifies it, without the host boilerplate. */
function shortRepo(repository: string): string {
  const parts = repository.replace(/\.git$/, '').split('/').filter((p) => p.length > 0);
  return parts.slice(-2).join('/') || repository;
}
