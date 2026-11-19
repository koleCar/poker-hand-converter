/**
 * Bomb pot study, step 2: fit how strongly the multiway narrowing reads each
 * action in a bomb pot, scored on river showdowns without selection (the
 * method of `flop-library/raiserNarrowing.test.ts`): every non-hero seat at
 * the showdown, in the order they showed or mucked, by its combo's
 * log-likelihood in its own final range when shown, else by the log of its
 * range's chance of losing to the best hand shown before it (a muck).
 *
 * A candidate raises the heuristic's likelihood L of a bomb pot action to a
 * power per (street, kind): t > 1 reads the action as stronger, t < 1 weaker.
 * Coordinate search over a grid, 5 folds by hand: each fold's held-out gain
 * over the shipped model, with the parameters chosen on the other four.
 * The fit that shipped (`BOMB_POT_EVIDENCE`, analysis/45) was run on the
 * model without it; since then a run here fits on top of it.
 *
 *     cd tests && BOMB_HANDS=/path/hands.jsonl \
 *       npx vitest run --config scripts/bomb-pot/vitest.config.ts narrowing
 *
 * Prints aggregates to the console only.
 */

import { readFileSync } from "node:fs";
import { it } from "vitest";

import {
  heroSeatOf,
  heuristicModel,
  removeCards,
  streetStrength,
  walkMultiway,
  type NarrowingModel,
  type NarrowInput,
} from "../../../web/src/lib/analysis/index.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { comboIndex, NUM_COMBOS } from "../../../web/src/lib/solver/index.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";

type Street = "flop" | "turn" | "river";
type Kind = "bet" | "raise" | "call" | "check";
/** Parameter keys: `<street>.<kind>`, a power on L. Missing = 1 (the shipped model). */
type Params = Record<string, number>;

const FOLDS = 5;
const FLOOR_LL = Math.log(1 / (20 * NUM_COMBOS));
const DECISIONS = new Set(["check", "bet", "call", "raise", "fold"]);

function model(params: Params): NarrowingModel {
  return {
    id: heuristicModel.id,
    likelihood(input: NarrowInput) {
      const l = heuristicModel.likelihood(input);
      if (!input.action.bombPot) return l;
      const t = params[`${input.street}.${input.action.kind as Kind}`];
      if (t === undefined || t === 1) return l;
      for (let c = 0; c < NUM_COMBOS; c += 1) if (input.actor[c] > 0) l[c] = Math.min(1, Math.pow(Math.max(0, l[c]), t));
      return l;
    },
  };
}

interface Spot {
  h: number;
  hand: PhfHand;
  hero: number;
  /** Showdown seats in the order they showed or mucked. */
  order: number[];
  last: Map<number, number>;
  combo: Map<number, number>;
  value: Int32Array;
}

function llOf(range: Float64Array, combo: number): number {
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) total += range[c] > 0 ? range[c] : 0;
  if (!(total > 0) || !(range[combo] > 0)) return FLOOR_LL;
  return Math.max(FLOOR_LL, Math.log(range[combo] / total));
}

/** The spot's score (sum over non-hero seats) under `params`, or null when the walk refuses. */
function score(spot: Spot, params: Params): number | null {
  const after = new Map<number, Float64Array>();
  const base = model(params);
  const rec: NarrowingModel = {
    id: base.id,
    likelihood(input) {
      const l = base.likelihood(input);
      if (input.actionIndex !== undefined) {
        const o = new Float64Array(NUM_COMBOS);
        for (let c = 0; c < NUM_COMBOS; c += 1) if (input.actor[c] > 0) o[c] = input.actor[c] * Math.min(1, Math.max(0, l[c] || 0));
        after.set(input.actionIndex, o);
      }
      return l;
    },
  };
  let w;
  try {
    w = walkMultiway(structuredClone(spot.hand), buildContext(structuredClone(spot.hand)), spot.hero, null, rec);
  } catch {
    return null;
  }
  if (!w.ok) return null;
  let best = -1;
  const shown: number[] = [];
  let sum = 0;
  for (const seat of spot.order) {
    const combo = spot.combo.get(seat);
    if (seat === spot.hero) {
      if (combo !== undefined) {
        best = Math.max(best, spot.value[combo]);
        shown.push(...comboCardsOf(combo));
      }
      continue;
    }
    const idx = spot.last.get(seat);
    const fr = idx !== undefined ? after.get(idx) : undefined;
    if (!fr) return null;
    const r = removeCards(Float64Array.from(fr), shown);
    if (combo !== undefined) {
      sum += llOf(r, combo);
      best = Math.max(best, spot.value[combo]);
      shown.push(...comboCardsOf(combo));
    } else {
      if (best < 0) continue;
      let total = 0;
      let lose = 0;
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        const x = r[c];
        if (!(x > 0) || spot.value[c] < 0) continue;
        total += x;
        if (spot.value[c] < best) lose += x;
      }
      if (total > 0) sum += Math.max(FLOOR_LL, Math.log(Math.max(1e-9, lose / total)));
    }
  }
  return sum;
}

