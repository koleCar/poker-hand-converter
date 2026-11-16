/**
 * Nodelock suggestions (`web/src/lib/solver/nodelockSuggest.ts`,
 * `docs/NODELOCK.md` §4) on synthetic but realistic nodes: a BTN c-bet on
 * A♣T♣6♦ (check / 33 % / 75 %), the BB facing that c-bet (fold / call /
 * raise / all-in), the BTN facing a check-raise (fold / call / all-in), and a
 * turn barrel with two sizes. Strength is the made hand's percentile in the
 * range plus a flush-draw bump; the baseline plays value and draws
 * aggressively, bluff-catchers passively, air folds or bluffs a little.
 *
 * 1. Every archetype moves every node kind the way the §4 table says, by
 *    the stated amount where the table gives one.
 * 2. The right hands move: weakest bets leave first, weakest calls fold
 *    first, the strongest folds call first; with EVs, the cheapest first.
 * 3. Every combo locked, every row sums to 1, no-op archetypes leave the
 *    node as it was and `availableArchetypes` hides them.
 * 4. Deterministic, input untouched.
 * 5. The owner's two examples, in English and Croatian.
 */

import { describe, expect, it } from "vitest";

import { evaluate } from "../../../web/src/lib/equity/evaluator.js";
import { comboCards, NUM_COMBOS, parseRange } from "../../../web/src/lib/solver/combos.js";
import {
  ARCHETYPES,
  availableArchetypes,
  nodelockSuggestEn,
  nodelockSuggestHr,
  suggestLocks,
  type Archetype,
  type NodeKind,
  type Street,
  type SuggestContext,
} from "../../../web/src/lib/solver/nodelockSuggest.js";

const FLOP = ["Ac", "Tc", "6d"];
const TURN = [...FLOP, "2h"];
const BTN_RANGE =
  "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 97s+, 86s+, 75s+, 65s, 54s, A5o+, K9o+, Q9o+, J9o+, T9o";
const BB_RANGE = "22-JJ, A2s-AQs, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o-AJo, K8o+, Q9o+, J9o+, T8o+, 98o";

const CLUB = 3; // suit index of "c" in the evaluator's `shdc`

/** Reach (the range minus board-blocked combos) and strength in [0, 1]. */
function rangeOn(text: string, board: string[]): { reach: Float64Array; strength: Float64Array } {
  const range = parseRange(text);
  const boardIdx = board.map((c) => "23456789TJQKA".indexOf(c[0]) * 4 + "shdc".indexOf(c[1]));
  const reach = new Float64Array(NUM_COMBOS);
  const value = new Float64Array(NUM_COMBOS);
  const live: number[] = [];
  for (let i = 0; i < NUM_COMBOS; i += 1) {
    const [hi, lo] = comboCards(i);
    if (!(range[i] > 0) || boardIdx.includes(hi) || boardIdx.includes(lo)) continue;
    reach[i] = range[i];
    value[i] = evaluate([...boardIdx, hi, lo]);
    live.push(i);
  }
  live.sort((x, y) => value[x] - value[y] || x - y);
  const strength = new Float64Array(NUM_COMBOS);
  const boardClubs = boardIdx.filter((c) => c % 4 === CLUB).length;
  live.forEach((i, k) => {
    const [hi, lo] = comboCards(i);
    const clubs = [hi, lo].filter((c) => c % 4 === CLUB).length;
    const flushDraw = boardClubs === 2 && clubs === 2 && board.length < 5;
    strength[i] = Math.min(1, k / live.length + (flushDraw ? 0.35 : 0));
  });
  return { reach, strength };
}

/** [action][combo] from a per-combo row function. */
function strategyOf(count: number, row: (q: number) => number[], strength: Float64Array, reach: Float64Array): number[][] {
  const out = Array.from({ length: count }, () => new Array<number>(NUM_COMBOS).fill(0));
  for (let i = 0; i < NUM_COMBOS; i += 1) {
    const r = reach[i] > 0 ? row(strength[i]) : row(0.5);
    r.forEach((p, a) => (out[a][i] = p));
  }
  return out;
}

