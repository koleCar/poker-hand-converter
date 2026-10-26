/**
 * The field's calling width against raisers, scored unselected (§10,
 * 2026-10-26). The open item of `analysis/32` (`raiserNarrowing.test.ts`):
 * in isolated and 3-bet pots the opponents' ranges still explain what they
 * show too strongly - the isolators and 3-bettors walked to a river showdown
 * muck +0.134 ± 0.040 more than their ranges say. Neither their preflop
 * order (#219) nor the reading of their bets (#221) explains the rest. Is it
 * how wide the field calls them (the callers of an isolation or a 3-bet, and
 * their calls of the raiser's postflop bets), or the rest of the raiser's own
 * postflop narrowing (their calls and give-ups)?
 *
 * Spots and score as `raiserNarrowing.test.ts`: every river showdown in one
 * pot with nobody all-in; the first to show by their combo in their own
 * walked range, each later player by their combo when shown, else by the
 * range's chance of losing to the best hand shown before them (the
 * unselected score of `analysis/30`). Ranges and narrowing are the shipped
 * ones (`analysis/32`'s narrowing, `analysis/31`'s preflop ranges; nothing
 * since changed either); the multiway walk from the hero's seat, no flop
 * library.
 *
 * Roles (from the preflop action, not the ranges): the pot is `limped`,
 * `open` (one raise, nobody in before it), `iso` (one raise behind limpers),
 * `3bet` or `4bet` (two, three or more raises). A seat is `R1` (opened), `R2`
 * (isolated or 3-bet), `R4` (4-bet or more), `C-open` / `C-iso` (flat-called
 * the single raise of an open / an isolated pot, a limper's call included),
 * `C-3bet` (called a 3-bet), `C-4bet` (called a 4-bet or more), `L` (limped,
 * no raise), `X` (the big blind's check).
 *
 * A candidate (`Cand`) changes, for seats of the roles it names:
 * - `pre`: the preflop range at `k` times its width in its own order (every
 *   combo's logit shifted by one number, a bisection; a population range's
 *   intercept moved), or `any` mixing any two cards in at `m`;
 * - `post`: the narrowing's likelihood of their postflop calls, checks, bets
 *   or every action, L → L^t (t < 1 says less), on top of the shipped model.
 *
 * Chosen held out on the unselected log-likelihood: five folds by hand and
 * five by the first to show's name (as before), and a half split by hand and
 * by player in both directions (fit on one half, score the other).
 *
 * What it found (§10 2026-10-26, nothing shipped): the callers are not where
 * the excess is. Widening or narrowing the callers of an isolation or a
 * 3-bet, preflop or in their postflop calls, only loses (the population
 * range of a limper calling an isolation is best at its own width). The
 * isolators' and 3-bettors' own postflop calls and raises read as weaker
 * evidence move their mucks most (+0.134 → +0.087) and gain held out on five
 * folds (2.1 / 2.4 SE), but not on the half splits (1.1, 1.9, 1.3, −0.1 SE)
 * and with one guard row worse (turn three or more −0.005 ± 0.002).
 *
 *     cd tests && FLOPLIB_HANDS=/path/hands.jsonl [CW_CANDS='[...]' or a JSON file path] [CW_REF=<name>] \
 *       [CW_PICK=<regex>] [CW_GUARD=1|<name>] [CW_DIAG_BEST=<name>] [CW_SHARE=0] npm run floplib:caller-width
 *
 * Prints to the console only; nothing about a hand or a player is written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it, vi } from "vitest";

// Study only: a candidate changes an opponent's preflop range by its role (`hook`).
vi.mock("../../../frontend/src/lib/analysis/rangeWalk.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../frontend/src/lib/analysis/rangeWalk.js")>();
  return {
    ...original,
    preflopRangeOf: (...args: Parameters<typeof original.preflopRangeOf>) => {
      const found = original.preflopRangeOf(...args);
      const h = (globalThis as { __cwHook?: { widen: ((r: Float64Array, seat: number, approx: readonly string[]) => Float64Array | null) | null } }).__cwHook;
      const [, , seat, , , options] = args;
      if (!found || !h?.widen || options?.populationHero === undefined || seat === options.populationHero) return found;
      if (found.label.startsWith("unknown")) return found;
      const out = h.widen(found.range, seat, found.approx);
      return out ? { ...found, range: out } : found;
    },
  };
});

import {
  flopSeats,
  handStrength,
  heroSeatOf,
  heuristicModel,
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
const halfOfHand = (hand: number) => createHash("sha256").update(`h${hand}`).digest()[0] % 2;
const halfOfName = (name: string) => createHash("sha256").update(`p${name}`).digest()[1] % 2;
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

/* ------------------------------------------------------------------ roles - */

