import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { ConnectionState } from '../../api/client';
import type { IndexStatus, SessionRow } from '../../../../shared/rpc';
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
  status: IndexStatus;
  connection: ConnectionState;
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
  rebuild: () => void;
}

export function useSessions(query: string): UseSessionsResult {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [status, setStatus] = useState<IndexStatus>({ indexed: 0, total: 0, phase: 'idle' });
  const [connection, setConnection] = useState<ConnectionState>(() => dataHost.connectionState());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  // Held in a ref so the event subscription can merge without being torn down
  // and re-created on every render.
  const rowsRef = useRef<SessionRow[]>([]);
  const queryRef = useRef(query);
  queryRef.current = query;

  const applyRows = useCallback((next: SessionRow[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await dataHost.call('sessions.list', {
        query: queryRef.current,
        limit: PAGE_SIZE,
      });
      applyRows(next);
      setError(undefined);
      console.log(`[sessions] loaded ${next.length} row(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyRows]);

  // Re-query whenever the search text changes. Filtering happens in SQL rather
  // than over the loaded page, so a match outside the first page is still found.
  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => void load(), query.length === 0 ? 0 : 150);
    return () => clearTimeout(timer);
  }, [query, load]);

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
      applyRows(mergeRows(rowsRef.current, event.rows));
    });

    const offRemoved = dataHost.on('sessions.removed', (event) => {
      if (event.event !== 'sessions.removed') {
        return;
      }
      const gone = new Set(event.keys);
      applyRows(rowsRef.current.filter((r) => !gone.has(sessionKey(r.source, r.sessionId))));
    });

    const offProgress = dataHost.on('index.progress', (event) => {
      if (event.event === 'index.progress') {
        setStatus(event.status);
      }
    });

    const offConnection = dataHost.onConnectionChange(setConnection);
    setConnection(dataHost.connectionState());

    void dataHost.call('index.status').then(setStatus).catch(() => undefined);

    return () => {
      offRows();
      offRemoved();
      offProgress();
      offConnection();
    };
  }, [applyRows]);

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
    () => ({ rows, status, connection, loading, error, refresh, rebuild }),
    [rows, status, connection, loading, error, refresh, rebuild],
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
