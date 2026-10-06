import type { JSX, MouseEvent } from 'react';
import { useEffect, useRef } from 'react';
import type { RunItem } from '../../../../shared/rpc';
import { ToolRow } from './ToolRow';

/**
 * The hosted session as it happens. Assistant text arrives host-rendered:
 * the renderer has no markdown parser by design, and the markup is inserted
 * behind the strict CSP exactly as the AI Helper inserts its answers. A link
 * opens in the OS browser, never in this window.
 */
export function Transcript({ items }: { items: readonly RunItem[] }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [items]);

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
    </div>
  );
}
