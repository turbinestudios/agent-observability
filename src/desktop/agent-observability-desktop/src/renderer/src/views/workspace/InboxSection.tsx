import type { JSX } from 'react';
import { useState } from 'react';
import type { InboxItem, InboxSnapshot } from '../../../../shared/rpc';
import { formatCost, formatRelative, shortRepo, sourceLabel } from '../sessions/format';
import type { InboxApi } from './useInbox';
import { SNOOZE_OPTIONS, flagLabels, groupInbox, inboxSummary, reasonLabel, snoozeUntil } from './inbox';

/**
 * "Needs you": the sessions waiting for the developer now, and the ones that
 * finished since they last looked, most worrying first. Everything shown here
 * was derived on this computer; a probable approval prompt is labelled as a
 * guess because the transcript cannot tell it from a tool that is still running.
 */
interface Props {
  snapshot: InboxSnapshot | undefined;
  mark: InboxApi['mark'];
  onOpenSession: (source: string, sessionId: string) => void;
  nowMs?: number;
}

export function InboxSection({ snapshot, mark, onOpenSession, nowMs }: Props): JSX.Element | null {
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  if (snapshot === undefined) {
    return null;
  }
  const now = nowMs ?? Date.now();
  const groups = groupInbox(snapshot.items);
  const open = (item: InboxItem): void => {
    mark([item.key], 'seen');
    onOpenSession(item.source, item.sessionId);
  };
  const dismiss = (item: InboxItem): void => {
    setDismissed(item.key);
    mark([item.key], 'dismissed');
  };

  return (
    <section className="card inbox" aria-label="Needs you">
      <div className="card-head">
        <h2>Needs you</h2>
        <span className="card-note">{inboxSummary(snapshot)}</span>
      </div>
      {dismissed !== undefined && (
        <p className="card-caption inbox-undo">
          Dismissed.{' '}
          <button
            type="button"
            className="table-link"
            onClick={() => {
              mark([dismissed], 'new');
              setDismissed(undefined);
            }}
          >
            Undo
          </button>
        </p>
      )}
      {snapshot.items.length === 0 && (
        <p className="chart-empty">No session is waiting for you, and nothing new has finished.</p>
      )}
      {groups.now.length > 0 && (
        <InboxGroup title="Needs you now" items={groups.now} now={now} onOpen={open} onDismiss={dismiss} mark={mark} />
      )}
      {groups.since.length > 0 && (
        <InboxGroup
          title="Since you last looked"
          items={groups.since}
          now={now}
          onOpen={open}
          onDismiss={dismiss}
          mark={mark}
        />
      )}
    </section>
  );
}

function InboxGroup({
  title,
  items,
  now,
  onOpen,
  onDismiss,
  mark,
}: {
  title: string;
  items: InboxItem[];
  now: number;
  onOpen: (item: InboxItem) => void;
  onDismiss: (item: InboxItem) => void;
  mark: InboxApi['mark'];
}): JSX.Element {
  return (
    <>
      <h3 className="inbox-group">{title}</h3>
      <ul className="inbox-list">
        {items.map((item) => (
          <li key={item.key} className={item.state === 'new' ? 'inbox-item inbox-item-new' : 'inbox-item'}>
            <button type="button" className="inbox-open" onClick={() => onOpen(item)}>
              <span className={`inbox-reason inbox-reason-${item.reason}`}>{reasonLabel(item)}</span>
              <span className="inbox-title">{item.title ?? 'Untitled session'}</span>
              <span className="inbox-meta">
                <span title={item.repository}>{shortRepo(item.repository)}</span>
                <span>{sourceLabel(item.source)}</span>
                <span>{formatRelative(item.sinceMs, now)}</span>
                {item.costMicros !== undefined && <span>{formatCost(item.costMicros)}</span>}
                {flagLabels(item.flags).map((label) => (
                  <span key={label} className="inbox-flag">
                    {label}
                  </span>
                ))}
              </span>
            </button>
            <span className="inbox-actions">
              <button type="button" className="table-link" onClick={() => onDismiss(item)}>
                Dismiss
              </button>
              <span className="inbox-snooze" role="group" aria-label="Snooze">
                Snooze
                {SNOOZE_OPTIONS.map(({ option, label }) => (
                  <button
                    key={option}
                    type="button"
                    className="table-link"
                    onClick={() => mark([item.key], 'snoozed', snoozeUntil(option, Date.now()))}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