const cbet = (q: number): number[] =>
  q > 0.9 ? [0.1, 0.3, 0.6] : q > 0.6 ? [0.3, 0.6, 0.1] : q > 0.25 ? [0.85, 0.15, 0] : q > 0.12 ? [0.6, 0.3, 0.1] : [0.5, 0.4, 0.1];
const facingBet = (q: number): number[] =>
  q > 0.95 ? [0, 0.4, 0.4, 0.2] : q > 0.85 ? [0, 0.6, 0.4, 0] : q > 0.35 ? [0, 1, 0, 0] : q > 0.25 ? [0.5, 0.5, 0, 0] : q > 0.15 ? [0.6, 0.2, 0.2, 0] : [1, 0, 0, 0];
const facingRaise = (q: number): number[] =>
  q > 0.9 ? [0, 0.5, 0.5] : q > 0.55 ? [0, 1, 0] : q > 0.4 ? [0.5, 0.5, 0] : [1, 0, 0];
const barrel = (q: number): number[] =>
  q > 0.9 ? [0.1, 0.3, 0.5, 0.1] : q > 0.65 ? [0.4, 0.5, 0.1, 0] : q > 0.2 ? [1, 0, 0, 0] : [0.7, 0.2, 0.1, 0];

const btnFlop = rangeOn(BTN_RANGE, FLOP);
const bbFlop = rangeOn(BB_RANGE, FLOP);
const btnTurn = rangeOn(BTN_RANGE, TURN);

function node(kind: NodeKind, street: Street = "flop", extra: Partial<SuggestContext> = {}): SuggestContext {
  const make = (actions: string[], row: (q: number) => number[], r: { reach: Float64Array; strength: Float64Array }, player: 0 | 1, position: string, path: string) => ({
    street,
    path,
    player,
    position,
    actions,
    strategy: strategyOf(actions.length, row, r.strength, r.reach),
    reach: r.reach,
    strength: r.strength,
  });
  if (street !== "flop") {
    return { ...make(["X", "B3.5", "B8.75", "A95"], barrel, btnTurn, 1, "BTN", "X-B1.82-C-X"), role: { preflop: "aggressor", inPosition: true }, nodeKind: "first", ...extra };
  }
  switch (kind) {
    case "first":
      return { ...make(["X", "B1.82", "B4.13"], cbet, btnFlop, 1, "BTN", "X"), role: { preflop: "aggressor", inPosition: true }, nodeKind: kind, ...extra };
    case "facingBet":
      return { ...make(["F", "C", "R6.5", "A97.5"], facingBet, bbFlop, 0, "BB", "X-B1.82"), role: { preflop: "caller", inPosition: false }, nodeKind: kind, ...extra };
    case "facingRaise":
      return { ...make(["F", "C", "A97.5"], facingRaise, btnFlop, 1, "BTN", "X-B1.82-R6.5"), role: { preflop: "aggressor", inPosition: true }, nodeKind: kind, ...extra };
  }
}

/** Reach-weighted share of `actions` (by label) in a [action][combo] strategy. */
function share(ctx: SuggestContext, strategy: ArrayLike<number>[], labels: (l: string) => boolean): number {
  let total = 0;
  let inside = 0;
  for (let i = 0; i < NUM_COMBOS; i += 1) {
    const w = ctx.reach[i];
    if (!(w > 0)) continue;
    total += w;
    ctx.actions.forEach((l, a) => {
      if (labels(l)) inside += w * strategy[a][i];
    });
  }
  return inside / total;
}
const isFold = (l: string) => l === "F";
const isAgg = (l: string) => /^[BRA]/.test(l);

function shifts(ctx: SuggestContext, archetype: Archetype) {
  const s = suggestLocks(ctx, archetype);
  const after = s.nodes[0].strategy;
  return {
    s,
    fold: [share(ctx, ctx.strategy, isFold), share(ctx, after, isFold)],
    agg: [share(ctx, ctx.strategy, isAgg), share(ctx, after, isAgg)],
  };
}

