/**
 * The Hands list's data: pages through the surface's `HandsSource` with its
 * keyset cursor, the chips' counts, and new hands as they arrive (the
 * source's change event - the desktop's watcher, the web's live arrivals:
 * the first page is read again and what is newer than the top row is put on
 * top, so the rows the reader is looking at do not move; in another order,
 * only the counts are read again). The desktop app's (R2.7a), shared since
 * R4.5b.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { errorText, type HandCursor, type HandFacets, type HandFilter, type HandRow, type HandsSource } from "./model";

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
  /** Read the first page and the counts again (the surface knows the hands changed). */
  reload: () => void;
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

export function useHandList(source: HandsSource, query: HandFilter): HandList {
  const [rows, setRows] = useState<HandRow[]>([]);
  const [next, setNext] = useState<HandCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<HandFacets | null>(null);
  // Which query the state belongs to: an answer for an older one is dropped.
  const generation = useRef(0);
  const queryKey = JSON.stringify(query);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    const mine = ++generation.current;
    const filter = JSON.parse(queryKey) as HandFilter;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts loading
    setLoading(true);
    source
      .page(filter, null, FIRST_PAGE)
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
    source
      .facets(filter)
      .then((value) => {
        if (generation.current === mine) setFacets(value);
      })
      .catch(() => undefined);
  }, [source, queryKey, reloads]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore || loading) {
      return;
    }
    const mine = generation.current;
    const filter = JSON.parse(queryKey) as HandFilter;
    setLoadingMore(true);
    source
      .page(filter, next, NEXT_PAGE)
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((current) => current.concat(page.rows));
        setNext(page.next);
      })
      .catch((reason: unknown) => {
        if (generation.current === mine) setError(errorText(reason));
      })
      .finally(() => setLoadingMore(false));
  }, [source, next, loadingMore, loading, queryKey]);

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
      const newestFirst = (filter.sort ?? "newest") === "newest";
      source
        .page(filter, null, FIRST_PAGE)
        .then((page) => {
          if (generation.current !== mine || !newestFirst) return;
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
      source
        .facets(filter)
        .then((value) => {
          if (generation.current === mine) setFacets(value);
        })
        .catch(() => undefined);
    };
    const stop = source.onChanged?.(() => {
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
      stop?.();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [source, queryKey]);

  const updateRow = useCallback((handKey: string, change: Partial<HandRow>) => {
    setRows((current) => current.map((row) => (row.handKey === handKey ? { ...row, ...change } : row)));
  }, []);

  return { rows, hasMore: next !== null, loading, loadingMore, error, facets, loadMore, reload, updateRow };
}
