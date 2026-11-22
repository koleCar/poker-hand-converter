/**
 * The checker's sums over the screen's filter (docs/ANALYTICS.md Step 4),
 * read when a tab that shows them is open (`enabled`) and again when the
 * filter or `reloadToken` changes. Another filter's sums keep showing,
 * dimmed, until the new ones land.
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
      .sums(JSON.parse(key.slice(0, key.lastIndexOf("#"))) as HandFilter)
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

  return { sums: state?.sums ?? null, loaded: state?.key === key, loading, error };
}
