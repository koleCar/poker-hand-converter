/**
 * The database side of training (phase A7, `20270208090000_analysis_training.sql`).
 *
 * Drills are the player's own Mistakes, scheduled by SM-2 in the database
 * (`review_drill` runs `drill_next`); trainer answers are kept for the long
 * view. The browser grades (`lib/training`), the database stores and counts.
 * Every call names the `analysis_version` it reads, like every analysis report.
 */

import { ANALYSIS_VERSION } from "../analysis";
import type { Grade } from "../analysis/types";
import { currentUserId, rpc } from "./client";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/** The end of the reader's day, for "due today". */
export function endOfToday(now = new Date()): string {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}

/* --------------------------------------------------------------- drills - */

export interface DrillSync {
  inserted: number;
  updated: number;
  total: number;
}

/** Builds drills from the caller's graded Mistakes and Blunders (and Inaccurate moves when asked). */
export async function syncDrills(minGrade: "inaccurate" | "mistake" | "blunder" = "mistake"): Promise<DrillSync | null> {
  if (!(await currentUserId())) return null;
  const payload = await rpc<Row | null>("sync_drill_items", { p_version: ANALYSIS_VERSION, p_min_grade: minGrade });
  return { inserted: num(payload?.inserted), updated: num(payload?.updated), total: num(payload?.total) };
}

export interface DrillItem {
  id: string;
  handId: string;
  actionIndex: number;
  ord: number;
  street: string;
  spotKey: string;
  sourceGrade: Grade;
  sourceEvLossBb: number;
  reps: number;
  lapses: number;
  ease: number;
  intervalDays: number;
  dueAt: string;
  reviews: number;
  lastGrade: Grade | null;
  due: boolean;
}

export interface DrillQuery {
  /** Finest spot keys (a leak's `keys`); all drills when absent. */
  keys?: string[] | null;
  /** Only drills due now (default), or every drill in due order. */
  dueOnly?: boolean;
  limit?: number;
}

export async function fetchDrillQueue(query: DrillQuery = {}): Promise<DrillItem[]> {
  if (!(await currentUserId())) return [];
  const payload = await rpc<unknown>("drill_queue", {
    p_version: ANALYSIS_VERSION,
    p_keys: query.keys && query.keys.length > 0 ? query.keys.slice(0, 500) : undefined,
    p_due_only: query.dueOnly ?? true,
    p_limit: query.limit ?? 20,
  });
  return rows(payload).map((row) => ({
    id: String(row.id ?? ""),
    handId: String(row.handId ?? ""),
    actionIndex: num(row.actionIndex),
    ord: num(row.ord),
    street: String(row.street ?? ""),
    spotKey: String(row.spotKey ?? ""),
    sourceGrade: (str(row.sourceGrade) ?? "mistake") as Grade,
    sourceEvLossBb: num(row.sourceEvLossBb),
    reps: num(row.reps),
    lapses: num(row.lapses),
    ease: num(row.ease),
    intervalDays: num(row.intervalDays),
    dueAt: String(row.dueAt ?? ""),
    reviews: num(row.reviews),
    lastGrade: str(row.lastGrade) as Grade | null,
    due: row.due === true,
  }));
}

export interface DrillReview {
  reps: number;
  lapses: number;
  ease: number;
  intervalDays: number;
  dueAt: string;
  relearn: boolean;
}

export async function reviewDrill(id: string, chosen: number, grade: Grade, evLossBb: number): Promise<DrillReview> {
  const payload = await rpc<Row | null>("review_drill", {
    p_item: id,
    p_chosen: chosen,
    p_grade: grade,
    p_ev_loss_bb: Math.max(0, Math.min(1000, Math.round(evLossBb * 1000) / 1000)),
  });
  return {
    reps: num(payload?.reps),
    lapses: num(payload?.lapses),
    ease: num(payload?.ease),
    intervalDays: num(payload?.intervalDays),
    dueAt: String(payload?.dueAt ?? ""),
    relearn: payload?.relearn === true,
  };
}

export interface DrillSummary {
  items: number;
  due: number;
  dueToday: number;
  learning: number;
  mature: number;
  reviewed: number;
  /** Graded Mistakes or worse with no drill yet: what the next sync adds. */
  candidates: number;
}

export async function fetchDrillSummary(): Promise<DrillSummary | null> {
  if (!(await currentUserId())) return null;
  const payload = await rpc<Row | null>("drill_summary", { p_version: ANALYSIS_VERSION, p_until: endOfToday() });
  if (!payload) return null;
  return {
    items: num(payload.items),
    due: num(payload.due),
    dueToday: num(payload.dueToday),
    learning: num(payload.learning),
    mature: num(payload.mature),
    reviewed: num(payload.reviewed),
    candidates: num(payload.candidates),
  };
}

/** Per finest leak spot: drills and drills due today (undrilled Mistakes count as due). */
export async function fetchDrillsBySpot(): Promise<Map<string, { items: number; due: number }>> {
  const out = new Map<string, { items: number; due: number }>();
  if (!(await currentUserId())) return out;
  const payload = await rpc<unknown>("drill_due_by_spot", { p_version: ANALYSIS_VERSION, p_until: endOfToday() });
  for (const row of rows(payload)) out.set(String(row.key ?? ""), { items: num(row.items), due: num(row.due) });
  return out;
}

/* -------------------------------------------------------------- trainer - */

export interface TrainerResultInput {
  mode: "preflop" | "river" | "drill";
  family: string;
  spot: string;
  position: string | null;
  handClass: string | null;
  grade: Grade;
  evLossBb: number;
  evLossPot: number;
  score: number;
}

export async function recordTrainerResults(results: TrainerResultInput[]): Promise<number> {
  if (results.length === 0 || !(await currentUserId())) return 0;
  const payload = await rpc<Row | null>("record_trainer_results", {
    p_rows: results.slice(0, 50).map((r) => ({
      mode: r.mode,
      family: r.family,
      spot: r.spot.slice(0, 200),
      position: r.position,
      hand_class: r.handClass,
      grade: r.grade,
      ev_loss_bb: Math.max(0, Math.min(1000, r.evLossBb)),
      ev_loss_pot: Number.isFinite(r.evLossPot) ? Math.max(0, Math.min(100, r.evLossPot)) : 1,
      score: Math.max(0, Math.min(100, r.score)),
    })),
  });
  return num(payload?.inserted);
}

export interface TrainerModeSummary {
  mode: string;
  answers: number;
  recent: number;
  counts: Record<Grade, number>;
  evLossBb: number;
  scoreSum: number;
  last: string | null;
}

export async function fetchTrainerSummary(days = 30): Promise<TrainerModeSummary[]> {
  if (!(await currentUserId())) return [];
  const payload = await rpc<Row | null>("trainer_summary", { p_days: days });
  return rows(payload?.modes).map((row) => ({
    mode: String(row.mode ?? ""),
    answers: num(row.answers),
    recent: num(row.recent),
    counts: {
      perfect: num(row.perfect),
      good: num(row.good),
      inaccurate: num(row.inaccurate),
      mistake: num(row.mistake),
      blunder: num(row.blunder),
    },
    evLossBb: num(row.evLossBb),
    scoreSum: num(row.scoreSum),
    last: str(row.last),
  }));
}
