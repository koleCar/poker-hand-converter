/**
 * The analysis rows as the app stores them (docs/RAIL-PLAN.md R5.4): the
 * web's writer shape (`handAnalysisRow`, the library's own) with what the
 * web's database does to it on the way in, done here instead, so a row the
 * app stores reads back exactly as the web's does.
 *
 * - **The PHF the analysis reads** ({@link trimPhf}): the web's
 *   `hands_needing_analysis_recent` hands the worker the stored PHF without
 *   `meta.rawText` and without each action's `rawLine` and `label`; the app
 *   reads the same.
 * - **Numbers** ({@link roundNumeric}): the web's columns are `numeric(p,
 *   s)` (`20261228090000_analysis.sql`), which round the JSON number the
 *   client sent - its shortest decimal spelling - half away from zero at `s`
 *   places. The JSON columns (`options`, `flags`, `facts`) keep their
 *   numbers as sent, as `jsonb` does.
 * - **The leak finder's columns** ({@link leakColumns}): what the web's
 *   `analysis_leak_spot_key`, `analysis_leak_chart_set` and
 *   `analysis_best_action` compute from a stored decision (R5.2), computed
 *   when the row is written;
 * - **the own charts' fields** ({@link preflopFields}): what the web's
 *   `preflop_decision_fields` files a preflop chart decision by (R5.3b),
 *   with the same `nodeKey.ts` the web's SQL twin is held to.
 *
 * Pure: the runner, the parity test and the unit tests import it.
 */
import { classIndex } from "@rail/ui/charts/model";
import { shippedNodeKey } from "@rail/ui/charts/nodeKey";

import type { DecisionAnalysisInsert, HandAnalysisInsert, PhfHand } from "./library";

/** A hand as the analysis reads it: the stored PHF less what the web's reader leaves out. */
export function trimPhf(phf: PhfHand): PhfHand {
  const meta: Record<string, unknown> = { ...phf.meta };
  delete meta.rawText;
  const actions = (phf.actions ?? []).map((action) => {
    const copy: Record<string, unknown> = { ...action };
    delete copy.rawLine;
    delete copy.label;
    return copy;
  });
  return { ...phf, meta, actions } as unknown as PhfHand;
}

/**
 * `value` as a `numeric(p, scale)` column stores it: its shortest decimal
 * spelling rounded half away from zero at `scale` places. Null stays null.
 */
export function roundNumeric(value: number | null, scale: number): number | null {
  if (value === null || !Number.isFinite(value)) return value;
  const negative = value < 0;
  // The shortest spelling, written out without an exponent.
  const [mantissa, exponentText] = Math.abs(value).toString().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = (mantissa ?? "0").split(".");
  let digits = `${whole ?? "0"}${fraction}`;
  let point = (whole ?? "0").length + exponent;
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) {
    digits = digits + "0".repeat(point - digits.length);
  }
  const keep = point + scale;
  // No more places than the column keeps: stored as it is.
  if (digits.length <= keep) return value;
  const roundUp = digits.charCodeAt(keep) - 48 >= 5;
  let kept = digits
    .slice(0, keep)
    .split("")
    .map((d) => d.charCodeAt(0) - 48);
  if (roundUp) {
    let i = kept.length - 1;
    while (i >= 0) {
      if (kept[i] < 9) {
        kept[i] = kept[i] + 1;
        break;
      }
      kept[i] = 0;
      i -= 1;
    }
    if (i < 0) {
      kept = [1, ...kept];
      point += 1;
    }
  }
  const out = Number(spell(kept.join(""), point));
  return negative && out !== 0 ? -out : out;
}

function spell(digits: string, point: number): string {
  const whole = digits.slice(0, point) || "0";
  const fraction = digits.slice(point);
  return fraction ? `${whole}.${fraction}` : whole;
}

const ACTIONS = new Set(["fold", "check", "call", "bet", "raise"]);

/**
 * The action of a graded decision's highest-EV option (ties: the higher
 * frequency, then the first listed); null without options
 * (`analysis_best_action`).
 */
