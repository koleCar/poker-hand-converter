/**
 * The checker's sums over the screen's filter (docs/ANALYTICS.md Step 4),
 * read when a tab that shows them is open (`enabled`) and again when the
 * filter or `reloadToken` changes. Another filter's sums keep showing,
 * dimmed, until the new ones land.
 *
 * Nothing is derived here: the surface writes the rows away from the screen
 * (the desktop's background pass, the web's server - docs/POOL.md P1), and
 * `pending` says how many are still to come.
 */
import { useEffect, useRef, useState } from "react";

import { errorText, type HandFilter } from "../hands/model";
import type { AnalyticsChecker, CheckerSums } from "./model";

export interface CheckerState {
  sums: CheckerSums | null;
  /** Read at least once for the current filter (`null` sums then mean "nothing"). */
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export function useChecker(
  checker: AnalyticsChecker | undefined,
  query: HandFilter,
  enabled: boolean,
  reloadToken: unknown = 0,
): CheckerState {
  const [state, setState] = useState<{ key: string; sums: CheckerSums | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const key = `${JSON.stringify(query)}#${String(reloadToken)}`;

  useEffect(() => {
    if (!checker || !enabled || state?.key === key) return;
    const mine = ++generation.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts loading
    setLoading(true);
    checker
      .sums(JSON.parse(key.slice(0, key.indexOf("#"))) as HandFilter)
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
  }, [checker, enabled, key, state?.key]);

  const current = state?.key === key ? state : null;
  return { sums: (current ?? state)?.sums ?? null, loaded: current !== null, loading, error };
}
