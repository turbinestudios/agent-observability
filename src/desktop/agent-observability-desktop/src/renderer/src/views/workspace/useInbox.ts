import { useCallback, useEffect, useState } from 'react';
import type { InboxSnapshot } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';

/**
 * The attention inbox, kept current by the datahost's push events. Mounted by
 * the app shell so the rail badge counts from any view; the Workspace view
 * receives the same snapshot as a prop rather than subscribing twice.
 */
export interface InboxApi {
  snapshot: InboxSnapshot | undefined;
  mark: (keys: string[] | 'all', state: 'seen' | 'dismissed' | 'snoozed' | 'new', untilMs?: number) => void;
}

export function useInbox(): InboxApi {
  const [snapshot, setSnapshot] = useState<InboxSnapshot | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('inbox.list')
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch(() => undefined);
    const off = dataHost.on('inbox.changed', (event) => {
      if (event.event === 'inbox.changed') {
        setSnapshot(event.snapshot);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const mark = useCallback<InboxApi['mark']>((keys, state, untilMs) => {
    dataHost
      .call('inbox.mark', keys, state, untilMs !== undefined ? { untilMs } : undefined)
      .then(setSnapshot)
      .catch(() => undefined);
  }, []);

  return { snapshot, mark };
}
