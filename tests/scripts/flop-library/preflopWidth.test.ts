/**
 * Opponents' preflop chart ranges, scored unselected (§10, 2026-10-20). The
 * first open item of `analysis/30` (`checkedRanges.test.ts`): mixing any two
 * cards into opponents' chart ranges gains about half a nat per checked river
 * on the unselected score. Which chart ranges are too strong, and what is the
 * least-parameter fix?
 *
 * Part 0, frequencies (no showdown at all): how often opponents open, iso-
 * raise and 3-bet where they could, against how much of the hands the chart
 * range they are walked from holds (its combos / 1326, or / the range that
 * reached the decision).
 *
 * Part 1, the unselected score at every river showdown (one board, one pot,
 * nobody all-in): the river checked through (the first to act shows first,
 * `analysis/30`'s spots) and a river bet called (the last bettor shows
 * first). The first to show is scored by their combo in their own walked
 * range; each later player by their combo when shown, else by the range's
 * chance of losing to the best hand shown before them. Per preflop label: the
 * first to show's place in their preflop range by river value (PIT, 0.5
 * calibrated) and the later players' mucks, observed − predicted.
 *
 * Part 2, candidates (a study-local change of an opponent's chart range, the
 * mocked `preflopRangeOf`; `Cand`): any two cards mixed in (`any`), the
 * population shape of `population/1` added under a union (`shape`), the
 * same width with part of it in the population's order (`mix`, what
 * `analysis/31` ships as `populationOrdered`) or uniform (`flat`), per line
 * group, table size and order; `shipped` reads the shipped code as it is.
 * Every other candidate starts from `analysis/30`'s ranges
 * (`populationOrder: false`). Chosen held out, five folds by hand and five
 * by the first to show's name, on the unselected log-likelihood; a fidelity
 * line compares the shipped code with the study's `mix 0.75 popnp +ph`.
 *
 * Part 3 (`PW_GUARD=1`, or a candidate's name): the earlier studies'
 * shown-hand rows (`analysis/22`, `/23`, `/28`, the 2026-10-14 river trim),
 * candidate − `analysis/30` per combo, clustered by player.
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl [PW_CANDS='[...]' or a JSON file path] [PW_GUARD=1] \
 *       [PW_FREQ=0] [PW_DIAG=0] [PW_SHARE=0] [PW_DIAG_BEST=<name>] npm run floplib:preflop-width
 *
 * Without `PW_CANDS` it runs the any-two and union grids; §10 2026-10-20
 * lists the grids run (any, union, mix, flat by level, per line, per table,
 * the orders, the widths, with and without placeholders).
 *
 * Raising lines and the small blind's open (§10 2026-10-20, the second
 * entry, on top of `analysis/31`): a `mix` candidate may give a line group
 * its own order (`tauBy` temperature, `termBy` one extra feature term,
 * `kBy` width) and widen the small blind's open to a share of all hands
 * (`sbWidth`, per table class). `PW_REF=<name>` scores every gain, the held
 * out choice and the guard against that candidate instead of `analysis/30`
 * (the study's `analysis/31` is `mix 0.75 popnp +ph` of every group);
 * `PW_PICK=<regex>` limits what a fold may choose.
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it, vi } from "vitest";

// Study only: a candidate changes an opponent's chart or placeholder range (`hook`).
vi.mock("../../../frontend/src/lib/analysis/rangeWalk.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../frontend/src/lib/analysis/rangeWalk.js")>();
  return {
    ...original,
    preflopRangeOf: (...args: Parameters<typeof original.preflopRangeOf>) => {
      const h = (globalThis as { __pwHook?: { shipped: boolean; widen: ((r: Float64Array, label: string, tableSize: number, source: string, approx: readonly string[]) => Float64Array | null) | null } }).__pwHook;
      // The shipped `analysis/31` ranges as they are; anything else starts from `analysis/30`'s (no population order).
      if (h?.shipped) return original.preflopRangeOf(...args);
      const [hand, context, seat, before, charts, options] = args;
      const found = original.preflopRangeOf(hand, context, seat, before, charts, options ? { ...options, populationOrder: false } : options);
      if (!found || !h?.widen) return found;
      if (options?.populationHero === undefined || seat === options.populationHero) return found;
      if (found.label.startsWith("unknown")) return found;
      const out = h.widen(found.range, found.label, context.dealtInSeats.length, found.source, found.approx);
      return out ? { ...found, range: out } : found;
    },
  };
});

import { allClasses } from "../../../frontend/src/lib/equity/range.js";
import {
  comboRange,
  flopSeats,
  handStrength,
  heroSeatOf,
  heuristicModel,
  preflopRangeOf,
  removeCards,
  streetStrength,
  walkMultiway,
  weightedCombos,
  type NarrowingModel,
  type NarrowInput,
  type StreetStrength,
} from "../../../frontend/src/lib/analysis/index.js";
import { toIndices } from "../../../frontend/src/lib/analysis/texture.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import { equityVsRanges } from "../../../frontend/src/lib/equity/multiway.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../frontend/src/lib/solver/index.js";
import { buildContext, type StatsContext } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const FOLDS = 5;
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const foldOfHand = (hand: number) => (hand * 2654435761) % FOLDS;
const foldOfName = (name: string) => createHash("sha256").update(name).digest()[0] % FOLDS;
const f3 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

function clustered<T>(rows: readonly T[], key: (r: T) => string | number, x: (r: T) => number) {
  const n = rows.length;
  if (n === 0) return { mean: NaN, se: NaN, n: 0 };
  const mean = rows.reduce((s, r) => s + x(r), 0) / n;
  const by = new Map<string | number, number>();
  for (const r of rows) by.set(key(r), (by.get(key(r)) ?? 0) + (x(r) - mean));
  const g = by.size;
  let v = 0;
  for (const s of by.values()) v += s * s;
  return { mean, se: g > 1 ? Math.sqrt((g / (g - 1)) * v) / n : NaN, n };
}
const fmt = (c: { mean: number; se: number }) => `${f3(c.mean)} ± ${c.se.toFixed(3)}`;

/* ------------------------------------------------------------- the shapes - */

