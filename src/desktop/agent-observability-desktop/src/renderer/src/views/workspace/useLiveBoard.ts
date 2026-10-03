import { useEffect, useRef, useState } from 'react';
import type { LiveBoardSnapshot, LiveStatus } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { notificationsFor } from './liveNotifications';

/** The live board, kept current by the datahost's push events. */
export function useLiveBoard(): { snapshot: LiveBoardSnapshot | undefined; error: string | undefined } {
  const [snapshot, setSnapshot] = useState<LiveBoardSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('workspace.live')
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    const off = dataHost.on('workspace.live', (event) => {
      if (event.event === 'workspace.live') {
        setSnapshot(event.snapshot);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return { snapshot, error };
}

/**
 * Desktop notifications for live sessions. Mounted by the app shell rather
 * than the Workspace view, so a toast still arrives while another view is
 * open. Everything happens on this computer: the OS shows the title from the
 * local transcript; nothing is sent anywhere.
 *
 * `settingsVersion` bumps whenever Settings may have changed, so the toggle
 * is re-read without a restart.
 */
export function useLiveNotifications(settingsVersion: number, onOpen: (source: string, sessionId: string) => void): void {
  const [enabled, setEnabled] = useState(false);
  const previous = useRef<Map<string, LiveStatus> | undefined>(undefined);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('settings.get')
      .then((snapshot) => {
        if (!cancelled) {
          setEnabled(snapshot.liveNotifications);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settingsVersion]);

  useEffect(() => {
    if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
  }, [enabled]);

  useEffect(() => {
    return dataHost.on('workspace.live', (event) => {
      if (event.event !== 'workspace.live') {
        return;
      }
      const { decisions, statuses } = notificationsFor(previous.current, event.snapshot);
      previous.current = statuses;
      if (!enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        return;
      }
      for (const decision of decisions) {
        try {
          const toast = new Notification(decision.title, { body: decision.body, tag: decision.key });
          toast.onclick = () => {
            window.focus();
            open.current(decision.source, decision.sessionId);
          };
        } catch {
          // A platform without notification support is not an error worth showing.
        }
      }
    });
  }, [enabled]);
}
