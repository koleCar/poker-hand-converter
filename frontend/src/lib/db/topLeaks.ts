/**
 * The database side of the leak finder's top three (R5.2,
 * `20270728090000_leak_summaries.sql`): sums in, nothing decided.
 *
 * `analysis_top_leaks` returns the leak finder's rows (`analysis_leaks`'
 * shape) for three samples from the stored leak sums: the period (all time or
 * the last 30 days of play), the last 30 days of play and the 30 before.
 * `lib/analysis/leaks.ts` groups them, `lib/analysis/topLeaks.ts` ranks them.
 * `analysis_leak_examples` is the costliest decisions behind up to ten leaks.
 *
 * Both read the overview's filters only (format, the hero's seat, pot type)
 * and say which `analysis_version` they read.
 */

import { ANALYSIS_VERSION } from "../analysis";
import type { SpotRow } from "../analysis/leaks";
import type { TopPeriod } from "../analysis/topLeaks";
import { currentUserId, rpc } from "./client";
import type { AnalysisFilters } from "./analysis";

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
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown): string | null => (typeof value === "string" && DAY.test(value) ? value : null);

/** The filters the top three takes: the overview's scope, and the version. */
export function topLeaksFilters(filters: AnalysisFilters): AnalysisFilters {
  const out: AnalysisFilters = { analysisVersion: filters.analysisVersion ?? ANALYSIS_VERSION };
  if (filters.gameFormat) out.gameFormat = filters.gameFormat;
  if (filters.position) out.position = filters.position;
  if (filters.potType) out.potType = filters.potType;
  return out;
}

export interface LeakSample {
  /** Graded hands: the "per 100 hands" denominator. */
  hands: number;
  /** Graded decisions. */
  graded: number;
  rows: SpotRow[];
}

/** UTC days, inclusive. */
export interface DayWindow {
  from: string;
  to: string;
}

export interface TopLeaksReport {
  analysisVersion: string;
  period: TopPeriod;
  /** The day of the last graded hand in scope; null when there is none. */
  last: string | null;
  /** The last 30 days of play, and the 30 before. */
  current: DayWindow | null;
  prior: DayWindow | null;
  sample: LeakSample;
  now: LeakSample;
  was: LeakSample;
}

function windowOf(value: unknown): DayWindow | null {
  const w = (value ?? null) as Row | null;
  const from = day(w?.from);
  const to = day(w?.to);
  return from && to ? { from, to } : null;
}

function sampleOf(value: unknown): LeakSample {
  const s = (value ?? {}) as Row;
  return {
    hands: num(s.hands),
    graded: num(s.graded),
    rows: rows(s.rows).map((row) => ({
      key: String(row.key ?? ""),
      set: str(row.set),
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
  };
}

/** A payload of `analysis_top_leaks` as the screen reads it (exported for the tests). */
export function topLeaksFromPayload(payload: Row, period: TopPeriod): TopLeaksReport {
  return {
    analysisVersion: str(payload.analysisVersion) ?? ANALYSIS_VERSION,
    period: payload.period === "all" ? "all" : payload.period === "30d" ? "30d" : period,
    last: day(payload.last),
    current: windowOf(payload.current),
    prior: windowOf(payload.prior),
    sample: sampleOf(payload.sample),
    now: sampleOf(payload.now),
    was: sampleOf(payload.was),
  };
}

export async function fetchTopLeaks(filters: AnalysisFilters, period: TopPeriod): Promise<TopLeaksReport | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_top_leaks", { p_filters: topLeaksFilters(filters), p_period: period });
  return payload ? topLeaksFromPayload(payload, period) : null;
}

/* ------------------------------------------------------------- examples - */

export interface LeakExampleRow {
  handId: string;
  ord: number;
  /** Where the replayer opens (`PhfAction.index`). */
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
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
}

export interface LeakExamplesQuery {
  /** Each leak's id and finest spot keys (`Leak.keys`), at most 10 leaks of at most 200 keys. */
  leaks: Array<{ id: string; keys: string[] }>;
  /** UTC days, inclusive; null for all time. */
  window: DayWindow | null;
  /** Decisions per leak (the server takes 1-30). */
  limit: number;
}

export function examplesFromPayload(payload: Row | null): Map<string, LeakExampleRow[]> {
  const out = new Map<string, LeakExampleRow[]>();
  for (const leak of rows(payload?.leaks)) {
    out.set(
      String(leak.id ?? ""),
      rows(leak.rows).map((row) => ({
        handId: String(row.handId ?? ""),
        ord: num(row.ord),
        actionIndex: num(row.actionIndex),
        playedAt: str(row.playedAt),
        site: str(row.site) ?? "",
        stakesLabel: str(row.stakesLabel),
        position: str(row.position),
        heroCards: Array.isArray(row.heroCards) ? (row.heroCards as unknown[]).filter((c): c is string => typeof c === "string") : [],
        handClass: str(row.handClass),
        street: String(row.street ?? ""),
        scenario: String(row.scenario ?? ""),
        line: String(row.line ?? ""),
        taken: String(row.taken ?? ""),
        best: String(row.best ?? ""),
        grade: str(row.grade),
        evLossBb: maybeNum(row.evLossBb),
        evLossPot: maybeNum(row.evLossPot),
      })),
    );
  }
  return out;
}

export async function fetchLeakExamples(filters: AnalysisFilters, query: LeakExamplesQuery): Promise<Map<string, LeakExampleRow[]>> {
  const leaks = query.leaks.filter((leak) => leak.keys.length > 0).slice(0, 10);
  if (leaks.length === 0 || !(await currentUserId())) {
    return new Map();
  }
  const payload = await rpc<Row | null>("analysis_leak_examples", {
    p_filters: topLeaksFilters(filters),
    p_from: query.window?.from ?? null,
    p_to: query.window?.to ?? null,
    p_leaks: leaks.map((leak) => ({ id: leak.id, keys: leak.keys.slice(0, 200) })),
    p_limit: query.limit,
  });
  return examplesFromPayload(payload);
}
