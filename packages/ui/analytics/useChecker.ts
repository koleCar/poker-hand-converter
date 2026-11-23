/**
 * The checker's sums over the screen's filter (docs/ANALYTICS.md Step 4),
 * read when a tab that shows them is open (`enabled`) and again when the
 * filter or `reloadToken` changes. Another filter's sums keep showing,
 * dimmed, until the new ones land.
 *
 * Where the surface derives the rows in the browser (the web's `backfill`,
 * Step 12), hands analysed without rows (`pending`: analysed before the
 * checker existed, or at another catalogue version) are filled while a tab
 * that reads the checker is open, a page at a time, and the sums are read
 * again when it is done; `filling` counts down meanwhile. Leaving the tabs
 * stops it (every page it finished is kept). The backfill walks the hands
 * in id order - a random order - so the numbers shown while it runs are a
 * fair sample, not the oldest or newest hands.
 */
import { useEffect, useRef, useState } from "react";

import { errorText, type HandFilter } from "../hands/model";
import type { AnalyticsChecker, CheckerProgress, CheckerSums } from "./model";

export interface CheckerState {
  sums: CheckerSums | null;
  /** Read at least once for the current filter (`null` sums then mean "nothing"). */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The browser deriving the rows of analysed hands: hands left (null when not filling). */
  filling: number | null;
}

export function useChecker(
  checker: AnalyticsChecker | undefined,
  query: HandFilter,
  enabled: boolean,
  reloadToken: unknown = 0,
): CheckerState {
  const [filled, setFilled] = useState(0);
  const [state, setState] = useState<{ key: string; sums: CheckerSums | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState<number | null>(null);
  const generation = useRef(0);
  // A fill that went through nothing is not started again (a hand the browser cannot read stays pending).
  const stalled = useRef(false);
  // The pending count the last fill started from: a fill that did not lower it is not started again.
  const startedFrom = useRef<number | null>(null);
  const key = `${JSON.stringify(query)}#${String(reloadToken)}#${filled}`;

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

  // The browser's fill of what the checker has no rows for yet.
  const pending = state?.key === key ? (state.sums?.pending ?? 0) : 0;
  const backfill = checker?.backfill;
  useEffect(() => {
    if (!backfill || !enabled || pending <= 0 || stalled.current) return;
    if (startedFrom.current !== null && pending >= startedFrom.current) {
      stalled.current = true;
      return;
    }
    startedFrom.current = pending;
    const stop = new AbortController();
    let finished = false;
    setFilling(pending);
    backfill
      .call(checker, stop.signal, (progress: CheckerProgress) => {
        if (!stop.signal.aborted) setFilling(Math.max(0, pending - progress.processed));
      })
      .then((done: CheckerProgress) => {
        finished = true;
        if (stop.signal.aborted) return;
        if (done.processed === 0) stalled.current = true;
        setFilled((n) => n + 1);
      })
      .catch((reason: unknown) => {
        finished = true;
        if (stop.signal.aborted) return;
        // The numbers already read stay; the fill is tried again on the next visit.
        stalled.current = true;
        setError(errorText(reason));
      })
      .finally(() => {
        if (!stop.signal.aborted) setFilling(null);
      });
    return () => {
      // Left before it finished: the next visit starts it again.
      if (!finished) startedFrom.current = null;
      stop.abort();
      setFilling(null);
    };
  }, [backfill, checker, enabled, pending]);

  const current = state?.key === key ? state : null;
  return { sums: (current ?? state)?.sums ?? null, loaded: current !== null, loading, error, filling };
}