const RANKS = "23456789TJQKA";
/** `population/1`'s class features and shared shape (restated from `population.ts`). */
function features(name: string): number[] {
  const hi = RANKS.indexOf(name[0]);
  const lo = RANKS.indexOf(name[1]);
  const pair = name.length === 2 ? 1 : 0;
  const suited = name.endsWith("s") ? 1 : 0;
  const gap = pair ? 0 : Math.min(hi - lo - 1, 4) / 4;
  return [1, pair, suited, hi / 12, lo / 12, gap, hi === 12 && !pair ? 1 : 0, lo >= 8 ? 1 : 0, (pair * lo) / 12];
}
const SHAPE = [-0.443, 1.609, 1.578, 1.046, 1.105, -1.779, 2.221, 0.18, -3.071];
/** The shape's logit per combo (before any line's shift). */
const SHAPE_Z = perCombo((name) => features(name).reduce((s, x, j) => s + x * SHAPE[j], 0));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
/** A class-level score spread to combos. */
function perCombo(score: (name: string) => number): Float64Array {
  const m = new Map<string, number>();
  for (const name of allClasses()) m.set(name, (score(name) + 50) / 100);
  return Float64Array.from(comboRange(m), (x) => x * 100 - 50);
}
/** `population/1`'s shape without the pair × low-rank term (pairs in rank order). */
const SHAPE_NP_Z = perCombo((name) => features(name).reduce((s, x, j) => s + (j === 8 ? 0 : x * SHAPE[j]), 0));
/** All-in equity against any two cards (Monte Carlo), filled on first use. */
let EQ_Z: Float64Array | null = null;
function eqZ(): Float64Array {
  if (EQ_Z) return EQ_Z;
  const any = new Map(allClasses().map((n) => [n, 1]));
  EQ_Z = perCombo((name) => {
    const hero = name.length === 2 ? [`${name[0]}s`, `${name[1]}h`] : name.endsWith("s") ? [`${name[0]}s`, `${name[1]}s`] : [`${name[0]}s`, `${name[1]}h`];
    return equityVsRanges({ hero, ranges: [any], board: [], seed: 5, trials: 20000 }).equity;
  });
  return EQ_Z;
}
type Order = "pop" | "popnp" | "eq";
/** `features` by name, for a raise-fitted extra term (§10 2026-10-20, raising lines). */
const FEATURE_INDEX: Record<string, number> = { pair: 1, suited: 2, hi: 3, lo: 4, gap: 5, ace: 6, broadway: 7 };
const twistCache = new Map<string, Float64Array>();
/**
 * `popnp`'s logits at temperature `tau` plus `coef` × one feature (a raising
 * line's own order): z' = tau · z + coef · x[feature].
 */
function twistedZ(tau: number, feature: string | undefined, coef: number): Float64Array {
  const key = `${tau}|${feature}|${coef}`;
  const hit = twistCache.get(key);
  if (hit) return hit;
  const j = feature ? FEATURE_INDEX[feature] : -1;
  const z = perCombo((name) => {
    const x = features(name);
    return tau * x.reduce((s, v, i) => s + (i === 8 ? 0 : v * SHAPE[i]), 0) + (j >= 0 ? coef * x[j] : 0);
  });
  twistCache.set(key, z);
  return z;
}
/** A logistic order shifted to `width` combos (bisection). */
function zAtWidth(Z: Float64Array, width: number): Float64Array {
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    let s = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) s += sigmoid(Z[c] + mid);
    if (s > width) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  return Float64Array.from(Z, (z) => sigmoid(z + a));
}
/** A range of `width` combos in an order: `pop`/`popnp` the logistic shape shifted (bisection), `eq` the top of the equity order. */
function shapeAtWidth(width: number, order: Order = "pop"): Float64Array {
  if (order === "eq") {
    const z = eqZ();
    const idx = [...z.keys()].sort((a, b) => z[b] - z[a]);
    const out = new Float64Array(NUM_COMBOS);
    let left = width;
    for (const c of idx) {
      if (left <= 0) break;
      out[c] = Math.min(1, left);
      left -= out[c];
    }
    return out;
  }
  const Z = order === "pop" ? SHAPE_Z : SHAPE_NP_Z;
  let lo = -30;
  let hi = 30;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    let s = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) s += sigmoid(Z[c] + mid);
    if (s > width) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  return Float64Array.from(Z, (z) => sigmoid(z + a));
}

