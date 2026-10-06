import { useCallback, useEffect, useState } from 'react';
import type { RunAvailability, RunRepository, RunSessionInfo } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import type { RunStatus } from '../../../../shared/runTypes';
import { EMPTY_RUN_VIEW, applyRunEvent, fromTranscript, type RunViewState } from './runReducer';
import { isBusy } from './run';

/** Availability, the repository picker and the session list for the Run view. */
export function useRunHost(): {
  availability: RunAvailability | undefined;
  repositories: RunRepository[];
  sessions: RunSessionInfo[];
  error: string | undefined;
  reload: () => void;
  /** Re-read only the session list (after a change that raises no status event). */
  refreshSessions: () => void;
  acknowledge: () => void;
} {
  const [availability, setAvailability] = useState<RunAvailability | undefined>(undefined);
  const [repositories, setRepositories] = useState<RunRepository[]>([]);
  const [sessions, setSessions] = useState<RunSessionInfo[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(() => {
    dataHost
      .call('run.availability')
      .then((next) => {
        setAvailability(next);
        setError(undefined);
        if (next.enabled && next.acknowledged) {
          void dataHost.call('run.repositories').then(setRepositories).catch(() => setRepositories([]));
        }
      })
      .catch((err: Error) => setError(err.message));
    dataHost.call('run.list').then(setSessions).catch(() => setSessions([]));
  }, []);

  const refreshSessions = useCallback(() => {
    dataHost.call('run.list').then(setSessions).catch(() => undefined);
  }, []);

  const acknowledge = useCallback(() => {
    dataHost
      .call('run.acknowledge')
      .then(() => reload())
      .catch((err: Error) => setError(err.message));
  }, [reload]);

  useEffect(() => {
    reload();
    return dataHost.on('run.event', (event) => {
      if (event.event === 'run.event' && event.change.type === 'status') {
        void dataHost.call('run.list').then(setSessions).catch(() => undefined);
      }
    });
  }, [reload]);

  return { availability, repositories, sessions, error, reload, refreshSessions, acknowledge };
}

/** One hosted session's transcript, kept current by the datahost's events. */
export function useRunSession(sessionId: string | undefined): RunViewState | undefined {
  const [state, setState] = useState<RunViewState | undefined>(undefined);
  useEffect(() => {
    if (sessionId === undefined) {
      setState(undefined);
      return undefined;
    }
    let cancelled = false;
    setState(EMPTY_RUN_VIEW);
    dataHost
      .call('run.transcript', sessionId)
      .then((transcript) => {
        if (!cancelled && transcript !== undefined) {
          setState(fromTranscript(transcript));
        }
      })
      .catch(() => undefined);
    const off = dataHost.on('run.event', (event) => {
      if (event.event === 'run.event' && event.sessionId === sessionId) {
        setState((current) => applyRunEvent(current ?? EMPTY_RUN_VIEW, event.change));
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId]);
  return state;
}

/**
 * Whether any hosted session's agent is working right now, for the spinner
 * beside Run in the sidebar. Seeded from the session list, then kept current
 * from status events, so it is right from any view.
 */
export function useRunBusy(enabled: boolean): boolean {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, RunStatus>>(new Map());
  useEffect(() => {
    if (!enabled) {
      setStatuses(new Map());
      return undefined;
    }
    let cancelled = false;
    dataHost
      .call('run.list')
      .then((list) => {
        if (!cancelled) {
          setStatuses(new Map(list.map((s) => [s.sessionId, s.status])));
        }
      })
      .catch(() => undefined);
    const off = dataHost.on('run.event', (event) => {
      if (event.event === 'run.event' && event.change.type === 'status') {
        const { sessionId } = event;
        const { status } = event.change;
        setStatuses((current) => new Map(current).set(sessionId, status));
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);
  return [...statuses.values()].some(isBusy);
}

/** Relays the count of running hosted sessions to main, so quitting can ask first. */
export function useRunActiveRelay(): void {
  useEffect(() => {
    return dataHost.on('run.active', (event) => {
      if (event.event === 'run.active') {
        window.desktop?.setRunActive(event.count);
      }
    });
  }, []);
}