export function bestAction(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  let best: { action: string; ev: number | null; freq: number | null; index: number } | null = null;
  options.forEach((option: unknown, index) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return;
    const o = option as Record<string, unknown>;
    if (typeof o.action !== "string" || !ACTIONS.has(o.action)) return;
    const ev = typeof o.ev === "number" ? o.ev : null;
    const freq = typeof o.freq === "number" ? o.freq : null;
    const candidate = { action: o.action, ev, freq, index };
    if (best === null || before(candidate, best)) best = candidate;
  });
  return (best as { action: string } | null)?.action ?? null;
}

/** `order by ev desc nulls last, freq desc nulls last, index`: whether `a` sorts before `b`. */
function before(
  a: { ev: number | null; freq: number | null; index: number },
  b: { ev: number | null; freq: number | null; index: number },
): boolean {
  const byDesc = (x: number | null, y: number | null): number => {
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x > y ? -1 : x < y ? 1 : 0;
  };
  const ev = byDesc(a.ev, b.ev);
  if (ev !== 0) return ev < 0;
  const freq = byDesc(a.freq, b.freq);
  if (freq !== 0) return freq < 0;
  return a.index < b.index;
}

/** The leak finder's three columns of a stored decision. */
export interface LeakColumns {
  /** `street|scenario|line|seat|taken|best`. */
  spot_key: string;
  /** The chart set a chart grade came from; '' otherwise. */
  chart_set: string;
  /** The reference's best action; '' without options. */
  best: string;
}

const LINE = /^[fkcra]{0,24}$/;
const SEAT = /^[A-Z0-9+]{0,8}$/;
const SET = /^[a-z0-9-]{1,40}$/;