/* ------------------------------------------------------------- candidates - */

/** Line groups a widening is set per. */
const GROUPS = ["open", "iso", "3bet", "4bet", "call-3bet", "check", "limp", "call", "other"] as const;
type Group = (typeof GROUPS)[number];
const groupOf = (line: string): Group => {
  if (line === "open" || line === "iso" || line === "3bet" || line === "4bet" || line === "check" || line === "limp" || line === "call") return line;
  if (line === "call-3bet" || line === "call-4bet") return "call-3bet";
  return "other";
};

interface Cand {
  name: string;
  /**
   * `any`: (1 − m) w + m; `shape`: 1 − (1 − w)(1 − σ(shape + a)); `mix`: (1 − m) w + m σ(shape + a*),
   * a* putting the shape at the range's own width (same combos, the population's order);
   * `flat`: (1 − m) w + m · width (same combos, uniform).
   */
  kind: "none" | "any" | "shape" | "mix" | "flat" | "shipped";
  /** Per group: m (any) or a (shape); a group missing is not widened. */
  by: Partial<Record<Group, number>>;
  /** `mix`: the order mixed toward (default `pop`). */
  order?: Order;
  /** `mix`: the order's part at this multiple of the range's width (default 1). */
  k?: number;
  /** Also widen placeholder ranges (not the population's). */
  placeholders?: boolean;
  /** Only tables of this size class ("hu" 2, "6" 3-6, "9" 7+). */
  tables?: string[];
  /**
   * `mix` (popnp), per group: the order's temperature (z → tau · z), an
   * extra feature term (`term`, `coef`) and the order part's width multiple
   * (`kBy`, overrides `k`) - a raising line's own order (§10 2026-10-20,
   * raising lines). A group missing keeps the shared order.
   */
  tauBy?: Partial<Record<Group, number>>;
  termBy?: Partial<Record<Group, { feature: string; coef: number }>>;
  kBy?: Partial<Record<Group, number>>;
  /**
   * `mix`: the small blind's open (`open:SB`, not heads-up) widened to this
   * share of all 1,326 combos, the added width in the order (`sbM` the
   * order's part of it, default the group's m); `sbTables` limits the table
   * classes (default 6 and 9).
   */
  sbWidth?: number | Record<string, number>;
  sbM?: number;
  sbTables?: string[];
}
const BASE: Cand = { name: "analysis/30", kind: "none", by: {} };
const tableClass = (n: number) => (n <= 2 ? "hu" : n <= 6 ? "6" : "9");

function widener(cand: Cand) {
  if (cand.kind === "none" || cand.kind === "shipped") return null;
  return (range: Float64Array, label: string, tableSize: number, source: string, approx: readonly string[]) => {
    if (source !== "chart" && !(cand.placeholders && !approx.includes("range-population"))) return null;
    if (cand.tables && !cand.tables.includes(tableClass(tableSize))) return null;
    const group = groupOf(label.split(":")[0]);
    let p = cand.by[group];
    if (p === undefined) return null;
    if (cand.kind === "any") return Float64Array.from(range, (w) => (1 - (p as number)) * w + (p as number));
    if (cand.kind === "mix" || cand.kind === "flat") {
      const width = range.reduce((s, w) => s + w, 0);
      if (cand.kind === "flat") return Float64Array.from(range, (w) => (1 - p) * w + (p * width) / NUM_COMBOS);
      const tau = cand.tauBy?.[group];
      const term = cand.termBy?.[group];
      const kg = cand.kBy?.[group];
      const sbShare = typeof cand.sbWidth === "number" ? cand.sbWidth : cand.sbWidth?.[tableClass(tableSize)];
      const sb = sbShare !== undefined && label === "open:SB" && (cand.sbTables ?? ["6", "9"]).includes(tableClass(tableSize));
      if (tau !== undefined || term !== undefined || kg !== undefined || sb) {
        const Z = twistedZ(tau ?? 1, term?.feature, term?.coef ?? 0);
        let target = width * (kg ?? cand.k ?? 1);
        if (sb) {
          p = cand.sbM ?? p;
          target = (NUM_COMBOS * (sbShare as number) - (1 - p) * width) / p;
        }
        const shape = zAtWidth(Z, Math.max(1, Math.min(NUM_COMBOS * 0.98, target)));
        return Float64Array.from(range, (w, c) => (1 - (p as number)) * w + (p as number) * shape[c]);
      }
      const shape = shapeAtWidth((cand.k ?? 1) === 1 ? width : Math.min(NUM_COMBOS * 0.98, width * (cand.k ?? 1)), cand.order);
      return Float64Array.from(range, (w, c) => (1 - (p as number)) * w + (p as number) * shape[c]);
    }
    return Float64Array.from(range, (w, c) => 1 - (1 - w) * (1 - sigmoid(SHAPE_Z[c] + (p as number))));
  };
}

const hook: { shipped: boolean; widen: ReturnType<typeof widener> } = { shipped: false, widen: null };
(globalThis as { __pwHook?: typeof hook }).__pwHook = hook;