describe("nodelockSuggest: frequency shifts per archetype and node kind", () => {
  const first = node("first");
  const vsBet = node("facingBet");
  const vsRaise = node("facingRaise");

  it("first to act: tight ×0.6, aggressive +20 pp, station ×0.7, passive ×0.5, overfolder unchanged", () => {
    const b = shifts(first, "tight").agg[0];
    expect(b).toBeGreaterThan(0.25);
    expect(shifts(first, "tight").agg[1]).toBeCloseTo(b * 0.6, 4);
    expect(shifts(first, "aggressive").agg[1]).toBeCloseTo(b + 0.2, 4);
    expect(shifts(first, "station").agg[1]).toBeCloseTo(b * 0.7, 4);
    expect(shifts(first, "passive").agg[1]).toBeCloseTo(b * 0.5, 4);
    expect(shifts(first, "overfolder").agg[1]).toBeCloseTo(b, 6);
  });

  it("facing a bet: tight folds +15 pp and raises less, aggressive raises ×2 and folds less, station folds ×0.5, overfolder +20 pp, passive never raises", () => {
    const t = shifts(vsBet, "tight");
    expect(t.fold[1]).toBeCloseTo(t.fold[0] + 0.15, 4);
    expect(t.agg[1]).toBeLessThanOrEqual(t.agg[0] * 0.5 + 1e-6);

    const a = shifts(vsBet, "aggressive");
    expect(a.agg[1]).toBeCloseTo(a.agg[0] * 2, 4);
    expect(a.fold[1]).toBeLessThanOrEqual(a.fold[0] - 0.1 + 1e-6);

    const s = shifts(vsBet, "station");
    expect(s.fold[1]).toBeCloseTo(s.fold[0] * 0.5, 4);
    expect(s.agg[1]).toBeCloseTo(s.agg[0] * 0.3, 4);

    const o = shifts(vsBet, "overfolder");
    expect(o.fold[1]).toBeCloseTo(o.fold[0] + 0.2, 4);
    expect(o.agg[1]).toBeLessThan(o.agg[0]);

    const p = shifts(vsBet, "passive");
    expect(p.agg[1]).toBe(0);
    expect(p.fold[1]).toBeCloseTo(p.fold[0], 6); // the raises went to call
  });

  it("facing a raise: tight +20 pp, aggressive jams ×1.5, station folds ×0.5, overfolder +25 pp, passive never re-raises", () => {
    const f0 = shifts(vsRaise, "tight").fold[0];
    const j0 = shifts(vsRaise, "tight").agg[0];
    expect(shifts(vsRaise, "tight").fold[1]).toBeCloseTo(f0 + 0.2, 4);
    expect(shifts(vsRaise, "aggressive").agg[1]).toBeCloseTo(j0 * 1.5, 4);
    expect(shifts(vsRaise, "station").fold[1]).toBeCloseTo(f0 * 0.5, 4);
    expect(shifts(vsRaise, "overfolder").fold[1]).toBeCloseTo(f0 + 0.25, 4);
    expect(shifts(vsRaise, "passive").agg[1]).toBe(0);
  });

  it("the turn and river are stronger for aggressive and overfolder only", () => {
    const flopAgg = shifts(first, "aggressive");
    const turn = node("first", "turn");
    const river = { ...node("first", "turn"), street: "river" as const };
    const turnAgg = shifts(turn, "aggressive");
    const riverAgg = shifts(river, "aggressive");
    expect(flopAgg.agg[1] - flopAgg.agg[0]).toBeCloseTo(0.2, 4);
    expect(turnAgg.agg[1] - turnAgg.agg[0]).toBeCloseTo(0.25, 4);
    expect(riverAgg.agg[1] - riverAgg.agg[0]).toBeCloseTo(0.3, 4);
    // Tight is the same ×0.6 on every street.
    expect(shifts(turn, "tight").agg[1]).toBeCloseTo(shifts(turn, "tight").agg[0] * 0.6, 4);

    const turnVsBet = { ...vsBet, street: "turn" as const };
    const o = shifts(turnVsBet, "overfolder");
    expect(o.fold[1]).toBeCloseTo(o.fold[0] + 0.25, 4);
    const a = shifts(turnVsBet, "aggressive");
    expect(a.agg[1]).toBeCloseTo(a.agg[0] * 2.25, 4);
  });
});