const CARD_CACHE = new Map<number, number[]>();
function comboCardsOf(combo: number): number[] {
  let v = CARD_CACHE.get(combo);
  if (!v) {
    for (let a = 0; a < 52 && !v; a += 1) for (let b = 0; b < a && !v; b += 1) if (comboIndex(a, b) === combo) v = [a, b];
    CARD_CACHE.set(combo, v as number[]);
  }
  return v as number[];
}

function spotsOf(lines: string[]): Spot[] {
  const spots: Spot[] = [];
  lines.forEach((line, h) => {
    const hand = JSON.parse(line) as PhfHand;
    if (!hand.game.bombPot || hand.game.bombPot.doubleBoard || hand.board.runouts.length !== 1) return;
    const r = hand.board.runouts[0];
    if (!r?.river || !r.turn || r.flop?.length !== 3) return;
    const context = buildContext(structuredClone(hand));
    const hero = heroSeatOf(context);
    if (hero === null) return;
    const at = hand.results.players.filter((p) => p.outcome === "won" || p.outcome === "lost" || p.outcome === "mucked");
    if (at.length < 2) return;
    // Order: the show / muck actions as written; seats without one keep the summary's order after them.
    const order: number[] = [];
    for (const a of hand.actions) if ((a.type === "show" || a.type === "muck") && a.seat !== null && !order.includes(a.seat)) order.push(a.seat);
    for (const p of at) if (!order.includes(p.seat)) order.push(p.seat);
    const showdown = order.filter((s) => at.some((p) => p.seat === s));
    const last = new Map<number, number>();
    for (const a of hand.actions) if (a.seat !== null && DECISIONS.has(a.type) && a.street !== "preflop" && a.street !== "showdown") last.set(a.seat, a.index);
    const combo = new Map<number, number>();
    for (const seat of showdown) {
      const cards = hand.players.find((p) => p.seat === seat)?.holeCards;
      if (cards?.length === 2) {
        const [x, y] = toIndices(cards);
        combo.set(seat, comboIndex(Math.max(x, y), Math.min(x, y)));
      }
    }
    if (!showdown.every((s) => s === hero || last.has(s))) return;
    const board = toIndices([...r.flop, r.turn, r.river]);
    spots.push({ h, hand, hero, order: showdown, last, combo, value: streetStrength(board).value });
  });
  return spots;
}

const GRID = [0.5, 0.7, 1, 1.4, 2, 3];
const KEYS = ["flop.raise", "turn.raise", "flop.bet", "turn.bet", "river.bet", "flop.call", "turn.call", "river.call"];