/** Records each action's narrowed range (after it), by `actionIndex`. */
function recording(model: NarrowingModel) {
  const after = new Map<number, Float64Array>();
  const wrapped: NarrowingModel = {
    id: model.id,
    likelihood(input: NarrowInput) {
      const l = model.likelihood(input);
      if (input.actionIndex !== undefined) {
        const o = new Float64Array(NUM_COMBOS);
        for (let c = 0; c < NUM_COMBOS; c += 1) if (input.actor[c] > 0) o[c] = input.actor[c] * Math.min(1, Math.max(0, l[c] || 0));
        after.set(input.actionIndex, o);
      }
      return l;
    },
  };
  return { after, model: wrapped };
}

/* -------------------------------------------------------------------- data - */

interface Spot {
  h: number;
  hand: PhfHand;
  walker: number;
  actual: number | null;
  multiway: boolean;
  checked: boolean;
  /** Showdown seats in showing order. */
  order: number[];
  last: Map<number, number>;
  combo: Map<number, number>;
  cards: Map<number, string[]>;
  boardCodes: string[];
  strength: StreetStrength;
  firstShare: number;
  firstName: string;
}

interface Result {
  share: number;
  firstLL: number;
  pitPre: number;
  firstLabel: string;
  cens: { ll: number; p: number; y: number; seat: number; label: string }[];
}

function pitOf(range: Float64Array, value: Int32Array, combo: number): number {
  const v0 = value[combo];
  let below = 0;
  let tied = 0;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = range[c];
    if (!(w > 0) || value[c] < 0) continue;
    total += w;
    if (value[c] < v0) below += w;
    else if (value[c] === v0) tied += w;
  }
  return total > 0 ? (below + tied / 2) / total : NaN;
}

function llOf(range: Float64Array | undefined, combo: number): number {
  if (!range) return FLOOR_LL;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

function walk(hand: PhfHand, walker: number, actual: number | null, charts: ChartSet, cand: Cand) {
  const rec = recording(heuristicModel);
  hook.widen = widener(cand);
  hook.shipped = cand.kind === "shipped";
  try {
    const w = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), walker, charts, rec.model, { populationHero: actual ?? -1 });
    return w.ok ? { w, after: rec.after } : null;
  } catch {
    return null;
  } finally {
    hook.widen = null;
    hook.shipped = false;
  }
}

function evaluate(spot: Spot, charts: ChartSet, cand: Cand, withShare: boolean): Result | null {
  const run = walk(spot.hand, spot.walker, spot.actual, charts, cand);
  if (!run) return null;
  const final = (seat: number) => run.after.get(spot.last.get(seat) as number);
  const first = spot.order[0];
  const own = toIndices(spot.cards.get(first) as string[]);
  const others = spot.order.slice(1).map((s) => final(s));
  if (others.some((r) => !r)) return null;
  let share = NaN;
  if (withShare) {
    const lists = others.map((r) => weightedCombos(removeCards(Float64Array.from(r as Float64Array), own))).filter((l) => l.length > 0);
    if (lists.length === 0) return null;
    if (lists.length === 1) {
      const r = removeCards(Float64Array.from(others[0] as Float64Array), own);
      share = handStrength(spot.strength, r)[spot.combo.get(first) as number];
    } else {
      share = equityVsRanges({ hero: spot.cards.get(first) as string[], ranges: lists, board: spot.boardCodes, seed: 77 + spot.h, trials: 8000 }).equity;
    }
  }
  const fr = final(first) as Float64Array;
  const fc = spot.combo.get(first) as number;
  const value = spot.strength.value;
  const board = toIndices(spot.boardCodes);
  const pre = removeCards(Float64Array.from(run.w.preflop.get(first) as Float64Array), board);
  const res: Result = {
    share,
    firstLL: llOf(fr, fc),
    pitPre: pitOf(pre, value, fc),
    firstLabel: run.w.labels.get(first) ?? "?",
    cens: [],
  };
  let best = value[fc];
  const shownCards = [...own];
  for (const seat of spot.order.slice(1)) {
    const combo = spot.combo.get(seat);
    if (seat === spot.actual) {
      if (combo !== undefined) {
        best = Math.max(best, value[combo]);
        shownCards.push(...toIndices(spot.cards.get(seat) as string[]));
      }
      continue;
    }
    const r = removeCards(Float64Array.from(final(seat) as Float64Array), shownCards);
    let total = 0;
    let lose = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      const w = r[c];
      if (!(w > 0) || value[c] < 0) continue;
      total += w;
      if (value[c] < best) lose += w;
    }
    if (!(total > 0)) continue;
    const p = lose / total;
    const label = run.w.labels.get(seat) ?? "?";
    if (combo !== undefined) {
      res.cens.push({ ll: llOf(r, combo), p, y: 0, seat, label });
      best = Math.max(best, value[combo]);
      shownCards.push(...toIndices(spot.cards.get(seat) as string[]));
    } else {
      res.cens.push({ ll: Math.max(FLOOR_LL, Math.log(Math.max(1e-9, p))), p, y: 1, seat, label });
    }
  }
  return res;
}

/** The unselected log-likelihood of a spot, opponents only (the hero's own range is never widened). */
const llScore = (s: Spot, r: Result) => (s.order[0] === s.actual ? 0 : r.firstLL) + r.cens.reduce((a, c) => a + c.ll, 0);

/* ------------------------------------------------------------------ guard - */

