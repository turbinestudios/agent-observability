import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { ConnectionState } from '../../api/client';
import type {
  IndexStatus,
  ListSessionsParams,
  SessionGroup,
  SessionRow,
  TagCount,
} from '../../../../shared/rpc';
import { sessionKey } from '../../../../shared/rpc';
import type { SessionFilters } from './filters';
import { filterKey, matchesFilters, toListParams } from './filters';

/**
 * Loads the session list and keeps it live.
 *
 * The initial fetch is a single indexed query, so the list paints as soon as the
 * data host answers — no parsing on this path. After that the indexer pushes
 * rows as it hydrates them, and those are merged in place: a session's row
 * updates from placeholder to real counts without the list reordering under the
 * user or losing scroll position.
 */

/**
 * Rows fetched per page. Large enough that scrolling rarely waits. Exported so
 * the startup overlay's warm-up issues the identical first-page query.
 */
export const PAGE_SIZE = 300;

interface UseSessionsResult {
  rows: SessionRow[];
  groups: SessionGroup[];
  /** Every tag in use, for the filter dropdown and the row editor's suggestions. */
  tags: TagCount[];
  status: IndexStatus;
  connection: ConnectionState;
  loading: boolean;
  error: string | undefined;
  /** How many sessions the user has taken out of the list. */
  hiddenCount: number;
  /** How many analyzed sessions carry at least one deviation. */
  deviationCount: number;
  /** How many sessions the retrospective judged struggled or abandoned. */
  frictionCount: number;
  /** How many sessions match the current filters, loaded or not. */
  total: number;
  /** Sessions match beyond the rows loaded so far. */
  hasMore: boolean;
  loadingMore: boolean;
  refresh: () => void;
  rebuild: () => void;
  reload: () => void;
  loadMore: () => void;
}

/**
 * `filters` narrows the list in SQL — source, repository, date range and tag.
 * `showHidden` swaps it over to the sessions the user removed, so they can be
 * restored.
 */