function textAt(value: unknown, ...path: string[]): string | null {
  let at: unknown = value;
  for (const key of path) {
    if (!at || typeof at !== "object" || Array.isArray(at)) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === "string" ? at : typeof at === "number" ? String(at) : null;
}

/**
 * `analysis_leak_spot_key` and `analysis_leak_chart_set` (R5.2): the line is
 * a chart grade's `facts.chart.line` when it has the shape of one, the seat
 * `facts.position` else the hand's hero position, the best action the
 * highest-EV option's.
 */
export function leakColumns(decision: DecisionAnalysisInsert, heroPosition: string | null): LeakColumns {
  const facts = decision.facts as unknown;
  const chartLine = textAt(facts, "chart", "line") ?? "";
  const line = decision.source === "chart" && LINE.test(chartLine) ? chartLine : "";
  const seat = textAt(facts, "position") ?? heroPosition ?? "";
  const position = SEAT.test(seat) ? seat : "";
  const best = bestAction(decision.options) ?? "";
  const set = textAt(facts, "chart", "set") ?? "";
  return {
    spot_key: [decision.street, decision.scenario, line, position, decision.action, best].join("|"),
    chart_set: decision.source === "chart" && SET.test(set) ? set : "",
    best,
  };
}

/** A preflop decision as the own charts compare it (R5.3b; `rail_store::PreflopFields`). */
export interface PreflopFields {
  chart_key: string;
  chart_table: number;
  hand_class: number;
  chart_action: "fold" | "check" | "call" | "raise" | "allin";
  depth_band: number;
}

const DECISION_ACTIONS = new Set(["fold", "check", "call", "raise", "bet"]);

/** A shipped set's table (`preflop_chart_set_table`): plain cash sets only. */
function setTable(set: string | null): number | null {
  if (set === null) return null;
  if (/^nlhe-cash-6max-[0-9]{1,3}bb$/.test(set)) return 6;
  if (/^nlhe-cash-9max-[0-9]{1,3}bb$/.test(set)) return 9;
  if (/^nlhe-cash-hu-[0-9]{1,3}bb$/.test(set)) return 2;
  return null;
}

/**
 * `preflop_decision_fields` (R5.3b, `20270811100000_preflop_charts_compare.sql`):
 * a preflop decision graded on the shipped tree, filed by its situation key,
 * the set's table, its class, the action as a chart names it and the
 * effective stack in 10 bb steps; null for any other decision.
 */
export function preflopFields(decision: DecisionAnalysisInsert): PreflopFields | null {
  if (decision.street !== "preflop" || decision.source !== "chart" || !DECISION_ACTIONS.has(decision.action)) return null;
  const facts = decision.facts as unknown as Record<string, unknown>;
  const set = textAt(facts, "chart", "set");
  const table = setTable(set);
  const line = textAt(facts, "chart", "line") ?? "";
  const handClass = textAt(facts, "handClass");
  const cls = handClass === null ? -1 : classIndex(handClass);
  if (table === null || !LINE.test(line) || cls < 0) return null;
  const allIn = facts.allIn === true;
  const action =
    (decision.action === "raise" || decision.action === "bet") && allIn ? "allin" : decision.action === "bet" ? "raise" : decision.action;
  const stack = facts.effStackBb;
  const depth = typeof stack === "number" ? Math.min(990, Math.max(0, Math.floor(stack / 10) * 10)) : -1;
  return {
    chart_key: (set && shippedNodeKey(set, line)) ?? "",
    chart_table: table,
    hand_class: cls,
    chart_action: action as PreflopFields["chart_action"],
    depth_band: depth,
  };
}

/** One decision as the app's store takes it. */
export interface StoreDecisionRow extends Omit<DecisionAnalysisInsert, "score" | "ev_loss_bb" | "ev_loss_pot" | "freq_diff" | "pot_bb" | "pot_odds" | "mdf">, LeakColumns {
  score: number | null;
  ev_loss_bb: number | null;
  ev_loss_pot: number | null;
  freq_diff: number | null;
  pot_bb: number | null;
  pot_odds: number | null;
  mdf: number | null;
  preflop: PreflopFields | null;
}

/** One hand as the app's store takes it (`rail_store::HandAnalysisIn`). */
export interface StoreHandRow extends Omit<HandAnalysisInsert, "hand_id" | "decisions"> {
  hand_key: string;
  /** The flop library was at hand (A5b); false: analysed again once it is. */
  flop_library: boolean;
  /** The hero's seat (the web's `hands.hero_position`): the top three's seat filter. */
  hero_position: string | null;
  decisions: StoreDecisionRow[];
}

/** The hand's hero position, as the web's `hands.hero_position` holds it. */
export function heroPositionOf(phf: PhfHand): string | null {
  const hero = (phf.players ?? []).find((player) => player.isHero);
  return hero?.position ?? null;
}

/** A writer row (`handAnalysisRow`'s) as the app's store takes it: numbers as the web's columns hold them, the leak columns. */
export function storeRow(row: HandAnalysisInsert, handKey: string, heroPosition: string | null, flopLibrary: boolean): StoreHandRow {
  const hand: Omit<HandAnalysisInsert, "hand_id"> & { hand_id?: string } = { ...row };
  delete hand.hand_id;
  const decisions = row.decisions;
  return {
    ...hand,
    hand_key: handKey,
    score: roundNumeric(hand.score, 2),
    ev_loss_bb: roundNumeric(hand.ev_loss_bb, 3),
    ev_loss_pot: roundNumeric(hand.ev_loss_pot, 4),
    flop_library: flopLibrary,
    hero_position: heroPosition,
    decisions: decisions.map((d) => ({
      ...d,
      score: roundNumeric(d.score, 2),
      ev_loss_bb: roundNumeric(d.ev_loss_bb, 3),
      ev_loss_pot: roundNumeric(d.ev_loss_pot, 4),
      freq_diff: roundNumeric(d.freq_diff, 4),
      pot_bb: roundNumeric(d.pot_bb, 2),
      pot_odds: roundNumeric(d.pot_odds, 3),
      mdf: roundNumeric(d.mdf, 3),
      ...leakColumns(d, heroPosition),
      preflop: preflopFields(d),
    })),
  };
}