describe("nodelockSuggest: which hands move", () => {
  it("tight drops the weakest bets first and keeps the value bets", () => {
    const ctx = node("first");
    const after = suggestLocks(ctx, "tight").nodes[0].strategy;
    let strongKept = 0;
    let strong = 0;
    let weakLeft = 0;
    let weak = 0;
    for (let i = 0; i < NUM_COMBOS; i += 1) {
      if (!(ctx.reach[i] > 0)) continue;
      const before = ctx.strategy[1][i] + ctx.strategy[2][i];
      const now = after[1][i] + after[2][i];
      if (ctx.strength![i] > 0.9) {
        strong += 1;
        if (Math.abs(now - before) < 1e-6) strongKept += 1;
      } else if (ctx.strength![i] < 0.12) {
        weak += 1;
        if (now < 1e-6) weakLeft += 1;
      }
    }
    expect(strongKept).toBe(strong);
    expect(weakLeft).toBe(weak);
  });

  it("folds join weakest calls first; the strongest folds leave first", () => {
    const ctx = node("facingBet");
    const tight = suggestLocks(ctx, "tight").nodes[0].strategy;
    const station = suggestLocks(ctx, "station").nodes[0].strategy;
    // The weakest calling hands (0.25..0.35) fold more; the strongest callers (0.6+) still call.
    for (let i = 0; i < NUM_COMBOS; i += 1) {
      if (!(ctx.reach[i] > 0)) continue;
      const q = ctx.strength![i];
      if (q > 0.6 && q <= 0.85) expect(tight[1][i]).toBeCloseTo(1, 6);
      if (q > 0.25 && q <= 0.35) expect(tight[0][i]).toBeGreaterThanOrEqual(ctx.strategy[0][i] - 1e-9);
    }
    // Station: the best folds (0.25..0.35) call before the worst (< 0.15) do.
    const avgFold = (lo: number, hi: number) => {
      let n = 0;
      let f = 0;
      for (let i = 0; i < NUM_COMBOS; i += 1) {
        const q = ctx.strength![i];
        if (ctx.reach[i] > 0 && q > lo && q <= hi) {
          n += 1;
          f += station[0][i];
        }
      }
      return f / n;
    };
    expect(avgFold(0.25, 0.35)).toBeLessThan(avgFold(0, 0.15));
  });

  it("raises split over sizes like the baseline; aggressive later on prefers the bigger size", () => {
    const flopFirst = node("first");
    const flop = suggestLocks(flopFirst, "aggressive").frequencies;
    const ratio = (f: number[]) => f[2] / (f[1] + f[2]);
    // On the flop the new bets keep (roughly) the range's split.
    expect(Math.abs(ratio(flop.after) - ratio(flop.before))).toBeLessThan(0.1);

    const turn = suggestLocks(node("first", "turn"), "aggressive").frequencies;
    const big = (f: number[]) => f[2] / (f[1] + f[2]);
    expect(big(turn.after)).toBeGreaterThan(big(turn.before) + 0.15);
    // All-in is not the "bigger size": it only grows with the bets, at the baseline's share of them.
    const jam = (f: number[]) => f[3] / (f[1] + f[2] + f[3]);
    expect(Math.abs(jam(turn.after) - jam(turn.before))).toBeLessThan(0.02);
  });

  it("with EVs, the hands that lose least move first", () => {
    // Ten combos that always bet; tight keeps 60 %. By strength the four
    // weakest would check; the EVs say the four strongest lose least by checking.
    const reach = new Float64Array(NUM_COMBOS);
    const bet = new Array<number>(NUM_COMBOS).fill(0);
    const check = new Array<number>(NUM_COMBOS).fill(1);
    const evBet = new Array<number>(NUM_COMBOS).fill(0);
    const evCheck = new Array<number>(NUM_COMBOS).fill(0);
    const strength = new Float64Array(NUM_COMBOS);
    const ids = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    ids.forEach((i, k) => {
      reach[i] = 1;
      bet[i] = 1;
      check[i] = 0;
      strength[i] = k / 10;
      evCheck[i] = 1 + k;
      evBet[i] = evCheck[i] + (10 - k) * 0.1; // the strongest gain least from betting
    });
    const base: SuggestContext = {
      street: "flop",
      path: "X",
      player: 1,
      role: { preflop: "aggressor", inPosition: true },
      nodeKind: "first",
      actions: ["X", "B1.82"],
      strategy: [check, bet],
      reach,
      strength,
    };
    const byStrength = suggestLocks(base, "tight").nodes[0].strategy;
    expect(ids.filter((i) => byStrength[1][i] < 0.5)).toEqual([10, 20, 30, 40]);
    const byEv = suggestLocks({ ...base, strength: undefined, ev: [evCheck, evBet] }, "tight").nodes[0].strategy;
    expect(ids.filter((i) => byEv[1][i] < 0.5)).toEqual([70, 80, 90, 100]);
  });
});