type Pot = "limped" | "open" | "iso" | "3bet" | "4bet";
const ROLES = ["R1", "R2", "R4", "C-open", "C-iso", "C-3bet", "C-4bet", "L", "X", "?"] as const;
type Role = (typeof ROLES)[number];

/** The pot's preflop type and each seat's role in it. */
function rolesOf(context: StatsContext): { pot: Pot; role: Map<number, Role> } {
  const pre = context.byStreet.get("preflop") ?? [];
  const raises = pre.filter((d) => d.type === "raise" || d.type === "bet");
  const pot: Pot = raises.length === 0 ? "limped" : raises.length === 1 ? (raises[0].enteredBefore.length > 0 ? "iso" : "open") : raises.length === 2 ? "3bet" : "4bet";
  const role = new Map<number, Role>();
  for (const seat of context.dealtInSeats) {
    const mine = pre.filter((d) => d.seat === seat && (d.type === "raise" || d.type === "bet" || d.type === "call"));
    const last = mine[mine.length - 1];
    if (!last) {
      role.set(seat, pre.some((d) => d.seat === seat && d.type === "check") ? "X" : "?");
      continue;
    }
    const level = last.raisesBefore;
    if (last.type !== "call") role.set(seat, level === 0 ? (last.enteredBefore.length > 0 ? "R2" : "R1") : level === 1 ? "R2" : "R4");
    else if (level === 0) role.set(seat, "L");
    else if (level === 1) role.set(seat, pot === "iso" ? "C-iso" : "C-open");
    else if (level === 2) role.set(seat, "C-3bet");
    else role.set(seat, "C-4bet");
  }
  return { pot, role };
}

/* ------------------------------------------------------------- candidates - */

type Kind = "call" | "check" | "bet" | "raise";
interface Cand {
  name: string;
  /** Roles whose preflop range is widened: `k` × its width in its own order, or `m` of any two cards mixed in. */
  pre?: Partial<Record<Role, { k?: number; m?: number }>>;
  /** Roles whose postflop likelihoods are changed: per action kind (or `all`), L → L^t. */
  post?: Partial<Record<Role, Partial<Record<Kind | "all", number>>>>;
  /** Only in pots of these types (default every pot). */
  pots?: Pot[];
}
const BASE: Cand = { name: "shipped" };

const logit = (w: number) => Math.log(w / (1 - w));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** A combo range at `k` times its width, every combo's logit shifted by the same number. */
function widenBy(range: Float64Array, k: number): Float64Array {
  let width = 0;
  const z = new Float64Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = Math.min(1 - 1e-6, Math.max(1e-6, range[c]));
    z[c] = range[c] > 0 ? logit(w) : -Infinity;
    width += range[c] > 0 ? range[c] : 0;
  }
  const target = Math.min(NUM_COMBOS * 0.98, width * k);
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    let s = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) s += z[c] === -Infinity ? 0 : sigmoid(z[c] + mid);
    if (s > target) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  return Float64Array.from(z, (v) => (v === -Infinity ? 0 : sigmoid(v + a)));
}

