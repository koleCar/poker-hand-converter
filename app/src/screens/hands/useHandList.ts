/**
 * The Hands list's data: pages through the store with the keyset cursor
 * (`hands_page`), the chips' counts (`hands_facets`), and new hands as they
 * arrive (the watcher's change event: the first page is read again and what
 * is newer than the top row is put on top, so the rows the reader is looking
 * at do not move).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { errorText, inApp, ipc, onWatcherChanged, type HandCursor, type HandFacets, type HandFilter, type HandRow } from "../../lib/ipc";

/** The first page: a screenful and a scroll. */
export const FIRST_PAGE = 100;
/** Later pages, fetched as the reader nears the end of what is loaded. */
export const NEXT_PAGE = 300;
/** At most once per this many ms, after the watcher reports an import. */
const ARRIVAL_THROTTLE_MS = 2000;

export interface HandList {
  rows: HandRow[];
  /** Still more rows after the last one loaded. */
  hasMore: boolean;
  /** The first page is loading (rows are from the previous filter until it lands). */
  loading: boolean;
  /** A later page is loading. */
  loadingMore: boolean;
  error: string | null;
  facets: HandFacets | null;
  loadMore: () => void;
  /** A row changed (its note or tags): the list shows the new values. */
  updateRow: (handKey: string, change: Partial<HandRow>) => void;
}

/** Whether `a` comes before `b` in the list (newest first): `played_at`
 * ('' when none) descending, then `hand_key` descending. */
function newer(a: HandRow, b: HandRow): boolean {
  const at = a.playedAt ?? "";
  const bt = b.playedAt ?? "";
  return at === bt ? a.handKey > b.handKey : at > bt;
}

export function useHandList(query: HandFilter): HandList {
  const [rows, setRows] = useState<HandRow[]>([]);
  const [next, setNext] = useState<HandCursor | null>(null);
  const [loading, setLoading] = useState(inApp);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<HandFacets | null>(null);
  // Which query the state belongs to: an answer for an older one is dropped.
  const generation = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    const mine = ++generation.current;
    const filter = JSON.parse(queryKey) as HandFilter;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts loading
    setLoading(true);
    ipc
      .handsPage(filter, null, FIRST_PAGE)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows(page.rows);
        setNext(page.next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (generation.current !== mine) return;
        setRows([]);
        setNext(null);
        setError(errorText(reason));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
    ipc
      .handsFacets(filter)
      .then((value) => {
        if (generation.current === mine) setFacets(value);
      })
      .catch(() => undefined);
  }, [queryKey]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore || loading) {
      return;
    }
    const mine = generation.current;
    const filter = JSON.parse(queryKey) as HandFilter;
    setLoadingMore(true);
    ipc
      .handsPage(filter, next, NEXT_PAGE)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((current) => current.concat(page.rows));
        setNext(page.next);
      })
      .catch((reason: unknown) => {
        if (generation.current === mine) setError(errorText(reason));
      })
      .finally(() => setLoadingMore(false));
  }, [next, loadingMore, loading, queryKey]);

  // Hands arriving while the screen is open.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    let last = 0;
    let timer: number | undefined;
    const refresh = () => {
      last = Date.now();
      const mine = generation.current;
      const filter = JSON.parse(queryKey) as HandFilter;
      ipc
        .handsPage(filter, null, FIRST_PAGE)
        .then((page) => {
          if (generation.current !== mine) return;
          const top = rowsRef.current[0];
          if (!top) {
            setRows(page.rows);
            setNext(page.next);
            return;
          }
          const fresh = page.rows.filter((row) => newer(row, top));
          if (fresh.length === page.rows.length && page.next) {
            // More arrived than a page: start over from the top.
            setRows(page.rows);
            setNext(page.next);
          } else if (fresh.length > 0) {
            setRows((current) => fresh.concat(current));
          }
        })
        .catch(() => undefined);
      ipc
        .handsFacets(filter)
        .then((value) => {
          if (generation.current === mine) setFacets(value);
        })
        .catch(() => undefined);
    };
    const stop = onWatcherChanged(() => {
      const wait = last + ARRIVAL_THROTTLE_MS - Date.now();
      if (timer !== undefined) return;
      timer = window.setTimeout(
        () => {
          timer = undefined;
          refresh();
        },
        Math.max(0, wait),
      );
    });
    return () => {
      stop();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [queryKey]);

  const updateRow = useCallback((handKey: string, change: Partial<HandRow>) => {
    setRows((current) => current.map((row) => (row.handKey === handKey ? { ...row, ...change } : row)));
  }, []);

  return { rows, hasMore: next !== null, loading, loadingMore, error, facets, loadMore, updateRow };
}
