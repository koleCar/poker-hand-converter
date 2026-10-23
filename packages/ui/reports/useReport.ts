/**
 * Reports' data (R2.7b; shared since R4.5c): the report over the filter (the
 * hero's statistics, the graph, the rollups' breakdowns), the chips' counts,
 * and the breakdowns by situation when a tab asks for them - from the
 * surface's `ReportSource`. Hands arriving while the screen is open read
 * everything again, at most every few seconds: a backfill streaming in costs
 * a report per pause, not per file. `reloadToken` reads it all again too (the
 * web's rebuild finishing).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { errorText, type HandFacets, type HandFilter } from "../hands/model";
import type { Breakdowns, Report, ReportSource } from "./model";

/** At most once per this many ms after the source reports new hands. */
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
export function useReport(source: ReportSource, query: HandFilter, ready = true, reloadToken: unknown = 0): ReportState {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<HandFacets | null>(null);
  const [breakdowns, setBreakdowns] = useState<{ key: string; value: Breakdowns } | null>(null);
  const [wanted, setWanted] = useState(false);
  const [breakdownsLoading, setBreakdownsLoading] = useState(false);
  /** Bumped when hands arrive: everything is read again. */
  const [arrivals, setArrivals] = useState(0);
  const generation = useRef(0);
  const queryKey = JSON.stringify(query);
  const reloadKey = `${arrivals}|${String(reloadToken)}`;

  useEffect(() => {
    const mine = ++generation.current;
    const filter = JSON.parse(queryKey) as HandFilter;
    source
      .facets(filter)
      .then((next) => {
        if (mine === generation.current) setFacets(next);
      })
      .catch(() => undefined);
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts loading
    setLoading(true);
    source
      .report(filter, source.graphPoints)
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
  }, [source, queryKey, reloadKey, ready]);

  const breakdownKey = `${queryKey}#${reloadKey}`;
  useEffect(() => {
    if (!wanted || breakdowns?.key === breakdownKey) return;
    let current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a tab asked for them
    setBreakdownsLoading(true);
    source
      .breakdowns(JSON.parse(queryKey) as HandFilter)
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
  }, [source, wanted, breakdownKey, breakdowns?.key, queryKey]);

  // New hands: read everything again, throttled.
  useEffect(() => {
    if (!source.onChanged) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = source.onChanged(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        setArrivals((n) => n + 1);
      }, ARRIVAL_THROTTLE_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [source]);

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