it("fits the bomb pot narrowing", () => {
  const file = process.env.BOMB_HANDS;
  if (!file) throw new Error("set BOMB_HANDS");
  const spots = spotsOf(readFileSync(file, "utf8").split("\n").filter(Boolean));
  console.log(`spots ${spots.length}, scored seats ${spots.reduce((s, x) => s + x.order.filter((q) => q !== x.hero).length, 0)}, mucks ${spots.reduce((s, x) => s + x.order.filter((q) => q !== x.hero && !x.combo.has(q)).length, 0)}`);

  // Per-spot score cache: key = params JSON.
  const cache = new Map<string, (number | null)[]>();
  let evals = 0;
  const scoresOf = (p: Params) => {
    const key = JSON.stringify(Object.entries(p).filter(([, v]) => v !== 1).sort());
    let s = cache.get(key);
    if (!s) {
      s = spots.map((spot) => score(spot, p));
      cache.set(key, s);
      evals += 1;
      if (evals % 10 === 0) console.log(`  ${evals} candidates walked`);
    }
    return s;
  };
  const t0 = Date.now();
  const baseline = scoresOf({});
  console.log(`baseline walk ${((Date.now() - t0) / 1000).toFixed(1)} s, valid ${baseline.filter((x) => x !== null).length}`);
  if (process.env.BOMB_TIME) return;
  const valid = spots.map((_, i) => baseline[i] !== null);
  const total = (p: Params, folds: (f: number) => boolean) => {
    const s = scoresOf(p);
    let sum = 0;
    for (let i = 0; i < spots.length; i += 1) if (valid[i] && folds(spots[i].h % FOLDS) && s[i] !== null) sum += s[i] as number;
    return sum;
  };

  // BOMB_EVAL: a JSON list of parameter sets, each scored on all spots against the shipped model.
  if (process.env.BOMB_EVAL) {
    const sets = JSON.parse(process.env.BOMB_EVAL) as Params[];
    const base = total({}, () => true);
    const seats = spots.filter((_, i) => valid[i]).reduce((a, s) => a + s.order.filter((q) => q !== s.hero).length, 0);
    for (const p of sets) console.log(`eval ${JSON.stringify(p)}: ${((total(p, () => true) - base) / seats).toFixed(4)} per seat`);
    return;
  }

  const fit = (folds: (f: number) => boolean): Params => {
    const p: Params = {};
    for (let pass = 0; pass < 1; pass += 1) {
      for (const key of KEYS) {
        let bestV = p[key] ?? 1;
        let bestS = total(p, folds);
        for (const v of GRID) {
          const s = total({ ...p, [key]: v }, folds);
          if (s > bestS + 1e-9) {
            bestS = s;
            bestV = v;
          }
        }
        p[key] = bestV;
      }
    }
    return p;
  };

  // Held out: per fold, fit on the other four, score this one.
  const gains: number[] = [];
  const perSeat: number[] = [];
  for (let f = 0; f < FOLDS; f += 1) {
    const p = fit((g) => g !== f);
    const hold = (g: number) => g === f;
    const gain = total(p, hold) - total({}, hold);
    const seats = spots.filter((s, i) => valid[i] && s.h % FOLDS === f).reduce((a, s) => a + s.order.filter((q) => q !== s.hero).length, 0);
    gains.push(gain);
    perSeat.push(gain / Math.max(1, seats));
    console.log(`fold ${f}: ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([, v]) => v !== 1)))}  held-out gain ${gain.toFixed(1)} (${(gain / Math.max(1, seats)).toFixed(3)} per seat, ${seats} seats)`);
  }
  const all = fit(() => true);
  console.log(`all folds: ${JSON.stringify(Object.fromEntries(Object.entries(all).filter(([, v]) => v !== 1)))}`);
  const mean = perSeat.reduce((a, b) => a + b, 0) / FOLDS;
  const sd = Math.sqrt(perSeat.reduce((a, b) => a + (b - mean) ** 2, 0) / (FOLDS - 1));
  console.log(`held-out gain per seat ${mean.toFixed(3)} ± ${(sd / Math.sqrt(FOLDS)).toFixed(3)} (folds positive: ${gains.filter((g) => g > 0).length}/${FOLDS})`);
  // Single-parameter profile on all data, for the write-up (only with BOMB_PROFILE: it costs a walk per cell).
  for (const key of process.env.BOMB_PROFILE ? KEYS : []) {
    const row = GRID.map((v) => (total({ ...all, [key]: v }, () => true) - total(all, () => true)).toFixed(1));
    console.log(`profile ${key.padEnd(12)} ${GRID.map((v, i) => `${v}:${row[i]}`).join("  ")}`);
  }
});
