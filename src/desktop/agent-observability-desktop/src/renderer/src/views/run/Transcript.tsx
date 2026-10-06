import type { JSX, MouseEvent } from 'react';
import { useEffect, useRef } from 'react';
import type { RunItem, RunStatus } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import { ToolRow } from './ToolRow';
import { busyLabel, isBusy } from './run';

/**
 * The hosted session as it happens. Assistant text arrives host-rendered:
 * the renderer has no markdown parser by design, and the markup is inserted
 * behind the strict CSP exactly as the AI Helper inserts its answers. A link
 * opens in the OS browser, never in this window.
 *
 * While the agent is busy the log ends in a moving spinner, so a session that
 * is working never looks like one that has stopped.
 */
export function Transcript({ items, status }: { items: readonly RunItem[]; status: RunStatus }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [items, status]);

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (anchor === null) {
      return;
    }
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href !== null && href.startsWith('https://')) {
      void window.desktop.openExternal(href);
    }
  };

  return (
    <div className="run-log" ref={ref} onClick={onClick}>
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="assistant-bubble assistant-bubble-user">
                {item.text}
              </div>
            );
          case 'assistant':
            return (
              <div
                key={item.id}
                className="assistant-bubble assistant-bubble-model"
                dangerouslySetInnerHTML={{ __html: item.html }}
              />
            );
          case 'reasoning':
            return (
              <details key={item.id} className="run-reasoning">
                <summary>Reasoning</summary>
                <div dangerouslySetInnerHTML={{ __html: item.html }} />
              </details>
            );
          case 'tool':
            return <ToolRow key={item.id} item={item} />;
          case 'notice':
            return (
              <p key={item.id} className={item.level === 'error' ? 'modal-error' : 'card-caption'}>
                {item.text}
              </p>
            );
        }
      })}
      {isBusy(status) && (
        <div className="run-working" role="status" aria-live="polite">
          <Spinner size={16} stroke={2} />
          <span>{busyLabel(status)}</span>
        </div>
      )}
    </div>
  );
}