interface HookState {
  cand: Cand;
  pot: Pot;
  role: Map<number, Role>;
}
const state: { cur: HookState | null } = { cur: null };
const hook = {
  widen(range: Float64Array, seat: number): Float64Array | null {
    const cur = state.cur;
    if (!cur?.cand.pre) return null;
    if (cur.cand.pots && !cur.cand.pots.includes(cur.pot)) return null;
    const rule = cur.cand.pre[cur.role.get(seat) ?? "?"];
    if (!rule) return null;
    if (rule.m !== undefined) return Float64Array.from(range, (w) => (1 - (rule.m as number)) * w + (rule.m as number));
    if (rule.k !== undefined && rule.k !== 1) return widenBy(range, rule.k);
    return null;
  },
};
(globalThis as { __cwHook?: typeof hook }).__cwHook = hook;

function candModel(cand: Cand, pot: Pot, seatOfAction: Map<number, number>, role: Map<number, Role>): NarrowingModel {
  if (!cand.post || (cand.pots && !cand.pots.includes(pot))) return heuristicModel;
  return {
    id: heuristicModel.id,
    likelihood(input: NarrowInput) {
      const l = heuristicModel.likelihood(input);
      const seat = input.actionIndex !== undefined ? seatOfAction.get(input.actionIndex) : undefined;
      if (seat === undefined) return l;
      const rule = cand.post?.[role.get(seat) ?? "?"];
      const t = rule?.[input.action.kind] ?? rule?.all;
      if (t === undefined || t === 1) return l;
      for (let c = 0; c < NUM_COMBOS; c += 1) if (input.actor[c] > 0) l[c] = Math.min(1, Math.pow(Math.max(0, l[c]), t));
      return l;
    },
  };
}

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
  order: number[];
  last: Map<number, number>;
  combo: Map<number, number>;
  cards: Map<number, string[]>;
  boardCodes: string[];
  strength: StreetStrength;
  firstShare: number;
  firstName: string;
  pot: Pot;
  role: Map<number, Role>;
  seatOfAction: Map<number, number>;
}

interface Cens {
  ll: number;
  p: number;
  y: number;
  seat: number;
  role: Role;
}
interface Result {
  share: number;
  firstLL: number;
  pitPre: number;
  cens: Cens[];
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

function seatsOfActions(hand: PhfHand): Map<number, number> {
  const out = new Map<number, number>();
  for (const a of hand.actions) if (a.seat !== null && a.street !== "preflop" && DECISIONS.has(a.type)) out.set(a.index, a.seat);
  return out;
}

function walk(hand: PhfHand, walker: number, actual: number | null, charts: ChartSet, cand: Cand, pot: Pot, role: Map<number, Role>, seatOfAction: Map<number, number>) {
  const rec = recording(candModel(cand, pot, seatOfAction, role));
  state.cur = { cand, pot, role };
  try {
    const w = walkMultiway(structuredClone(hand), buildContext(structuredClone(hand)), walker, charts, rec.model, { populationHero: actual ?? -1 });
    return w.ok ? { w, after: rec.after } : null;
  } catch {
    return null;
  } finally {
    state.cur = null;
  }
}

function evaluate(spot: Spot, charts: ChartSet, cand: Cand, withShare: boolean): Result | null {
  const run = walk(spot.hand, spot.walker, spot.actual, charts, cand, spot.pot, spot.role, spot.seatOfAction);
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
  const res: Result = { share, firstLL: llOf(fr, fc), pitPre: pitOf(pre, value, fc), cens: [] };
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
    const role = spot.role.get(seat) ?? "?";
    if (combo !== undefined) {
      res.cens.push({ ll: llOf(r, combo), p, y: 0, seat, role });
      best = Math.max(best, value[combo]);
      shownCards.push(...toIndices(spot.cards.get(seat) as string[]));
    } else {
      res.cens.push({ ll: Math.max(FLOOR_LL, Math.log(Math.max(1e-9, p))), p, y: 1, seat, role });
    }
  }
  return res;
}

const llScore = (s: Spot, r: Result) => (s.order[0] === s.actual ? 0 : r.firstLL) + r.cens.reduce((a, c) => a + c.ll, 0);

/* ------------------------------------------------------------------ guard - */

