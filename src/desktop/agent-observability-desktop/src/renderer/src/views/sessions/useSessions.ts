import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { ConnectionState } from '../../api/client';
import type { IndexStatus, SessionGroup, SessionRow } from '../../../../shared/rpc';
import { sessionKey } from '../../../../shared/rpc';

/**
 * Loads the session list and keeps it live.
 *
 * The initial fetch is a single indexed query, so the list paints as soon as the
 * data host answers — no parsing on this path. After that the indexer pushes
 * rows as it hydrates them, and those are merged in place: a session's row
 * updates from placeholder to real counts without the list reordering under the
 * user or losing scroll position.
 */

/** Rows fetched per page. Large enough that scrolling rarely waits. */
const PAGE_SIZE = 300;

interface UseSessionsResult {
  rows: SessionRow[];
  groups: SessionGroup[];
  status: IndexStatus;
  connection: ConnectionState;
  loading: boolean;
  error: string | undefined;
  /** How many sessions the user has taken out of the list. */
  hiddenCount: number;
  /** How many analyzed sessions carry at least one deviation. */
  deviationCount: number;
  refresh: () => void;
  rebuild: () => void;
  reload: () => void;
}

/**
 * `source` is undefined for "All". `showHidden` swaps the list over to the
 * sessions the user removed, so they can be restored.
 */
export function useSessions(
  query: string,
  source: string | undefined,
  showHidden = false,
  onlyDeviations = false,
): UseSessionsResult {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [status, setStatus] = useState<IndexStatus>({ indexed: 0, total: 0, phase: 'idle' });
  const [connection, setConnection] = useState<ConnectionState>(() => dataHost.connectionState());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [deviationCount, setDeviationCount] = useState(0);

  // Held in a ref so the event subscription can merge without being torn down
  // and re-created on every render.
  const rowsRef = useRef<SessionRow[]>([]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const applyRows = useCallback((next: SessionRow[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const hiddenRef = useRef(showHidden);
  hiddenRef.current = showHidden;
  const deviationsRef = useRef(onlyDeviations);
  deviationsRef.current = onlyDeviations;

  const load = useCallback(async () => {
    try {
      const next = await dataHost.call('sessions.list', {
        query: queryRef.current,
        source: sourceRef.current,
        hidden: hiddenRef.current,
        ...(deviationsRef.current ? { deviations: true } : {}),
        limit: PAGE_SIZE,
      });
      applyRows(next);
      setError(undefined);
      void dataHost.call('sessions.hiddenCount').then(setHiddenCount).catch(() => undefined);
      console.log(`[sessions] loaded ${next.length} row(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyRows]);

  // Re-query whenever the search text or source filter changes. Filtering runs
  // in SQL rather than over the loaded page, so a match outside the first page
  // is still found.
  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => void load(), query.length === 0 ? 0 : 150);
    return () => clearTimeout(timer);
  }, [query, source, showHidden, onlyDeviations, load]);

  useEffect(() => {
    const offRows = dataHost.on('sessions.upserted', (event) => {
      if (event.event !== 'sessions.upserted') {
        return;
      }
      // A search is active: a freshly hydrated row may or may not match the
      // filter, and deciding that here would duplicate the SQL predicate. Let
      // the next query settle it instead of guessing.
      if (queryRef.current.length > 0) {
        return;
      }
      // While showing hidden sessions the indexer's pushes are about visible
      // ones, so they must not leak into the list.
      if (hiddenRef.current) {
        return;
      }
      // The Flagged filter is decided by the background analysis, and a push can
      // both add a session to it and take one out of it. Rather than reproduce
      // that here, let the re-query below settle it — otherwise a clean row
      // would slide into a list that is supposed to hold only flagged ones.
      if (deviationsRef.current) {
        return;
      }
      // A source filter, by contrast, is decidable from the row itself.
      const incoming =
        sourceRef.current === undefined
          ? event.rows
          : event.rows.filter((r) => r.source === sourceRef.current);
      if (incoming.length > 0) {
        applyRows(mergeRows(rowsRef.current, incoming));
      }
    });

    const offRemoved = dataHost.on('sessions.removed', (event) => {
      if (event.event !== 'sessions.removed') {
        return;
      }
      const gone = new Set(event.keys);
      applyRows(rowsRef.current.filter((r) => !gone.has(sessionKey(r.source, r.sessionId))));
    });

    const loadGroups = (): void => {
      void dataHost
        .call('sessions.groups')
        .then(setGroups)
        .catch(() => undefined);
      void dataHost
        .call('sessions.count', { deviations: true })
        .then(setDeviationCount)
        .catch(() => undefined);
    };

    const offProgress = dataHost.on('index.progress', (event) => {
      if (event.event !== 'index.progress') {
        return;
      }
      setStatus(event.status);
      // Per-source counts only settle once a pass finishes; refreshing them
      // mid-hydration would make the filter chips flicker upward.
      if (event.status.phase === 'idle') {
        loadGroups();
      }
    });

    // The flagged count is filled in by the background analysis, which runs
    // after indexing settles — so it moves on its own progress, not the index's.
    const offAnalysis = dataHost.on('analysis.progress', (event) => {
      if (event.event !== 'analysis.progress' || event.status.running) {
        return;
      }
      loadGroups();
      // A list filtered to flagged sessions is defined by what that pass just
      // decided, so it has to be re-read rather than patched.
      if (deviationsRef.current) {
        void load();
      }
    });

    const offConnection = dataHost.onConnectionChange(setConnection);
    setConnection(dataHost.connectionState());

    void dataHost.call('index.status').then(setStatus).catch(() => undefined);
    loadGroups();

    return () => {
      offRows();
      offRemoved();
      offProgress();
      offAnalysis();
      offConnection();
    };
  }, [applyRows, load]);

  const refresh = useCallback(() => {
    void dataHost.call('index.refresh').catch((err: Error) => setError(err.message));
  }, []);

  const rebuild = useCallback(() => {
    setLoading(true);
    applyRows([]);
    void dataHost
      .call('index.rebuild')
      .then(() => load())
      .catch((err: Error) => setError(err.message));
  }, [applyRows, load]);

  return useMemo(
    () => ({
      rows,
      groups,
      status,
      connection,
      loading,
      error,
      hiddenCount,
      deviationCount,
      refresh,
      rebuild,
      reload: load,
    }),
    [
      rows,
      groups,
      status,
      connection,
      loading,
      error,
      hiddenCount,
      deviationCount,
      refresh,
      rebuild,
      load,
    ],
  );
}

/**
 * Merge pushed rows into the list, keeping it sorted newest-first.
 *
 * Updates are applied in place when the sort key is unchanged, so a row
 * hydrating from placeholder to real counts does not make the list jump.
 */
function mergeRows(current: SessionRow[], incoming: SessionRow[]): SessionRow[] {
  if (incoming.length === 0) {
    return current;
  }
  const byKey = new Map(current.map((r) => [sessionKey(r.source, r.sessionId), r]));
  let orderChanged = false;
  for (const row of incoming) {
    const key = sessionKey(row.source, row.sessionId);
    const existing = byKey.get(key);
    if (existing === undefined || existing.endedAtMs !== row.endedAtMs) {
      orderChanged = true;
    }
    byKey.set(key, row);
  }
  const merged = [...byKey.values()];
  if (orderChanged) {
    merged.sort((a, b) => b.endedAtMs - a.endedAtMs || (a.sessionId < b.sessionId ? 1 : -1));
  }
  return merged;
}
