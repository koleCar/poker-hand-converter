/**
 * The database side of leaks and progress (phase A6,
 * `20270201090000_analysis_leaks.sql`): sums in, nothing decided.
 *
 * `analysis_leaks` returns graded decisions summed per finest spot;
 * `lib/analysis/leaks.ts` groups them into leaks, merges thin ones, ranks and
 * compares periods. `analysis_leak_hands` is the list behind a leak, and
 * `analysis_trend` the same sums per week, month or session.
 *
 * Every call says which `analysis_version` it reads, like every other
 * analysis report (`withVersion` in `analysis.ts`).
 */

import { ANALYSIS_VERSION } from "../analysis";
import type { SpotRow, TrendRow } from "../analysis/leaks";
import type { OptionAnalysis } from "../analysis/types";
import { currentUserId, rpc } from "./client";
import type { AnalysisFilters } from "./analysis";
import type { ReportFacets } from "./analysisReports";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const maybeNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

const withVersion = (filters: AnalysisFilters): AnalysisFilters => ({ analysisVersion: ANALYSIS_VERSION, ...filters });

function facetsOf(value: unknown): ReportFacets {
  const facets = (value ?? {}) as Row;
  return {
    sites: rows(facets.sites).map((row) => ({ site: String(row.site ?? ""), hands: num(row.hands) })),
    stakes: rows(facets.stakes).map((row) => ({
      currency: String(row.currency ?? ""),
      currencyMinorUnits: num(row.currencyMinorUnits),
      smallBlind: maybeNum(row.smallBlind),
      bigBlind: maybeNum(row.bigBlind),
      hands: num(row.hands),
    })),
    first: str(facets.first),
    last: str(facets.last),
  };
}

/* ----------------------------------------------------------------- leaks - */

export interface LeaksReport {
  analysisVersion: string;
  /** Graded hands in scope: the "per 100 hands" denominator. */
  hands: number;
  /** Graded decisions in scope. */
  graded: number;
  /** First and last graded hand in scope, ISO. */
  first: string | null;
  last: string | null;
  rows: SpotRow[];
  facets: ReportFacets;
}

export async function fetchLeaks(filters: AnalysisFilters = {}): Promise<LeaksReport | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_leaks", { p_filters: withVersion(filters) });
  if (!payload) {
    return null;
  }
  return {
    analysisVersion: str(payload.analysisVersion) ?? ANALYSIS_VERSION,
    hands: num(payload.hands),
    graded: num(payload.graded),
    first: str(payload.first),
    last: str(payload.last),
    rows: rows(payload.rows).map((row) => ({
      key: String(row.key ?? ""),
      street: String(row.street ?? ""),
      scenario: String(row.scenario ?? ""),
      line: String(row.line ?? ""),
      position: String(row.position ?? ""),
      taken: String(row.taken ?? ""),
      best: String(row.best ?? ""),
      decisions: num(row.decisions),
      hands: num(row.hands),
      nonPerfect: num(row.nonPerfect),
      mistakes: num(row.mistakes),
      evLossBb: num(row.evLossBb),
      evLossPot: num(row.evLossPot),
      scoreSum: num(row.scoreSum),
      scoreSq: num(row.scoreSq),
    })),
    facets: facetsOf(payload.facets),
  };
}

export const LEAK_HAND_SORTS = ["ev_loss", "ev_loss_pot", "recent", "oldest"] as const;
export type LeakHandSort = (typeof LEAK_HAND_SORTS)[number];

export interface LeakHandRow {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  site: string;
  stakesLabel: string | null;
  position: string | null;
  heroCards: string[];
  handClass: string | null;
  street: string;
  scenario: string;
  line: string;
  taken: string;
  best: string;
  source: string;
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
  options: OptionAnalysis[];
  chosen: number | null;
}

export interface LeakHandsPage {
  total: number;
  rows: LeakHandRow[];
}

export interface LeakHandsQuery {
  /** Finest spot keys (`Leak.keys`). */
  keys: string[];
  /** Only decisions graded worse than Perfect. Default true. */
  deviations?: boolean;
  sort?: LeakHandSort;
  limit?: number;
  offset?: number;
}

export async function fetchLeakHands(filters: AnalysisFilters, query: LeakHandsQuery): Promise<LeakHandsPage> {
  if (query.keys.length === 0 || !(await currentUserId())) {
    return { total: 0, rows: [] };
  }
  const payload = await rpc<Row | null>("analysis_leak_hands", {
    p_filters: withVersion(filters),
    p_keys: query.keys.slice(0, 500),
    p_deviations: query.deviations ?? true,
    p_sort: query.sort ?? "ev_loss",
    p_limit: query.limit ?? 10,
    p_offset: query.offset ?? 0,
  });
  return {
    total: num(payload?.total),
    rows: rows(payload?.rows).map((row) => ({
      handId: String(row.handId ?? ""),
      ord: num(row.ord),
      actionIndex: num(row.actionIndex),
      playedAt: str(row.playedAt),
      site: str(row.site) ?? "",
      stakesLabel: str(row.stakesLabel),
      position: str(row.position),
      heroCards: Array.isArray(row.heroCards) ? (row.heroCards as string[]) : [],
      handClass: str(row.handClass),
      street: String(row.street ?? ""),
      scenario: String(row.scenario ?? ""),
      line: String(row.line ?? ""),
      taken: String(row.taken ?? ""),
      best: String(row.best ?? ""),
      source: String(row.source ?? ""),
      grade: str(row.grade),
      evLossBb: maybeNum(row.evLossBb),
      evLossPot: maybeNum(row.evLossPot),
      options: Array.isArray(row.options) ? (row.options as OptionAnalysis[]) : [],
      chosen: maybeNum(row.chosen),
    })),
  };
}

/* ----------------------------------------------------------------- trend - */

export const TREND_BUCKETS = ["week", "month", "session"] as const;
export type TrendBucket = (typeof TREND_BUCKETS)[number];
export const TREND_GROUPS = ["all", "street", "position", "pot_type"] as const;
export type TrendGroup = (typeof TREND_GROUPS)[number];

export interface TrendReport {
  analysisVersion: string;
  bucket: TrendBucket;
  group: TrendGroup;
  gapMinutes: number;
  rows: TrendRow[];
  facets: ReportFacets;
}

export async function fetchTrend(
  filters: AnalysisFilters,
  bucket: TrendBucket,
  group: TrendGroup = "all",
): Promise<TrendReport | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_trend", {
    p_filters: withVersion(filters),
    p_bucket: bucket,
    p_group: group,
  });
  if (!payload) {
    return null;
  }
  return {
    analysisVersion: str(payload.analysisVersion) ?? ANALYSIS_VERSION,
    bucket,
    group,
    gapMinutes: num(payload.gapMinutes) || 30,
    rows: rows(payload.rows).map((row) => ({
      start: String(row.start ?? ""),
      end: String(row.end ?? ""),
      first: str(row.first),
      last: str(row.last),
      key: String(row.key ?? ""),
      bucketHands: num(row.bucketHands),
      hands: num(row.hands),
      graded: num(row.graded),
      nonPerfect: num(row.nonPerfect),
      mistakes: num(row.mistakes),
      evLossBb: num(row.evLossBb),
      evLossPot: num(row.evLossPot),
      scoreSum: num(row.scoreSum),
      scoreSq: num(row.scoreSq),
    })),
    facets: facetsOf(payload.facets),
  };
}