/** The earlier studies' shown-hand rows (as `checkedRanges.test.ts`'s guard), candidate − the reference (`PW_REF`, default `analysis/30`). */
function guard(hands: readonly PhfHand[], charts: ChartSet, cand: Cand, ref: Cand = BASE) {
  interface Row {
    player: string;
    kind: string;
    d: number;
  }
  const rows: Row[] = [];
  for (const hand of hands) {
    if (hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const actual = heroSeatOf(context);
    const shown = seats.filter((s) => s !== actual && (context.players.get(s)?.holeCards?.length ?? 0) === 2);
    if (shown.length === 0) continue;
    const walker = actual !== null && seats.includes(actual) ? actual : seats[0];
    const a = walk(hand, walker, actual, charts, ref);
    const b = walk(hand, walker, actual, charts, cand);
    if (!a || !b) continue;
    const bomb = hand.game.bombPot ? "bomb " : "";
    const way = seats.length >= 3 ? "3+" : "HU";
    for (const seat of shown) {
      const cs = toIndices(context.players.get(seat)?.holeCards as string[]);
      const combo = comboIndex(cs[0], cs[1]);
      const player = `${hand.meta.siteId}/${context.players.get(seat)?.name ?? seat}`;
      const acts = (street: string) => hand.actions.filter((x) => x.street === street && x.seat === seat && DECISIONS.has(x.type));
      if (acts("flop").length > 0 && a.w.starts.turn?.has(seat))
        rows.push({ player, kind: `${bomb}flop ${way}`, d: llOf(b.w.starts.turn?.get(seat), combo) - llOf(a.w.starts.turn?.get(seat), combo) });
      if (acts("turn").length > 0 && a.w.starts.river?.has(seat)) {
        const tw = (a.w.starts.turn?.size ?? 0) >= 3 ? "3+" : "HU";
        rows.push({ player, kind: `${bomb}turn ${tw}`, d: llOf(b.w.starts.river?.get(seat), combo) - llOf(a.w.starts.river?.get(seat), combo) });
      }
      const river = acts("river");
      if (river.length > 0 && river[river.length - 1].type !== "fold") {
        const idx = river[river.length - 1].index;
        const rw = (a.w.starts.river?.size ?? 0) >= 3 ? "3+" : "HU";
        const checker = river.every((x) => x.type === "check") ? " checked only" : "";
        rows.push({ player, kind: `${bomb}river ${rw}${checker}`, d: llOf(b.after.get(idx), combo) - llOf(a.after.get(idx), combo) });
        rows.push({ player, kind: `${bomb}river all`, d: llOf(b.after.get(idx), combo) - llOf(a.after.get(idx), combo) });
      }
    }
  }
  console.log(`--- guard: the shown-hand checks, ${cand.name} − ${ref.name}, per combo (clustered by player)`);
  for (const k of [...new Set(rows.map((r) => r.kind))].sort()) {
    const sub = rows.filter((r) => r.kind === k);
    console.log(`  ${k}: n ${sub.length} | Δ ${fmt(clustered(sub, (r) => r.player, (r) => r.d))}`);
  }
}

/* -------------------------------------------------------------- frequencies - */

function frequencies(hands: readonly PhfHand[], charts: ChartSet) {
  // key → [chances, taken, chart mass sum over taken, taken with a chart range]
  const tab = new Map<string, number[]>();
  const bump = (k: string, took: boolean, mass: number | null) => {
    const v = tab.get(k) ?? [0, 0, 0, 0];
    v[0] += 1;
    if (took) v[1] += 1;
    if (mass !== null) {
      v[2] += mass;
      v[3] += 1;
    }
    tab.set(k, v);
  };
  for (const hand of hands) {
    if (hand.game.variant !== "holdem" || hand.game.limit !== "nl" || hand.game.format !== "cash") continue;
    if (hand.actions.some((a) => a.type === "ante" || a.type === "straddle" || a.type === "bomb-ante")) continue;
    let context: StatsContext;
    try {
      context = buildContext(structuredClone(hand));
    } catch {
      continue;
    }
    const actual = heroSeatOf(context);
    const table = tableClass(context.dealtInSeats.length);
    const pre = context.byStreet.get("preflop") ?? [];
    const seen = new Set<number>();
    for (const d of pre) {
      if (d.seat === actual || seen.has(d.seat)) continue;
      if (!["fold", "call", "raise", "bet", "check"].includes(d.type)) continue;
      seen.add(d.seat);
      if (d.action.allIn) continue;
      const pos = context.position.get(d.seat) ?? "?";
      const took = d.type === "raise" || d.type === "bet";
      let kind: string | null = null;
      if (d.raisesBefore === 0 && d.enteredBefore.length === 0 && pos !== "BB") kind = `open ${table} ${pos}`;
      else if (d.raisesBefore === 0 && d.enteredBefore.length > 0) kind = `iso ${table}`;
      else if (d.raisesBefore === 1) kind = `3bet ${table}`;
      if (!kind) continue;
      let mass: number | null = null;
      if (took) {
        const r = preflopRangeOf(hand, context, d.seat, d.action.index + 1, charts, { populationHero: actual ?? -1 });
        if (r && r.source === "chart") mass = r.range.reduce((s, w) => s + w, 0) / NUM_COMBOS;
      }
      bump(kind, took, mass);
    }
  }
  console.log("--- part 0: opponents' first preflop decision, how often they raise vs the chart range they are walked from (NLHE cash, no ante/straddle)");
  for (const [k, [n, t, m, mc]] of [...tab].sort()) {
    if (n < 30) continue;
    const rate = t / n;
    console.log(`  ${k}: chances ${n} | raised ${t} (${(100 * rate).toFixed(1)}% ± ${(100 * Math.sqrt((rate * (1 - rate)) / n)).toFixed(1)}) | chart range ${mc > 0 ? ((100 * m) / mc).toFixed(1) + "% of hands" : "-"} (n ${mc})`);
  }
}

/* --------------------------------------------------------------------- run - */

function lineGroupOfLabel(label: string) {
  return label.split(":")[0];
}

it("opponents' preflop chart ranges, scored unselected", { timeout: 12 * 60 * 60_000 }, () => {
  if (!FILE || !existsSync(FILE)) {
    console.log("FLOPLIB_HANDS (JSONL of PHF hands) must be set; nothing to do");
    return;
  }
  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PhfHand);
  const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const charts = chartLibrary([single, ...sets.filter((s) => s !== single)]);

  if (process.env.PW_FREQ !== "0") frequencies(hands, charts);

  /* --------------------------------------------------- part 1: the spots - */
  const spots: Spot[] = [];
  for (const [h, hand] of hands.entries()) {
    if (hand.actions.some((a) => a.allIn) || hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    if (hand.results.pots.length > 1) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const river = hand.actions.filter((a) => a.street === "river" && a.seat !== null && DECISIONS.has(a.type));
    if (river.length === 0) continue;
    const folded = new Set(river.filter((a) => a.type === "fold").map((a) => a.seat as number));
    let order: number[] = [];
    for (const a of river) if (!folded.has(a.seat as number) && !order.includes(a.seat as number)) order.push(a.seat as number);
    if (order.length < 2) continue;
    const checked = river.every((a) => a.type === "check");
    if (!checked) {
      const aggr = [...river].reverse().find((a) => a.type === "bet" || a.type === "raise");
      if (!aggr || aggr.seat === null || !order.includes(aggr.seat)) continue;
      const i = order.indexOf(aggr.seat);
      order = [...order.slice(i), ...order.slice(0, i)];
    } else {
      const atRiver = new Set(river.map((a) => a.seat as number));
      if (atRiver.size < (seats.length === 2 ? 2 : 3)) continue;
    }
    const actual = heroSeatOf(context);
    const won = new Map(hand.results.players.map((p) => [p.seat, p.won]));
    const known = (seat: number) => (context.players.get(seat)?.holeCards?.length ?? 0) === 2;
    const totalWon = order.reduce((s, seat) => s + (won.get(seat) ?? 0), 0);
    if (!(totalWon > 0) || !known(order[0])) continue;
    const combo = new Map<number, number>();
    const cards = new Map<number, string[]>();
    for (const seat of order) {
      if (!known(seat)) continue;
      const cs = context.players.get(seat)?.holeCards as string[];
      const idx = toIndices(cs);
      combo.set(seat, comboIndex(idx[0], idx[1]));
      cards.set(seat, [...cs]);
    }
    const last = new Map<number, number>();
    for (const a of hand.actions) if (a.seat !== null && a.street !== "preflop" && DECISIONS.has(a.type)) last.set(a.seat, a.index);
    const boardCodes = [...(hand.board.runouts[0].flop ?? []), hand.board.runouts[0].turn, hand.board.runouts[0].river].filter((c): c is string => !!c);
    if (boardCodes.length !== 5) continue;
    spots.push({
      h,
      hand,
      walker: actual !== null && seats.includes(actual) ? actual : seats[0],
      actual,
      multiway: seats.length >= 3,
      checked,
      order,
      last,
      combo,
      cards,
      boardCodes,
      strength: streetStrength(toIndices(boardCodes)),
      firstShare: (won.get(order[0]) ?? 0) / totalWon,
      firstName: `${hand.meta.siteId}/${context.players.get(order[0])?.name ?? order[0]}`,
    });
  }
  const groups: [string, (s: Spot) => boolean][] = [
    ["checked, three or more", (s) => s.checked && s.multiway],
    ["checked, heads-up", (s) => s.checked && !s.multiway],
    ["bet called, three or more", (s) => !s.checked && s.multiway],
    ["bet called, heads-up", (s) => !s.checked && !s.multiway],
  ];
  console.log(`=== ${hands.length} hands; ${spots.length} river showdowns: ${groups.map(([t, p]) => `${t} ${spots.filter(p).length}`).join(", ")}`);

  const t0 = performance.now();
  const base = new Map<Spot, Result>();
  for (const s of spots) {
    const r = evaluate(s, charts, BASE, true);
    if (r) base.set(s, r);
  }
  const used = spots.filter((s) => base.has(s));
  console.log(`baseline (analysis/30): ${used.length} spots scored (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  const R0 = (s: Spot) => base.get(s) as Result;

  const diagnose = (title: string, R: (s: Spot) => Result) => {
    console.log(`--- diagnostics: ${title}`);
    for (const [gt, pick] of groups) {
      const sub = used.filter(pick);
      const d = clustered(sub, (s) => s.h, (s) => s.firstShare - R(s).share);
      const cens = sub.flatMap((s) => R(s).cens.map((c) => ({ ...c, h: s.h })));
      const dd = clustered(cens, (c) => c.h, (c) => c.y - c.p);
      console.log(`  ${gt}: n ${sub.length} | first's share won − predicted ${fmt(d)} | later mucked − predicted ${fmt(dd)} (n ${cens.length})`);
    }
    // By the first to show's preflop label (opponents only): PIT in the preflop range by river value.
    const byFirst = new Map<string, Spot[]>();
    for (const s of used) {
      if (s.order[0] === s.actual) continue;
      const lab = R(s).firstLabel;
      for (const k of [lineGroupOfLabel(lab), lab]) byFirst.set(k, [...(byFirst.get(k) ?? []), s]);
    }
    console.log("  first to show (opponent) by preflop label: n | PIT in preflop range (0.5 calibrated) | share won − predicted");
    for (const [k, list] of [...byFirst].sort((a, b) => b[1].length - a[1].length)) {
      if (list.length < 12) continue;
      const pk = clustered(list, (s) => s.h, (s) => R(s).pitPre - 0.5);
      const dk = clustered(list, (s) => s.h, (s) => s.firstShare - R(s).share);
      console.log(`    ${k}: n ${list.length} | PIT − 0.5 ${fmt(pk)} | share ${fmt(dk)}`);
    }
    const cens = used.flatMap((s) => R(s).cens.map((c) => ({ ...c, h: s.h })));
    const byLater = new Map<string, typeof cens>();
    for (const c of cens) for (const k of [lineGroupOfLabel(c.label), c.label]) byLater.set(k, [...(byLater.get(k) ?? []), c]);
    console.log("  later players by preflop label: n | mucked − predicted");
    for (const [k, list] of [...byLater].sort((a, b) => b[1].length - a[1].length)) {
      if (list.length < 12) continue;
      console.log(`    ${k}: n ${list.length} | ${fmt(clustered(list, (c) => c.h, (c) => c.y - c.p))}`);
    }
  };
  if (process.env.PW_DIAG !== "0") diagnose("analysis/30", R0);

  /* ------------------------------------------------ part 2: candidates - */
  const grid: Cand[] = [BASE];
  if (process.env.PW_CANDS) {
    const text = process.env.PW_CANDS.startsWith("/") ? readFileSync(process.env.PW_CANDS, "utf8") : process.env.PW_CANDS;
    for (const c of JSON.parse(text) as Cand[]) grid.push(c);
  } else {
    const all = (p: number): Partial<Record<Group, number>> => Object.fromEntries(GROUPS.map((g) => [g, p]));
    for (const m of [0.05, 0.1, 0.15, 0.2, 0.3]) grid.push({ name: `any ${m} all`, kind: "any", by: all(m) });
    for (const a of [-5, -4, -3, -2.5, -2, -1.5, -1]) grid.push({ name: `shape ${a} all`, kind: "shape", by: all(a) });
  }
  const scores = new Map<string, Map<Spot, Result>>([[BASE.name, base]]);
  const t1 = performance.now();
  for (const [i, cand] of grid.entries()) {
    if (i === 0) continue;
    const m = new Map<Spot, Result>();
    for (const s of used) {
      const r = evaluate(s, charts, cand, process.env.PW_SHARE !== "0");
      if (r) m.set(s, r);
    }
    scores.set(cand.name, m);
    process.stderr.write(`  ${i}/${grid.length - 1} ${cand.name} (${((performance.now() - t1) / 1000).toFixed(0)} s)\n`);
  }
  const names = grid.map((c) => c.name);
  const ok = used.filter((s) => names.every((n) => scores.get(n)?.has(s)));
  console.log(`scored by every candidate: ${ok.length}`);
  const R = (n: string, s: Spot) => scores.get(n)?.get(s) as Result;
  const ll = (n: string, s: Spot) => llScore(s, R(n, s));
  const scopes: [string, (s: Spot) => boolean][] = [["all", () => true], ...groups];
  // The reference the gains are against (`PW_REF`, a candidate's name; default analysis/30).
  const REF = process.env.PW_REF && scores.has(process.env.PW_REF) ? process.env.PW_REF : BASE.name;
  // The candidates a fold may choose (`PW_PICK`, a regular expression on the name; default all).
  const pickable = process.env.PW_PICK ? names.filter((n) => new RegExp(process.env.PW_PICK as string).test(n)) : names;
  // In sample, each candidate against the reference.
  console.log(`in sample (unselected LL gain per spot over ${REF}, clustered by hand; share won − predicted):`);
  for (const n of names.slice(1)) {
    const parts = scopes.map(([t, pick]) => {
      const sub = ok.filter(pick);
      const g = clustered(sub, (s) => s.h, (s) => ll(n, s) - ll(REF, s));
      if (t === "all") return `all LL ${fmt(g)}`;
      const d = clustered(sub, (s) => s.h, (s) => s.firstShare - R(n, s).share);
      return `${t} LL ${fmt(g)} share ${fmt(d)}`;
    });
    console.log(`  ${n}: ${parts.join(" | ")}`);
  }
  // Held out.
  for (const [fname, foldFn, key] of [
    ["hand", (s: Spot) => foldOfHand(s.h), (s: Spot) => s.h as string | number],
    ["player", (s: Spot) => foldOfName(s.firstName), (s: Spot) => s.firstName as string | number],
  ] as const) {
    const chosen: string[] = [];
    const held = new Map<Spot, string>();
    for (let k = 0; k < FOLDS; k += 1) {
      const train = ok.filter((s) => foldFn(s) !== k);
      let best = pickable[0];
      let bestV = -Infinity;
      for (const n of pickable) {
        const v = train.reduce((a, s) => a + ll(n, s), 0);
        if (v > bestV) {
          bestV = v;
          best = n;
        }
      }
      chosen.push(best);
      for (const s of ok) if (foldFn(s) === k) held.set(s, best);
    }
    const out = scopes.map(([t, pick]) => {
      const sub = ok.filter(pick);
      const g = clustered(sub, key, (s) => ll(held.get(s) as string, s) - ll(REF, s));
      const sq = clustered(sub, key, (s) => (s.firstShare - R(REF, s).share) ** 2 - (s.firstShare - R(held.get(s) as string, s).share) ** 2);
      const d = clustered(sub, key, (s) => s.firstShare - R(held.get(s) as string, s).share);
      return `${t}: n ${sub.length} LL gain ${fmt(g)} (${(g.mean / g.se).toFixed(1)} SE); share won − predicted ${fmt(d)}, squared-error gain ${fmt(sq)}`;
    });
    console.log(`held out [folds by ${fname}] over ${REF}, from ${pickable.length} candidates, chose ${chosen.join(" / ")}\n    ${out.join("\n    ")}`);
  }
  if (process.env.PW_DIAG_BEST) {
    const n = process.env.PW_DIAG_BEST;
    if (scores.has(n)) diagnose(n, (s) => R(n, s));
  }
  // Fidelity: the shipped ranges against the study's mix they ship, spot by spot.
  const twin = grid.find((c) => c.kind === "mix" && c.placeholders && c.by.open === 0.75 && c.order === "popnp" && (c.k ?? 1) === 1 && !c.tables && GROUPS.every((g) => c.by[g] === 0.75));
  const shipped = grid.find((c) => c.kind === "shipped");
  const again = grid.filter((c) => c.kind === "shipped");
  if (again.length === 2) {
    const d = ok.map((s) => Math.abs(ll(again[0].name, s) - ll(again[1].name, s)));
    console.log(`determinism: the shipped ranges walked twice, ${d.filter((x) => x > 1e-6).length} spots differ (largest ${Math.max(...d).toExponential(2)})`);
  }
  if (twin && shipped) {
    const diffs = ok.map((s) => Math.abs(ll(twin.name, s) - ll(shipped.name, s)));
    const differ = diffs.filter((d) => d > 1e-6).length;
    console.log(`fidelity: the shipped analysis/31 ranges vs the study's "${twin.name}", ${ok.length} spots: ${differ} differ in the unselected LL by more than 1e-6 (largest ${Math.max(...diffs).toExponential(2)} nats)`);
    if (process.env.PW_DEBUG === "1") {
      const worst = ok.filter((_, i) => diffs[i] > 1e-3).slice(0, 5);
      for (const s of worst) {
        const a = walk(s.hand, s.walker, s.actual, charts, twin);
        const b = walk(s.hand, s.walker, s.actual, charts, shipped);
        if (!a || !b) continue;
        for (const seat of a.w.seats) {
          const ra = a.w.preflop.get(seat) as Float64Array;
          const rb = b.w.preflop.get(seat) as Float64Array;
          let d = 0;
          for (let c = 0; c < NUM_COMBOS; c += 1) d = Math.max(d, Math.abs(ra[c] - rb[c]));
          for (const [idx, x] of a.after) {
            const y = b.after.get(idx);
            let e = 0;
            for (let c = 0; c < NUM_COMBOS; c += 1) e = Math.max(e, Math.abs(x[c] - (y?.[c] ?? -1)));
            if (e > 1e-9) console.log(`    after action ${idx}: max |Δ| ${e.toFixed(4)}`);
          }
          console.log(`  ll twin ${llScore(s, R(twin.name, s)).toFixed(4)} shipped ${llScore(s, R(shipped.name, s)).toFixed(4)} first ${s.order[0]} order ${s.order.join(",")}`);
          console.log(`  debug h${s.h} seat ${seat} hero ${s.actual} ${a.w.labels.get(seat)} ${b.w.sources.get(seat)} [${b.w.approx.get(seat)?.join(",")}] width ${ra.reduce((x, y) => x + y, 0).toFixed(1)} / ${rb.reduce((x, y) => x + y, 0).toFixed(1)} max |Δ| ${d.toExponential(2)} game ${s.hand.game.variant}/${s.hand.game.limit}/${s.hand.game.format}`);
        }
      }
    }
  }
  const guarded = process.env.PW_GUARD ?? "";
  const refCand = grid.find((c) => c.name === REF) ?? BASE;
  if (guarded) for (const c of grid.slice(1)) if (c !== refCand && (guarded === "1" || guarded === c.name)) guard(hands, charts, c, refCand);
});
