/**
 * Reports' data (R2.7b): the report over the filter (`report`: the hero's
 * statistics, the graph, the rollups' breakdowns), the chips' counts
 * (`hands_facets`, the Hands screen's), and the breakdowns by situation
 * when a tab asks for them (`report_breakdowns`, one pass over the hero's
 * rows, cached by the store until the next commit). Hands arriving while
 * the screen is open read the report again, at most every few seconds: a
 * backfill streaming in costs a report per pause, not per file.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  errorText,
  inApp,
  ipc,
  onWatcherChanged,
  type Breakdowns,
  type HandFacets,
  type HandFilter,
  type Report,
} from "../../lib/ipc";

/** The graph's resolution: about a point per pixel on a wide window (the store caps it). */
export const GRAPH_POINTS = 1200;
/** At most once per this many ms after the watcher reports an import. */
const ARRIVAL_THROTTLE_MS = 5000;

export interface ReportState {
  report: Report | null;
  /** The report is loading (what is shown is the previous filter's until it lands). */
  loading: boolean;
  error: string | null;
  facets: HandFacets | null;
  /** The breakdowns by situation of the current filter, once asked for. */
  breakdowns: Breakdowns | null;
  breakdownsLoading: boolean;
  /** Ask for the breakdowns by situation (a tab that needs them is open). */
  wantBreakdowns: () => void;
}

/** `ready`: whether to read the report yet (the counts are read either way). */
export function useReport(query: HandFilter, ready = true): ReportState {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(inApp);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<HandFacets | null>(null);
  const [breakdowns, setBreakdowns] = useState<{ key: string; value: Breakdowns } | null>(null);
  const [wanted, setWanted] = useState(false);
  const [breakdownsLoading, setBreakdownsLoading] = useState(false);
  /** Bumped when hands arrive: everything is read again. */
  const [arrivals, setArrivals] = useState(0);
  const generation = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (!inApp) return;
    const mine = ++generation.current;
    const filter = JSON.parse(queryKey) as HandFilter;
    ipc
      .handsFacets(filter)
      .then((next) => {
        if (mine === generation.current) setFacets(next);
      })
      .catch(() => undefined);
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts loading
    setLoading(true);
    ipc
      .report(filter, GRAPH_POINTS)
      .then((next) => {
        if (mine !== generation.current) return;
        setReport(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (mine === generation.current) setError(errorText(reason));
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false);
      });
  }, [queryKey, arrivals, ready]);

  const breakdownKey = `${queryKey}#${arrivals}`;
  useEffect(() => {
    if (!inApp || !wanted || breakdowns?.key === breakdownKey) return;
    let current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a tab asked for them
    setBreakdownsLoading(true);
    ipc
      .reportBreakdowns(JSON.parse(queryKey) as HandFilter)
      .then((value) => {
        if (current) setBreakdowns({ key: breakdownKey, value });
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      })
      .finally(() => {
        if (current) setBreakdownsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [wanted, breakdownKey, breakdowns?.key, queryKey]);

  // New hands: read everything again, throttled.
  useEffect(() => {
    if (!inApp) return;
    let timer: number | undefined;
    const stop = onWatcherChanged(() => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        setArrivals((n) => n + 1);
      }, ARRIVAL_THROTTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);

  const wantBreakdowns = useCallback(() => setWanted(true), []);
  return {
    report,
    loading,
    error,
    facets,
    breakdowns: breakdowns?.key === breakdownKey ? breakdowns.value : null,
    breakdownsLoading,
    wantBreakdowns,
  };
}
