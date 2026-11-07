/**
 * The database side of training (phase A7, `20270208090000_analysis_training.sql`).
 *
 * Drills are the player's own Mistakes, scheduled by SM-2 in the database
 * (`review_drill` runs `drill_next`); trainer answers are kept for the long
 * view. The browser grades (`lib/training`), the database stores and counts.
 * Every call names the `analysis_version` it reads, like every analysis report.
 */

import type { GameKind } from "@rail/ui/hands/gameKind";
import { ANALYSIS_VERSION } from "../analysis";
import type { HandsPot, HandsTable, SpotDrills } from "../analysis/leaks";
import type { Grade } from "../analysis/types";
import { currentUserId, isMissingSchemaError, rpc } from "./client";

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
  /**
   * Only the drills on this table (`handsTable`: a leak's or area's tag,
   * `"other"` for 6-max and no set; `drill_queue_on_table`,
   * `20271104120000_drills_by_table.sql`). Absent or null: every table. An
   * older database without the function deals every table's, as before.
   */
  table?: HandsTable | null;
  /**
   * With a table, only the drills in this pot too (`handsPot`: a postflop
   * area's pot tag, `"other"` for single-raised, limped and unknown pots;
   * `drill_queue_on_area`, `20271105090000_leak_pot_type.sql`). Absent or
   * null: every pot. An older database without the function deals the
   * table's, then every drill, as before.
   */
  pot?: HandsPot | null;
  /** Only drills due now (default), or every drill in due order. */
  dueOnly?: boolean;
  limit?: number;
  /** One kind of game's drills (cash, or every tournament format); every drill when absent. */
  kind?: GameKind | null;
}

const DRILL_TABLES: readonly HandsTable[] = ["hu", "9max", "other"];
const DRILL_POTS: readonly HandsPot[] = ["3bp", "4bp", "other"];

export async function fetchDrillQueue(query: DrillQuery = {}): Promise<DrillItem[]> {
  if (!(await currentUserId())) return [];
  const args = {
    p_version: ANALYSIS_VERSION,
    p_keys: query.keys && query.keys.length > 0 ? query.keys.slice(0, 500) : undefined,
    p_due_only: query.dueOnly ?? true,
    p_limit: query.limit ?? 20,
    p_kind: query.kind ?? undefined,
  };
  let payload: unknown;
  const onTable = async () => {
    try {
      return await rpc<unknown>("drill_queue_on_table", { ...args, p_table: query.table });
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      return await rpc<unknown>("drill_queue", args);
    }
  };
  if (query.table && DRILL_TABLES.includes(query.table) && query.pot && DRILL_POTS.includes(query.pot)) {
    try {
      payload = await rpc<unknown>("drill_queue_on_area", { ...args, p_table: query.table, p_pot: query.pot });
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      payload = await onTable();
    }
  } else if (query.table && DRILL_TABLES.includes(query.table)) {
    payload = await onTable();
  } else {
    payload = await rpc<unknown>("drill_queue", args);
  }
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

/** The drills' counts: one kind of game's when `kind` is given (never both kinds' together on a screen). */
export async function fetchDrillSummary(kind?: GameKind | null): Promise<DrillSummary | null> {
  if (!(await currentUserId())) return null;
  const payload = await rpc<Row | null>("drill_summary", {
    p_version: ANALYSIS_VERSION,
    p_until: endOfToday(),
    p_kind: kind ?? undefined,
  });
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

/** `drill_due_by_spot`'s rows as a map; a row's `tables` only when the database sent them. */
export function drillsBySpotFromPayload(payload: unknown): Map<string, SpotDrills> {
  const out = new Map<string, SpotDrills>();
  for (const row of rows(payload)) {
    const spot: SpotDrills = { items: num(row.items), due: num(row.due) };
    const tables = row.tables;
    if (tables && typeof tables === "object" && !Array.isArray(tables)) {
      const split: NonNullable<SpotDrills["tables"]> = {};
      for (const table of DRILL_TABLES) {
        const part = (tables as Row)[table];
        if (part && typeof part === "object") split[table] = { items: num((part as Row).items), due: num((part as Row).due) };
      }
      spot.tables = split;
    }
    const pots = row.pots;
    if (pots && typeof pots === "object" && !Array.isArray(pots)) {
      const split: NonNullable<SpotDrills["pots"]> = {};
      for (const table of DRILL_TABLES) {
        const cell = (pots as Row)[table];
        if (!cell || typeof cell !== "object") continue;
        const byPot: Partial<Record<HandsPot, { items: number; due: number }>> = {};
        for (const pot of DRILL_POTS) {
          const part = (cell as Row)[pot];
          if (part && typeof part === "object") byPot[pot] = { items: num((part as Row).items), due: num((part as Row).due) };
        }
        split[table] = byPot;
      }
      spot.pots = split;
    }
    out.set(String(row.key ?? ""), spot);
  }
  return out;
}

/**
 * Per finest leak spot, optionally of one game kind: drills and drills due
 * today (undrilled Mistakes count as due), and the same per table (`drill_due_by_spot_tables`,
 * `20271104120000_drills_by_table.sql`; `drillsOn` sums a leak's on its
 * table), and per table and pot (`drill_due_by_spot_pots`,
 * `20271105090000_leak_pot_type.sql`). An older database answers the
 * per-table reader's, or `drill_due_by_spot`'s with no split.
 */
export async function fetchDrillsBySpot(kind?: GameKind | null): Promise<Map<string, SpotDrills>> {
  if (!(await currentUserId())) return new Map();
  const args = { p_version: ANALYSIS_VERSION, p_until: endOfToday(), p_kind: kind ?? undefined };
  let payload: unknown;
  try {
    payload = await rpc<unknown>("drill_due_by_spot_pots", args);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    try {
      payload = await rpc<unknown>("drill_due_by_spot_tables", args);
    } catch (inner) {
      if (!isMissingSchemaError(inner)) throw inner;
      payload = await rpc<unknown>("drill_due_by_spot", args);
    }
  }
  return drillsBySpotFromPayload(payload);
}

/* -------------------------------------------------------------- trainer - */

export interface TrainerResultInput {
  mode: "preflop" | "flop" | "river" | "drill";
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
