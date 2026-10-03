import type { JSX } from 'react';
import type { RepositoryCards as RepositoryCardsData } from '../../../../shared/rpc';
import { formatCost, formatRelative, shortRepo, sourceLabel } from '../sessions/format';
import { verdictLabel } from '../sessions/retro';
import { verdictShare } from './workspace';

/**
 * One card per repository active in the window. Each opens its hub.
 */
interface Props {
  data: RepositoryCardsData | undefined;
  nowMs?: number;
  onOpen: (repository: string) => void;
}

export function RepositoryCards({ data, nowMs, onOpen }: Props): JSX.Element {
  const now = nowMs ?? Date.now();
  return (
    <section className="card repo-cards" aria-label="Repositories">
      <div className="card-head">
        <h2>Repositories</h2>
        {data !== undefined && (
          <span className="card-note">
            {data.cards.length === 1 ? '1 repository' : `${data.cards.length} repositories`}
            {data.unknownSessions > 0 &&
              ` · ${data.unknownSessions} ${data.unknownSessions === 1 ? 'session' : 'sessions'} without a repository`}
          </span>
        )}
      </div>
      {data !== undefined && data.cards.length === 0 && (
        <p className="chart-empty">No sessions in this window. Widen the window or run an agent in a repository.</p>
      )}
      {data !== undefined && data.cards.length > 0 && (
        <ul className="repo-grid">
          {data.cards.map((card) => (
            <li key={card.repository} className="repo-card">
              <button type="button" className="repo-card-button" onClick={() => onOpen(card.repository)}>
                <span className="repo-card-top">
                  <span className="repo-name" title={card.repository}>
                    {shortRepo(card.repository)}
                  </span>
                  {card.live > 0 && (
                    <span className={card.waiting > 0 ? 'live-badge live-badge-waiting' : 'live-badge'}>
                      {card.waiting > 0 ? `${card.waiting} waiting` : `${card.live} live`}
                    </span>
                  )}
                </span>
                <span className="repo-card-stats">
                  <span>{card.sessions === 1 ? '1 session' : `${card.sessions} sessions`}</span>
                  <span>{card.costSessions > 0 ? formatCost(card.costMicros) : 'cost n/a'}</span>
                  <span>active {formatRelative(card.lastActivityMs, now)}</span>
                </span>
                <VerdictBar verdicts={card.verdicts} />
                <span className="repo-card-sources">
                  {card.bySource.map((s) => `${sourceLabel(s.source)} ${s.sessions}`).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A single stacked bar of the verdict mix; colours alias the retro ramp. */
export function VerdictBar({
  verdicts,
}: {
  verdicts: RepositoryCardsData['cards'][number]['verdicts'];
}): JSX.Element {
  const shares = verdictShare(verdicts).filter((s) => s.value > 0);
  if (shares.length === 0) {
    return <span className="verdict-bar verdict-bar-empty" aria-label="No sessions" />;
  }
  return (
    <span className="verdict-bar" role="img" aria-label={shares.map((s) => `${labelFor(s.key)} ${s.pct}%`).join(', ')}>
      {shares.map((s) => (
        <span
          key={s.key}
          className={`verdict-seg verdict-seg-${s.key}`}
          style={{ width: `${s.pct}%` }}
          title={`${labelFor(s.key)}: ${s.value} (${s.pct}%)`}
        />
      ))}
    </span>
  );
}

function labelFor(key: string): string {
  return key === 'unjudged' ? 'Not analyzed' : verdictLabel(key as Parameters<typeof verdictLabel>[0]);
}