/** The earlier studies' shown-hand rows (`analysis/22`, `/23`, `/28`, the river trim), candidate − reference per combo, clustered by player. */
function guard(hands: readonly PhfHand[], charts: ChartSet, cand: Cand, ref: Cand) {
  const rows: { player: string; kind: string; d: number }[] = [];
  for (const hand of hands) {
    if (hand.board.runouts.length > 1 || hand.game.bombPot?.doubleBoard) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    if (seats.length < 2) continue;
    const actual = heroSeatOf(context);
    const shown = seats.filter((s) => s !== actual && (context.players.get(s)?.holeCards?.length ?? 0) === 2);
    if (shown.length === 0) continue;
    const walker = actual !== null && seats.includes(actual) ? actual : seats[0];
    const { pot, role } = rolesOf(context);
    const soa = seatsOfActions(hand);
    const a = walk(hand, walker, actual, charts, ref, pot, role, soa);
    const b = walk(hand, walker, actual, charts, cand, pot, role, soa);
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
      // The preflop range itself, per role (the flop's start), for the roles a candidate widens.
      if (a.w.preflop.has(seat)) {
        rows.push({ player, kind: `preflop ${role.get(seat)}`, d: llOf(b.w.preflop.get(seat), combo) - llOf(a.w.preflop.get(seat), combo) });
      }
    }
  }
  console.log(`--- guard: the shown-hand checks, ${cand.name} − ${ref.name}, per combo (clustered by player)`);
  for (const k of [...new Set(rows.map((r) => r.kind))].sort()) {
    const sub = rows.filter((r) => r.kind === k);
    console.log(`  ${k}: n ${sub.length} | Δ ${fmt(clustered(sub, (r) => r.player, (r) => r.d))}`);
  }
}

/* --------------------------------------------------------------------- run - */