export function useSessions(
  query: string,
  filters: SessionFilters,
  showHidden = false,
  onlyDeviations = false,
  onlyFriction = false,
): UseSessionsResult {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [status, setStatus] = useState<IndexStatus>({ indexed: 0, total: 0, phase: 'idle' });
  const [connection, setConnection] = useState<ConnectionState>(() => dataHost.connectionState());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [deviationCount, setDeviationCount] = useState(0);
  const [frictionCount, setFrictionCount] = useState(0);
  const [total, setTotal] = useState(0);

  // Held in a ref so the event subscription can merge without being torn down
  // and re-created on every render.
  const rowsRef = useRef<SessionRow[]>([]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // A filter set is a fresh object on every render, so the effect below keys off
  // its VALUE. Depending on the object itself would re-query forever.
  const key = filterKey(filters);

  const applyRows = useCallback((next: SessionRow[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const hiddenRef = useRef(showHidden);
  hiddenRef.current = showHidden;
  const deviationsRef = useRef(onlyDeviations);
  deviationsRef.current = onlyDeviations;
  const frictionRef = useRef(onlyFriction);
  frictionRef.current = onlyFriction;

  /**
   * Bumped by every fresh query. A page that arrives after the filters moved on
   * belongs to a different list, so it is dropped rather than appended to one it
   * was never part of.
   */
  const generation = useRef(0);

  const listParams = useCallback(
    (): ListSessionsParams => ({
      query: queryRef.current,
      ...toListParams(filtersRef.current),
      hidden: hiddenRef.current,
      ...(deviationsRef.current ? { deviations: true } : {}),
      ...(frictionRef.current ? { friction: true } : {}),
    }),
    [],
  );

  const load = useCallback(async () => {
    const mine = (generation.current += 1);
    const params = listParams();
    try {
      const next = await dataHost.call('sessions.list', { ...params, limit: PAGE_SIZE });
      if (generation.current !== mine) {
        return;
      }
      applyRows(next);
      setError(undefined);
      // The honest denominator for "showing N of M", counted over exactly the
      // same predicate the page came from.
      void dataHost
        .call('sessions.count', params)
        .then((count) => {
          if (generation.current === mine) {
            setTotal(count);
          }
        })
        .catch(() => undefined);
      void dataHost.call('sessions.hiddenCount').then(setHiddenCount).catch(() => undefined);
      console.log(`[sessions] loaded ${next.length} row(s)`);
    } catch (err) {
      if (generation.current === mine) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation.current === mine) {
        setLoading(false);
      }
    }
  }, [applyRows, listParams]);

  /**
   * The next page, appended.
   *
   * Paging is offset-based, which only works because every filter — the tag,
   * and a search over user-chosen names included — is decided inside the SQL
   * query. Anything filtered afterwards would make an offset skip rows.
   */
  const loadMore = useCallback(() => {
    const mine = generation.current;
    setLoadingMore(true);
    void dataHost
      .call('sessions.list', {
        ...listParams(),
        limit: PAGE_SIZE,
        offset: rowsRef.current.length,
      })
      .then((next) => {
        if (generation.current !== mine || next.length === 0) {
          return;
        }
        // Merged rather than concatenated: a row pushed while the page was in
        // flight may already be on screen, and appending it again would show
        // the same session twice.
        applyRows(mergeRows(rowsRef.current, next));
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        if (generation.current === mine) {
          setLoadingMore(false);
        }
      });
  }, [applyRows, listParams]);

  // Re-query whenever the search text or any filter changes. Filtering runs in
  // SQL rather than over the loaded page, so a match outside the first page is
  // still found.
  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => void load(), query.length === 0 ? 0 : 150);
    return () => clearTimeout(timer);
  }, [query, key, showHidden, onlyDeviations, onlyFriction, load]);

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
      // The Flagged and Struggled filters are decided by the background
      // analysis, and a push can both add a session and take one out. Rather
      // than reproduce that here, let the re-query below settle it — otherwise
      // a clean row would slide into a list that should only hold flagged ones.
      if (deviationsRef.current || frictionRef.current) {
        return;
      }
      // Source, repository, date and tag ARE all decidable from the row, so
      // both directions are handled: a row that now qualifies is merged in, and
      // one that stopped qualifying — an untagged session in a tag-filtered
      // list — is taken out rather than left sitting there.
      const active = filtersRef.current;
      const incoming = event.rows.filter((r) => matchesFilters(r, active));
      const dropped = event.rows
        .filter((r) => !matchesFilters(r, active))
        .map((r) => sessionKey(r.source, r.sessionId));
      if (incoming.length === 0 && dropped.length === 0) {
        return;
      }
      const gone = new Set(dropped);
      const kept =
        gone.size === 0
          ? rowsRef.current
          : rowsRef.current.filter((r) => !gone.has(sessionKey(r.source, r.sessionId)));
      applyRows(mergeRows(kept, incoming));
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
      void dataHost
        .call('sessions.count', { friction: true })
        .then(setFrictionCount)
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
        // Browsing now overlaps indexing. Searches cannot merge unfiltered
        // pushes, so settle them from SQL after the pass; keep ordinary lists
        // (and their loaded pages/scroll position) intact.
        if (queryRef.current.length > 0 || hiddenRef.current) {
          void load();
        } else {
          const mine = generation.current;
          void dataHost.call('sessions.count', listParams()).then((count) => {
            if (generation.current === mine) { setTotal(count); }
          }).catch(() => undefined);
        }
      }
    });

    // The flagged count is filled in by the background analysis, which runs
    // after indexing settles — so it moves on its own progress, not the index's.
    const offAnalysis = dataHost.on('analysis.progress', (event) => {
      if (event.event !== 'analysis.progress' || event.status.running) {
        return;
      }
      loadGroups();
      // A list filtered to flagged/struggled sessions is defined by what that
      // pass just decided, so it has to be re-read rather than patched.
      if (deviationsRef.current || frictionRef.current) {
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

  // Tags change only when the user edits them, so this follows the row pushes
  // that carry those edits rather than polling.
  const reloadTags = useCallback(() => {
    void dataHost
      .call('tags.list')
      .then(setTags)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reloadTags();
    return dataHost.on('sessions.upserted', () => reloadTags());
  }, [reloadTags]);

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
      tags,
      status,
      connection,
      loading,
      error,
      hiddenCount,
      deviationCount,
      frictionCount,
      total,
      // A live push can put more rows on screen than the count knew about, so
      // this compares rather than assuming the count is the larger number.
      hasMore: total > rows.length,
      loadingMore,
      refresh,
      rebuild,
      reload: load,
      loadMore,
    }),
    [
      rows,
      groups,
      tags,
      status,
      connection,
      loading,
      error,
      hiddenCount,
      deviationCount,
      frictionCount,
      total,
      loadingMore,
      refresh,
      rebuild,
      load,
      loadMore,
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
