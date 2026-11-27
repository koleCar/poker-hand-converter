/**
 * The Pool tab's data over the screen's filter (docs/ANALYTICS.md Step 10):
 * the surface's `PoolSums`, and the player's results with a fish in the pot
 * and with a reg or a fish (two reports over the Hands filter's "vs type",
 * `youQueries`). Read while the tab is open (`enabled`), again when the
 * filter or `reloadToken` changes. The sums show as soon as they come; the
 * two reports (slower: every hand's opponents by type) fill in after.
 *
 * Nothing is counted here: the surface counts the pool away from the screen
 * (the desktop's background pass, the web's server - docs/POOL.md P1), and
 * `pending` says how many hands are still to come.
 */
import { useEffect, useRef, useState } from "react";

import { errorText, type HandFilter } from "../hands/model";
import type { Report, ReportSource } from "../reports/model";
import type { AnalyticsPool, PoolSums } from "./model";
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
}

export function usePool(
  pool: AnalyticsPool | undefined,
  source: ReportSource,
  query: HandFilter,
  enabled: boolean,
  reloadToken: unknown = 0,
): PoolState {
  const key = `${JSON.stringify(query)}#${String(reloadToken)}`;
  const [state, setState] = useState<{ key: string; sums: PoolSums | null } | null>(null);
  // The player's two reports over the "vs type" filters: slower than the
  // pool's sums on a large library, so they fill in after the tab shows.
  const [reports, setReports] = useState<{ key: string; withFish: Report | null; regOrFish: Report | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

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
  };
}
