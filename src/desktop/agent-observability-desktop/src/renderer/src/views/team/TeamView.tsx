import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { TeamFigures, TeamViewData, TeamWindow } from '../../../../shared/rpc';
import { TEAM_WINDOWS } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { HorizontalBars, Legend, StackedBarChart } from '../overview/charts';
import type { SeriesStyle, StackedColumn } from '../overview/charts';
import { VERDICT_SERIES } from '../overview/insights';
import { formatCost, formatRelative, formatTokens, shortRepo } from '../sessions/format';
import { TeamPreviewDialog } from './TeamPreviewDialog';
import {
  costBasisNote,
  deltaLabel,
  emptyState,
  folderStateLabel,
  groupThousands,
  persistTeamWindow,
  problemLabel,
  readStoredTeamWindow,
  shortDay,
  shortDeveloperId,
  staleLabel,
  teamWindowLabel,
} from './team';
import { useTeamActions, useTeamView } from './useTeam';
import './team.css';

/**
 * The team perspective: anonymous aggregates from a folder the team shares.
 * No server, no account — each member's app writes one file there and reads
 * everyone else's. Everything drawn here comes from those files, merged and
 * validated by the datahost; the viewer's own figures are only highlighted
 * because their own anonymous id is known locally.
 */
const MEMBER_SERIES: SeriesStyle[] = [{ key: 'members', label: 'Members active', colorVar: '--series-1' }];
const SESSION_SERIES: SeriesStyle[] = [{ key: 'sessions', label: 'Sessions', colorVar: '--series-1' }];
const TOKEN_SERIES: SeriesStyle[] = [
  { key: 'input', label: 'Input', colorVar: '--series-3' },
  { key: 'output', label: 'Output', colorVar: '--series-4' },
];
const COST_SERIES: SeriesStyle[] = [{ key: 'cost', label: 'Est. cost', colorVar: '--series-2' }];
const ADOPTION_SERIES: SeriesStyle[] = [{ key: 'members', label: 'Members', colorVar: '--series-1' }];