describe("nodelockSuggest: the lock", () => {
  const all = (["first", "facingBet", "facingRaise"] as const).map((k) => node(k)).concat([node("first", "turn")]);

  it("locks every combo, and every combo's row sums to 1", () => {
    for (const ctx of all) {
      for (const archetype of ARCHETYPES) {
        const { nodes } = suggestLocks(ctx, archetype);
        expect(nodes).toHaveLength(1);
        const [lock] = nodes;
        expect(lock.street).toBe(ctx.street);
        expect(lock.path).toBe(ctx.path);
        expect(lock.player).toBe(ctx.player);
        expect(lock.actions).toEqual(ctx.actions);
        expect(lock.locked).toHaveLength(NUM_COMBOS);
        expect(lock.locked.every((f) => f === 1)).toBe(true);
        expect(lock.strategy).toHaveLength(ctx.actions.length);
        for (let i = 0; i < NUM_COMBOS; i += 1) {
          let sum = 0;
          for (const row of lock.strategy) {
            expect(row[i]).toBeGreaterThanOrEqual(0);
            sum += row[i];
          }
          expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it("a no-op archetype leaves the node as it was, and is not offered", () => {
    const first = node("first");
    const same = suggestLocks(first, "overfolder").nodes[0].strategy;
    for (let a = 0; a < first.actions.length; a += 1) {
      for (let i = 0; i < NUM_COMBOS; i += 1) expect(Math.abs(same[a][i] - first.strategy[a][i])).toBeLessThan(1e-6);
    }
    expect(availableArchetypes(first)).toEqual(["tight", "aggressive", "station", "passive"]);
    expect(availableArchetypes(node("facingBet"))).toEqual([...ARCHETYPES]);

    // Facing an all-in: nothing to raise, so passive changes nothing.
    const vsJam = node("facingBet");
    const jam = { ...vsJam, actions: ["F", "C"], strategy: [vsJam.strategy[0], vsJam.strategy[1].map((c, i) => c + vsJam.strategy[2][i] + vsJam.strategy[3][i])] };
    expect(availableArchetypes(jam)).not.toContain("passive");
    expect(availableArchetypes(jam)).toContain("tight");

    // A range that never bets: tight, station and passive have nothing to drop.
    const never = { ...first, strategy: [new Array<number>(NUM_COMBOS).fill(1), new Array<number>(NUM_COMBOS).fill(0), new Array<number>(NUM_COMBOS).fill(0)] };
    expect(availableArchetypes(never)).toEqual(["aggressive"]);
  });

  it("is deterministic and leaves its input alone", () => {
    const ctx = node("facingBet");
    const copy = ctx.strategy.map((row) => Array.from(row));
    for (const archetype of ARCHETYPES) {
      expect(suggestLocks(ctx, archetype)).toEqual(suggestLocks(ctx, archetype));
    }
    expect(ctx.strategy.map((row) => Array.from(row))).toEqual(copy);
  });

  it("refuses a node it cannot read", () => {
    const ctx = node("first");
    expect(() => suggestLocks({ ...ctx, strength: undefined }, "tight")).toThrow(/EVs or a strength/);
    expect(() => suggestLocks({ ...ctx, actions: ["X", "B1.82"] }, "tight")).toThrow(/strategy rows/);
    expect(() => suggestLocks({ ...ctx, actions: ["X", "B1.82", "Q"] }, "tight")).toThrow(/unknown action/);
    expect(() => suggestLocks({ ...ctx, reach: new Float64Array(10) }, "tight")).toThrow(/reach/);
  });

  it("reads word labels and explicit kinds as well as the tree's", () => {
    const ctx = node("first");
    const words = suggestLocks({ ...ctx, actions: ["Check", "Bet 33%", "Bet 75%"] }, "tight").nodes[0].strategy;
    const kinds = suggestLocks({ ...ctx, actions: ["a", "b", "c"], kinds: ["check", "bet", "bet"], amounts: [0, 1.82, 4.13] }, "tight").nodes[0].strategy;
    const tree = suggestLocks(ctx, "tight").nodes[0].strategy;
    expect(words).toEqual(tree);
    expect(kinds).toEqual(tree);
  });
});

describe("nodelockSuggest: the owner's examples", () => {
  it("a tight BTN on the flop", () => {
    const ctx = node("first");
    const en = suggestLocks(ctx, "tight");
    expect(en.id).toBe("tight");
    expect(en.title).toBe("Tight BTN on the flop");
    expect(en.explanation).toBe("Bets less often: his weakest bluffs go first, the value bets stay.");
    const hr = suggestLocks(ctx, "tight", nodelockSuggestHr);
    expect(hr.title).toBe("Tight BTN na flopu");
    // Bets 40 % less: the c-bet frequency is 0.6 of the baseline's, and the strongest hands still bet.
    const { before, after } = en.frequencies;
    expect(after[1] + after[2]).toBeCloseTo((before[1] + before[2]) * 0.6, 4);
  });

  it("an aggressive opponent on the turn", () => {
    const ctx = { ...node("first", "turn"), position: undefined };
    const en = suggestLocks(ctx, "aggressive");
    expect(en.title).toBe("Aggressive opponent on the turn");
    expect(en.explanation).toMatch(/more often and bigger/);
    expect(suggestLocks(ctx, "aggressive", nodelockSuggestHr).title).toBe("Agresivan protivnik na turnu");
    const { before, after } = en.frequencies;
    const bets = (f: number[]) => f[1] + f[2] + f[3];
    expect(bets(after) - bets(before)).toBeCloseTo(0.25, 4);
    expect(after[2]).toBeGreaterThan(before[2]);

    // Facing a turn bet, the aggressive opponent raises more and folds less.
    const vsBet = { ...node("facingBet"), street: "turn" as const, position: undefined };
    const r = suggestLocks(vsBet, "aggressive");
    expect(r.title).toBe("Aggressive opponent on the turn");
    expect(r.frequencies.after[2] + r.frequencies.after[3]).toBeGreaterThan(r.frequencies.before[2] + r.frequencies.before[3]);
    expect(r.frequencies.after[0]).toBeLessThan(r.frequencies.before[0]);
  });

  it("every archetype has a title and an explanation in both languages", () => {
    for (const dict of [nodelockSuggestEn, nodelockSuggestHr]) {
      for (const archetype of ARCHETYPES) {
        expect(dict.names[archetype]).toBeTruthy();
        for (const street of ["flop", "turn", "river"] as const) {
          expect(dict.title(archetype, "BTN", street)).toContain("BTN");
          for (const kind of ["first", "facingBet", "facingRaise"] as const) expect(dict.explanation(archetype, kind, street)).toMatch(/\.$/);
        }
      }
    }
    expect(nodelockSuggestEn.title("overfolder", null, "river")).toBe("Opponent who folds too much on the river");
    expect(nodelockSuggestHr.title("station", "BB", "river")).toBe("BB koji previše calla na riveru");
  });
});