it("the field's calling width against raisers, scored unselected", { timeout: 12 * 60 * 60_000 }, () => {
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
  const withShare = process.env.CW_SHARE !== "0";

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
    const { pot, role } = rolesOf(context);
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
      pot,
      role,
      seatOfAction: seatsOfActions(hand),
    });
  }
  const groups: [string, (s: Spot) => boolean][] = [
    ["checked, three or more", (s) => s.checked && s.multiway],
    ["checked, heads-up", (s) => s.checked && !s.multiway],
    ["bet called, three or more", (s) => !s.checked && s.multiway],
    ["bet called, heads-up", (s) => !s.checked && !s.multiway],
  ];
  const potsOf = (pots: Pot[]) => (s: Spot) => pots.includes(s.pot);
  console.log(`=== ${hands.length} hands; ${spots.length} river showdowns: ${groups.map(([t, p]) => `${t} ${spots.filter(p).length}`).join(", ")}`);
  console.log(`  by pot: ${(["limped", "open", "iso", "3bet", "4bet"] as Pot[]).map((p) => `${p} ${spots.filter((s) => s.pot === p).length}`).join(", ")}`);

  const grid: Cand[] = [BASE];
  if (process.env.CW_CANDS) {
    const text = process.env.CW_CANDS.startsWith("/") ? readFileSync(process.env.CW_CANDS, "utf8") : process.env.CW_CANDS;
    for (const c of JSON.parse(text) as Cand[]) grid.push(c);
  }
  const t0 = performance.now();
  const scores = new Map<string, Map<Spot, Result>>();
  for (const [i, cand] of grid.entries()) {
    const m = new Map<Spot, Result>();
    for (const s of spots) {
      const r = evaluate(s, charts, cand, withShare);
      if (r) m.set(s, r);
    }
    scores.set(cand.name, m);
    process.stderr.write(`  ${i}/${grid.length - 1} ${cand.name} (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
  }
  const names = grid.map((c) => c.name);
  const ok = spots.filter((s) => names.every((n) => scores.get(n)?.has(s)));
  console.log(`scored by every candidate: ${ok.length}`);
  const R = (n: string, s: Spot) => scores.get(n)?.get(s) as Result;
  const ll = (n: string, s: Spot) => llScore(s, R(n, s));

  const diagnose = (n: string) => {
    console.log(`--- diagnostics: ${n}`);
    for (const [gt, pick] of groups) {
      const sub = ok.filter(pick);
      const d = withShare ? fmt(clustered(sub, (s) => s.h, (s) => s.firstShare - R(n, s).share)) : "-";
      const cens = sub.flatMap((s) => R(n, s).cens.map((c) => ({ ...c, h: s.h })));
      console.log(`  ${gt}: n ${sub.length} | first's share won − predicted ${d} | later mucked − predicted ${fmt(clustered(cens, (c) => c.h, (c) => c.y - c.p))} (n ${cens.length})`);
    }
    const cens = ok.flatMap((s) => R(n, s).cens.map((c) => ({ ...c, h: s.h, pot: s.pot, way: s.multiway ? "3+" : "HU", how: s.checked ? "checked" : "called" })));
    const tab = (title: string, keyOf: (c: (typeof cens)[number]) => string | null) => {
      const by = new Map<string, typeof cens>();
      for (const c of cens) {
        const k = keyOf(c);
        if (k !== null) by.set(k, [...(by.get(k) ?? []), c]);
      }
      console.log(`  later players, ${title}: n | mucked | predicted | mucked − predicted | shown LL`);
      for (const [k, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (list.length < 6) continue;
        const muck = list.reduce((s, c) => s + c.y, 0) / list.length;
        const pred = list.reduce((s, c) => s + c.p, 0) / list.length;
        const shown = list.filter((c) => c.y === 0);
        const sl = shown.length ? (shown.reduce((s, c) => s + c.ll, 0) / shown.length).toFixed(2) : "-";
        console.log(`    ${k}: n ${list.length} | ${muck.toFixed(3)} | ${pred.toFixed(3)} | ${fmt(clustered(list, (c) => c.h, (c) => c.y - c.p))} | ${sl} (${shown.length})`);
      }
    };
    tab("by role", (c) => c.role);
    tab("by pot", (c) => c.pot);
    tab("by pot × role", (c) => `${c.pot} ${c.role}`);
    tab("iso and 3-bet pots, by role × river", (c) => (c.pot === "iso" || c.pot === "3bet" ? `${c.role} ${c.how} ${c.way}` : null));
    // The first to show (opponents): their place in their preflop range by river value, by role.
    const firsts = ok.filter((s) => s.order[0] !== s.actual);
    const by = new Map<string, Spot[]>();
    for (const s of firsts) {
      const role = s.role.get(s.order[0]) ?? "?";
      for (const k of [role, `${s.pot} ${role}`]) by.set(k, [...(by.get(k) ?? []), s]);
    }
    console.log("  first to show (opponents), by role: n | PIT in preflop range − 0.5 | first's final-range LL");
    for (const [k, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (list.length < 6) continue;
      const fl = list.reduce((s, x) => s + R(n, x).firstLL, 0) / list.length;
      console.log(`    ${k}: n ${list.length} | ${fmt(clustered(list, (s) => s.h, (s) => R(n, s).pitPre - 0.5))} | ${fl.toFixed(2)}`);
    }
  };
  diagnose(BASE.name);

  const REF = process.env.CW_REF && scores.has(process.env.CW_REF) ? process.env.CW_REF : BASE.name;
  const pickable = process.env.CW_PICK ? names.filter((n) => n === REF || new RegExp(process.env.CW_PICK as string).test(n)) : names;
  const scopes: [string, (s: Spot) => boolean][] = [
    ["all", () => true],
    ...groups,
    ["iso and 3-bet pots", potsOf(["iso", "3bet"])],
    ["other pots", (s) => s.pot !== "iso" && s.pot !== "3bet"],
  ];
  const mucks = (n: string, roles: Role[]) => {
    const rows = ok.flatMap((s) => R(n, s).cens.filter((c) => roles.includes(c.role)).map((c) => ({ ...c, h: s.h })));
    return fmt(clustered(rows, (c) => c.h, (c) => c.y - c.p));
  };
  const potMucks = (n: string, pots: Pot[]) => {
    const rows = ok.filter((s) => pots.includes(s.pot)).flatMap((s) => R(n, s).cens.map((c) => ({ ...c, h: s.h })));
    return fmt(clustered(rows, (c) => c.h, (c) => c.y - c.p));
  };
  console.log(`in sample (unselected LL gain per spot over ${REF}, clustered by hand; later players mucked − predicted: R2, C-iso/C-3bet, everyone in iso/3-bet pots):`);
  for (const n of names) {
    if (n === REF) continue;
    const parts = [scopes[0], scopes[5], scopes[6]].map(([t, pick]) => {
      const sub = ok.filter(pick);
      return `${t} ${fmt(clustered(sub, (s) => s.h, (s) => ll(n, s) - ll(REF, s)))}`;
    });
    console.log(`  ${n}: ${parts.join(" | ")} | mucks R2 ${mucks(n, ["R2"])} C ${mucks(n, ["C-iso", "C-3bet"])} pots ${potMucks(n, ["iso", "3bet"])}`);
  }
  const heldOut = (title: string, foldFn: (s: Spot) => number, nFolds: number, key: (s: Spot) => string | number) => {
    const chosen: string[] = [];
    const held = new Map<Spot, string>();
    for (let k = 0; k < nFolds; k += 1) {
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
      if (!withShare) return `${t}: n ${sub.length} LL gain ${fmt(g)} (${(g.mean / g.se).toFixed(1)} SE)`;
      const sq = clustered(sub, key, (s) => (s.firstShare - R(REF, s).share) ** 2 - (s.firstShare - R(held.get(s) as string, s).share) ** 2);
      const d = clustered(sub, key, (s) => s.firstShare - R(held.get(s) as string, s).share);
      return `${t}: n ${sub.length} LL gain ${fmt(g)} (${(g.mean / g.se).toFixed(1)} SE); share won − predicted ${fmt(d)}, squared-error gain ${fmt(sq)}`;
    });
    console.log(`held out [${title}] over ${REF}, from ${pickable.length} candidates, chose ${chosen.join(" / ")}\n    ${out.join("\n    ")}`);
  };
  heldOut("five folds by hand", (s) => foldOfHand(s.h), FOLDS, (s) => s.h);
  heldOut("five folds by player", (s) => foldOfName(s.firstName), FOLDS, (s) => s.firstName);
  // The half split, both directions: fit on one half, score the other (each line is one direction).
  for (const [title, halfFn, key] of [
    ["hand", (s: Spot) => halfOfHand(s.h), (s: Spot) => s.h as string | number],
    ["player", (s: Spot) => halfOfName(s.firstName), (s: Spot) => s.firstName as string | number],
  ] as const) {
    for (const fit of [0, 1]) {
      let best = pickable[0];
      let bestV = -Infinity;
      for (const n of pickable) {
        const v = ok.filter((s) => halfFn(s) === fit).reduce((a, s) => a + ll(n, s), 0);
        if (v > bestV) {
          bestV = v;
          best = n;
        }
      }
      const test = ok.filter((s) => halfFn(s) !== fit);
      const parts = scopes.map(([t, pick]) => {
        const sub = test.filter(pick);
        const g = clustered(sub, key, (s) => ll(best, s) - ll(REF, s));
        return `${t} n ${sub.length} ${fmt(g)} (${(g.mean / g.se).toFixed(1)} SE)`;
      });
      console.log(`held out [half by ${title}, fit on ${fit}, scored on ${1 - fit}] chose ${best}: ${parts.join(" | ")}`);
    }
  }
  if (process.env.CW_DIAG_BEST && scores.has(process.env.CW_DIAG_BEST)) diagnose(process.env.CW_DIAG_BEST);
  const guarded = process.env.CW_GUARD ?? "";
  const refCand = grid.find((c) => c.name === REF) ?? BASE;
  if (guarded) for (const c of grid) if (c !== refCand && (guarded === "1" || guarded === c.name)) guard(hands, charts, c, refCand);
});