export function TeamView({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const [chosen, setChosen] = useState<TeamWindow>(readStoredTeamWindow);
  const { data, error, reload } = useTeamView(chosen);
  const { exportNow, refresh } = useTeamActions();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (notice === undefined) {
      return undefined;
    }
    const timer = window.setTimeout(() => setNotice(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const chooseWindow = (next: TeamWindow): void => {
    setChosen(next);
    persistTeamWindow(next);
  };

  const onExport = (): void => {
    setBusy(true);
    exportNow()
      .then((result) =>
        setNotice(result.ok ? `Shared ${groupThousands(result.bytes ?? 0)} bytes to the team folder.` : result.error),
      )
      .catch((err: Error) => setNotice(err.message))
      .finally(() => setBusy(false));
  };

  const onRefresh = (): void => {
    setBusy(true);
    refresh()
      .then(() => reload())
      .catch((err: Error) => setNotice(err.message))
      .finally(() => setBusy(false));
  };

  const onChooseFolder = (): void => {
    void window.desktop
      .pickFolder()
      .then((folder) => {
        if (folder === undefined) {
          return undefined;
        }
        return dataHost.call('settings.update', { teamFolder: folder }).then(() => reload());
      })
      .catch((err: Error) => setNotice(err.message));
  };

  const status = data?.status;
  const empty = status === undefined ? undefined : emptyState(status, data);

  return (
    <div className="team">
      <header className="team-header">
        <div className="team-title">
          <h1>Team</h1>
          <div className="window-selector" role="group" aria-label="Time window">
            {TEAM_WINDOWS.map((option) => (
              <button
                key={option}
                type="button"
                className="window-option"
                aria-pressed={option === chosen}
                onClick={() => chooseWindow(option)}
              >
                {teamWindowLabel(option)}
              </button>
            ))}
          </div>
        </div>
        <p>
          How your team uses agents, from a folder you already share. Each member&apos;s app writes one file
          with counts and totals under an anonymous id and reads everyone else&apos;s. No server, no account.
        </p>
        {status !== undefined && (
          <div className="team-actions">
            <span className={`team-chip team-chip-${status.folderState}`} title={status.folder}>
              {folderStateLabel(status)}
            </span>
            {status.shareEnabled && (
              <button type="button" className="modal-btn" disabled={busy || status.exporting} onClick={onExport}>
                {status.exporting ? 'Exporting…' : 'Export now'}
              </button>
            )}
            <button type="button" className="modal-btn" onClick={() => setPreviewOpen(true)}>
              Preview what will be shared
            </button>
            {status.folder.length > 0 && (
              <button type="button" className="modal-btn" onClick={() => void window.desktop.showItem(status.folder)}>
                Open folder
              </button>
            )}
            <button type="button" className="modal-btn" disabled={busy} onClick={onRefresh}>
              Refresh
            </button>
          </div>
        )}
        {status?.lastExportError !== undefined && <div className="settings-error">{status.lastExportError}</div>}
        {notice !== undefined && <p className="team-notice">{notice}</p>}
      </header>

      {error !== undefined && <div className="settings-error">{error}</div>}

      {data === undefined && error === undefined && (
        <div className="detail-loading" role="status" aria-live="polite">
          <Spinner size={36} stroke={3} />
          <p className="detail-loading-title">Reading the team folder…</p>
        </div>
      )}

      {data !== undefined && empty === 'no-folder' && (
        <div className="placeholder team-empty">
          <div>
            <h2>Pick a folder your team shares</h2>
            <p>
              OneDrive, SharePoint, a network drive — anywhere everyone can read and write. Nothing is written
              until you turn sharing on in Settings; reading the folder is always on.
            </p>
            <div className="team-actions">
              <button type="button" className="modal-btn primary" onClick={onChooseFolder}>
                Choose folder
              </button>
              <button type="button" className="modal-btn" onClick={onOpenSettings}>
                Open Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {data !== undefined && empty === 'no-shards' && (
        <div className="placeholder team-empty">
          <div>
            <h2>Nothing shared yet</h2>
            <p>
              No team files in this folder so far. Turn on sharing in Settings to add yours, and ask teammates to
              point their app at the same folder.
            </p>
            <ProblemsList data={data} />
          </div>
        </div>
      )}

      {data !== undefined && empty === 'only-me' && (
        <div className="placeholder team-empty">
          <div>
            <h2>Only you so far</h2>
            <p>Ask teammates to point their app at the same folder; their figures appear here as they share.</p>
            <ProblemsList data={data} />
          </div>
        </div>
      )}

      {data !== undefined && empty === undefined && <TeamBody data={data} />}

      {previewOpen && <TeamPreviewDialog onClose={() => setPreviewOpen(false)} />}
    </div>
  );
}

function TeamBody({ data }: { data: TeamViewData }): JSX.Element {
  const days = data.days.map((day) => ({ iso: day, short: shortDay(day), long: day }));
  const daily = new Map(data.daily.map((p) => [p.day, p]));
  const columns = (pick: (day: string) => { key: string; value: number }[]): StackedColumn[] =>
    days.map((day) => ({ label: day.short, fullLabel: day.long, segments: pick(day.iso) }));

  const verdictByDay = new Map<string, Record<string, number>>();
  for (const point of data.verdictDaily) {
    const record = verdictByDay.get(point.day) ?? {};
    record[point.verdict] = (record[point.verdict] ?? 0) + point.sessions;
    verdictByDay.set(point.day, record);
  }
  const adoption = new Map(data.adoption.map((p) => [p.day, p.members]));
  const totals = data.totals;

  return (
    <>
      <div className="tiles tiles-compact">
        <Tile label="Members" value={String(totals.members)} />
        <Tile label="Active in window" value={String(totals.activeMembers)} />
        <Tile label="Sessions" value={groupThousands(totals.sessions)} />
        <Tile label="Tokens" value={formatTokens(totals.inputTokens + totals.outputTokens).replace(' tokens', '')} />
        <Tile
          label={totals.pricedSessions === 0 ? 'Est. cost' : `Est. cost (${totals.pricedSessions} of ${totals.sessions} priced)`}
          value={totals.pricedSessions === 0 ? 'n/a' : formatCost(totals.costMicros)}
        />
        <Tile label="Repositories" value={String(totals.repositories)} />
      </div>

      <div className="overview-split">
        <section className="card" aria-label="Members active per day">
          <div className="card-head">
            <h2>Members active per day</h2>
          </div>
          <StackedBarChart
            columns={columns((day) => [{ key: 'members', value: daily.get(day)?.members ?? 0 }])}
            series={MEMBER_SERIES}
            formatValue={groupThousands}
            emptyMessage="No activity in this window."
          />
        </section>
        <section className="card" aria-label="Sessions per day">
          <div className="card-head">
            <h2>Sessions per day</h2>
          </div>
          <StackedBarChart
            columns={columns((day) => [{ key: 'sessions', value: daily.get(day)?.sessions ?? 0 }])}
            series={SESSION_SERIES}
            formatValue={groupThousands}
            emptyMessage="No sessions in this window."
          />
        </section>
      </div>

      <div className="overview-split">
        <section className="card" aria-label="Tokens per day">
          <div className="card-head">
            <h2>Tokens per day</h2>
          </div>
          <StackedBarChart
            columns={columns((day) => [
              { key: 'input', value: daily.get(day)?.inputTokens ?? 0 },
              { key: 'output', value: daily.get(day)?.outputTokens ?? 0 },
            ])}
            series={TOKEN_SERIES}
            formatValue={(v) => formatTokens(v).replace(' tokens', '')}
            emptyMessage="No tokens in this window."
          />
          <Legend series={TOKEN_SERIES} />
        </section>
        <section className="card" aria-label="Estimated cost per day">
          <div className="card-head">
            <h2>Estimated cost per day</h2>
            <span className="card-note">{costBasisNote(data.costModes)}</span>
          </div>
          <StackedBarChart
            columns={columns((day) => [{ key: 'cost', value: daily.get(day)?.costMicros ?? 0 }])}
            series={COST_SERIES}
            formatValue={(v) => formatCost(v) || '$0.00'}
            emptyMessage="No priced sessions in this window."
          />
        </section>
      </div>

      <section className="card" aria-label="How sessions went">
        <div className="card-head">
          <h2>How sessions went</h2>
          <span className="card-note">
            {VERDICT_SERIES.map((s) => `${s.label} ${data.verdictMix[s.key as keyof typeof data.verdictMix]}`).join(' · ')}
          </span>
        </div>
        <StackedBarChart
          columns={columns((day) =>
            VERDICT_SERIES.map((series) => ({ key: series.key, value: verdictByDay.get(day)?.[series.key] ?? 0 })),
          )}
          series={VERDICT_SERIES}
          formatValue={groupThousands}
          emptyMessage="No judged sessions in this window."
        />
        <Legend series={VERDICT_SERIES} />
      </section>

      <div className="overview-split">
        <section className="card" aria-label="Busiest repositories">
          <div className="card-head">
            <h2>Busiest repositories</h2>
            <span className="card-note">sessions · members</span>
          </div>
          <HorizontalBars
            rows={data.topRepositories.map((row) => ({
              label: shortRepo(row.repository),
              value: row.sessions,
              title: `${row.repository}: ${row.sessions} sessions from ${row.members} ${row.members === 1 ? 'member' : 'members'}${row.mine > 0 ? `, ${row.mine} of them yours` : ''}`,
            }))}
            colorVar="--series-1"
            emptyMessage="No repositories in this window."
          />
        </section>
        <section className="card" aria-label="Adoption">
          <div className="card-head">
            <h2>Adoption</h2>
            <span className="card-note">members who have shared, cumulative</span>
          </div>
          <StackedBarChart
            columns={columns((day) => [{ key: 'members', value: adoption.get(day) ?? 0 }])}
            series={ADOPTION_SERIES}
            formatValue={groupThousands}
            emptyMessage="No members yet."
          />
        </section>
      </div>

      <section className="card" aria-label="Team context hotspots">
        <div className="card-head">
          <h2>Team context hotspots</h2>
          <span className="card-note">context files across every member&apos;s sessions</span>
        </div>
        {data.hotspots.length === 0 ? (
          <p className="chart-empty">No context-file usage shared yet.</p>
        ) : (
          <table className="source-table team-hotspots">
            <thead>
              <tr>
                <th>Repository</th>
                <th>File</th>
                <th className="n">Score</th>
                <th className="n">Members</th>
                <th className="n">Loaded</th>
                <th className="n">Skipped</th>
                <th className="n">Max tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.hotspots.map((row) => (
                <tr key={`${row.repository}:${row.contextFile}`}>
                  <td title={row.repository}>{shortRepo(row.repository)}</td>
                  <td>
                    <code>{row.contextFile}</code>
                  </td>
                  <td className="n">{Math.round(row.score)}</td>
                  <td className="n">{row.members}</td>
                  <td className="n">{groupThousands(row.appliedCount)}</td>
                  <td className="n">{groupThousands(row.skippedCount)}</td>
                  <td className="n">{groupThousands(row.estTokensMax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data.me !== undefined && <MeVsTeam me={data.me} />}

      <section className="card" aria-label="Members">
        <div className="card-head">
          <h2>Members</h2>
          <span className="card-note">
            counts installs, not people
            {data.staleMembers > 0 && ` · ${data.staleMembers} stale`}
          </span>
        </div>
        <ul className="team-members">
          {data.members.map((member) => (
            <li key={member.developerId} className={member.isMe ? 'team-member-me' : undefined}>
              <code title={member.developerId}>{shortDeveloperId(member.developerId)}</code>
              {member.isMe && <span className="team-you">you</span>}
              <span className={member.stale ? 'team-stale' : 'card-caption'}>{staleLabel(member, Date.now())}</span>
              <span className="card-caption">
                v{member.toolVersion} · {member.bucketCount} buckets · {member.outcomeRowCount} outcome rows ·{' '}
                {member.contextRowCount} context rows
              </span>
            </li>
          ))}
        </ul>
        <ProblemsList data={data} />
      </section>
    </>
  );
}

function MeVsTeam({ me }: { me: NonNullable<TeamViewData['me']> }): JSX.Element {
  const rows: { label: string; pick: (f: TeamFigures) => number; format: (v: number) => string }[] = [
    { label: 'Sessions', pick: (f) => f.sessions, format: groupThousands },
    { label: 'Tokens', pick: (f) => f.inputTokens + f.outputTokens, format: (v) => formatTokens(v).replace(' tokens', '') },
    { label: 'Est. cost', pick: (f) => f.costMicros, format: (v) => formatCost(v) || '$0.00' },
  ];
  return (
    <section className="card" aria-label="Me versus team">
      <div className="card-head">
        <h2>Me vs team</h2>
        <span className="card-note">
          against {me.comparedMembers} other {me.comparedMembers === 1 ? 'member' : 'members'}
          {me.rankBySessions !== undefined && ` · #${me.rankBySessions} by sessions`}
        </span>
      </div>
      <div className="team-me-grid">
        <span className="team-me-head" />
        <span className="team-me-head">Mine</span>
        <span className="team-me-head">Team median</span>
        <span className="team-me-head">Team mean</span>
        <span className="team-me-head">vs median</span>
        {rows.map((row) => (
          <RowCells key={row.label} label={row.label} me={me} pick={row.pick} format={row.format} />
        ))}
      </div>
    </section>
  );
}

function RowCells({
  label,
  me,
  pick,
  format,
}: {
  label: string;
  me: NonNullable<TeamViewData['me']>;
  pick: (f: TeamFigures) => number;
  format: (v: number) => string;
}): JSX.Element {
  return (
    <>
      <span className="team-me-label">{label}</span>
      <span className="n">{format(pick(me.mine))}</span>
      <span className="n">{format(pick(me.teamMedian))}</span>
      <span className="n">{format(pick(me.teamMean))}</span>
      <span className="n team-me-delta">{deltaLabel(pick(me.mine), pick(me.teamMedian))}</span>
    </>
  );
}

function ProblemsList({ data }: { data: TeamViewData }): JSX.Element | null {
  if (data.status.problems.length === 0) {
    return null;
  }
  return (
    <ul className="team-problems">
      {data.status.problems.map((problem) => (
        <li key={problem.fileName}>
          <code>{problem.fileName}</code> — {problemLabel(problem)}
          {problem.detail !== undefined && <span className="card-caption"> ({problem.detail})</span>}
        </li>
      ))}
      {data.status.lastReadAtMs !== undefined && (
        <li className="card-caption">Folder last read {formatRelative(data.status.lastReadAtMs)}</li>
      )}
    </ul>
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
