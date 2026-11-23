/**
 * The Pool tab's data over the screen's filter (docs/ANALYTICS.md Step 10):
 * the surface's `PoolSums`, and the player's results with a fish in the pot
 * and with a reg or a fish (two reports over the Hands filter's "vs type",
 * `youQueries`). Read while the tab is open (`enabled`), again when the
 * filter or `reloadToken` changes. The sums show as soon as they come; the
 * two reports (slower: every hand's opponents by type) fill in after.
 *
 * Where the surface counts the pool in the browser (the web's `backfill`),
 * hands the pool has not counted (`pending`) are counted while the tab is
 * open, a page at a time, and the sums are read again when it is done; the
 * progress shows meanwhile. Leaving the tab stops it (it picks up where it
 * stopped: every page it finished is kept).
 */
import { useEffect, useRef, useState } from "react";

import { errorText, type HandFilter } from "../hands/model";
import type { Report, ReportSource } from "../reports/model";
import type { AnalyticsPool, PoolProgress, PoolSums } from "./model";
import { youQueries } from "./poolView";

/** A report's points: the pool reads the summary only. */
const POINTS = 2;

export interface PoolState {
  sums: PoolSums | null;
  withFish: Report | null;
  regOrFish: Report | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The browser counting the pool: hands left (null when not counting). */
  counting: number | null;
}

export function usePool(
  pool: AnalyticsPool | undefined,
  source: ReportSource,
  query: HandFilter,
  enabled: boolean,
  reloadToken: unknown = 0,
): PoolState {
  const [counted, setCounted] = useState(0);
  const key = `${JSON.stringify(query)}#${String(reloadToken)}#${counted}`;
  const [state, setState] = useState<{ key: string; sums: PoolSums | null } | null>(null);
  // The player's two reports over the "vs type" filters: slower than the
  // pool's sums on a large library, so they fill in after the tab shows.
  const [reports, setReports] = useState<{ key: string; withFish: Report | null; regOrFish: Report | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counting, setCounting] = useState<number | null>(null);
  const generation = useRef(0);
  // A count that went through nothing is not started again (a hand the browser cannot read stays pending).
  const stalled = useRef(false);

  useEffect(() => {
    if (!pool || !enabled || state?.key === key) return;
    const mine = ++generation.current;
    const filter = JSON.parse(key.slice(0, key.indexOf("#"))) as HandFilter;
    const queries = youQueries(filter);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts loading
    setLoading(true);
    pool
      .sums(filter)
      .then((sums) => {
        if (mine !== generation.current) return;
        setState({ key, sums });
        setError(null);
      })
      .catch((reason: unknown) => {
        if (mine === generation.current) setError(errorText(reason));
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
    Promise.all([source.report(queries.fish, POINTS), source.report(queries.regOrFish, POINTS)])
      .then(([withFish, regOrFish]) => {
        if (mine === generation.current) setReports({ key, withFish, regOrFish });
      })
      .catch((reason: unknown) => {
        if (mine === generation.current) setError(errorText(reason));
      });
  }, [pool, source, enabled, key, state?.key]);

  // The browser's count of what the pool has not counted yet.
  const pending = state?.key === key ? (state.sums?.pending ?? 0) : 0;
  const backfill = pool?.backfill;
  useEffect(() => {
    if (!backfill || !enabled || pending <= 0 || stalled.current) return;
    const stop = new AbortController();
    setCounting(pending);
    backfill
      .call(pool, stop.signal, (progress: PoolProgress) => {
        if (!stop.signal.aborted) setCounting(Math.max(0, pending - progress.processed));
      })
      .then((done: PoolProgress) => {
        if (stop.signal.aborted) return;
        if (done.processed === 0) stalled.current = true;
        setCounted((n) => n + 1);
      })
      .catch((reason: unknown) => {
        if (!stop.signal.aborted) setError(errorText(reason));
      })
      .finally(() => {
        if (!stop.signal.aborted) setCounting(null);
      });
    return () => {
      stop.abort();
      setCounting(null);
    };
  }, [backfill, pool, enabled, pending]);

  const current = state?.key === key ? state : null;
  const shown = current ?? state;
  const you = reports?.key === key ? reports : current === null ? reports : null;
  return {
    sums: shown?.sums ?? null,
    withFish: you?.withFish ?? null,
    regOrFish: you?.regOrFish ?? null,
    loaded: current !== null,
    loading,
    error,
    counting,
  };
}
