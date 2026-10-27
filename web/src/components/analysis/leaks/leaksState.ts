/**
 * Leaks' and Progress' state, as it lives in the address bar (phase A6).
 *
 * Both take the Reports filters — dates, room, stake, seat, under the same
 * keys (`reportsState.ts`) — so a filter carried from one screen to another
 * means the same thing, and add their own view: the leak finder its street,
 * ranking and open leak; progress its bucket, split and metric.
 *
 * Parsing is a whitelist, like every list state in the tab: anything that is
 * not one of these keys with a value of the expected shape is dropped, and a
 * stale bookmark degrades to the default view.
 */

import { LEAK_SORTS, LEAK_STREETS, parseLeakId, type LeakSort } from "../../../lib/analysis/leaks";
import { TREND_BUCKETS, TREND_GROUPS, type TrendBucket, type TrendGroup } from "../../../lib/db/analysisLeaks";
import { EMPTY_REPORTS_STATE, parseReportsState, reportsQuery, type ReportsState } from "../reports/reportsState";

type Source = URLSearchParams | Record<string, string | string[] | undefined>;

function getter(source: Source) {
  return (key: string): string | null => {
    if (source instanceof URLSearchParams) return source.get(key);
    const value = source[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/* ----------------------------------------------------------------- leaks - */

export interface LeaksState extends ReportsState {
  street: string | null;
  sort: LeakSort;
  /** The open leak's id (`leakId`), or null. */
  leak: string | null;
}

export const EMPTY_LEAKS_STATE: LeaksState = { ...EMPTY_REPORTS_STATE, street: null, sort: "ev", leak: null };

export function parseLeaksState(source: Source): LeaksState {
  const get = getter(source);
  const leak = get("leak");
  return {
    ...parseReportsState(source),
    street: pick(get("street"), LEAK_STREETS),
    sort: pick(get("sort"), LEAK_SORTS) ?? "ev",
    leak: leak && parseLeakId(leak) ? leak : null,
  };
}

export function leaksQuery(state: LeaksState): string {
  const params = new URLSearchParams(reportsQuery(state));
  if (state.street) params.set("street", state.street);
  if (state.sort !== "ev") params.set("sort", state.sort);
  if (state.leak) params.set("leak", state.leak);
  return params.toString();
}

/* -------------------------------------------------------------- progress - */

export const PROGRESS_METRICS = ["score", "ev", "off"] as const;
export type ProgressMetric = (typeof PROGRESS_METRICS)[number];

export interface ProgressState extends ReportsState {
  bucket: TrendBucket;
  group: TrendGroup;
  metric: ProgressMetric;
}

export const EMPTY_PROGRESS_STATE: ProgressState = { ...EMPTY_REPORTS_STATE, bucket: "week", group: "all", metric: "score" };

export function parseProgressState(source: Source): ProgressState {
  const get = getter(source);
  return {
    ...parseReportsState(source),
    bucket: pick(get("bucket"), TREND_BUCKETS) ?? "week",
    group: pick(get("by"), TREND_GROUPS) ?? "all",
    metric: pick(get("metric"), PROGRESS_METRICS) ?? "score",
  };
}

export function progressQuery(state: ProgressState): string {
  const params = new URLSearchParams(reportsQuery(state));
  if (state.bucket !== "week") params.set("bucket", state.bucket);
  if (state.group !== "all") params.set("by", state.group);
  if (state.metric !== "score") params.set("metric", state.metric);
  return params.toString();
}

/** A `[from, to)` ISO window as the Reports date filters (UTC days, `to` inclusive). */
export function windowState(from: string, to: string): Pick<ReportsState, "from" | "to"> {
  const lastDay = new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from: from.slice(0, 10), to: lastDay };
}
