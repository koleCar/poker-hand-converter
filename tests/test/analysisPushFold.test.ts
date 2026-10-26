/**
 * R5.5: the push/fold game (`lib/analysis/pushFold.ts`) - the committed
 * equity table, the CFR+ solve, and the hero's EVs against it.
 *
 * The checks are properties and independent computations, never numbers
 * read off another tool: the table against `lib/equity`'s own range equity;
 * the hero's push EV against a hand-built expectation over the caller's
 * solved range; the equilibrium's distance from Nash; chips and ICM agreeing
 * where ICM is linear (two players left); ICM's known direction on a bubble.
 */

import { describe, expect, it } from "vitest";

import { icm } from "../../frontend/src/lib/analysis/icm.js";
import {
  callValues,
  decodePushFoldEquity,
  pushFoldPlayable,
  pushValues,
  rangeShare,
  solvePushFold,
  PUSH_FOLD_EQUITY_BOARDS,
  type PushFoldGame,
} from "../../frontend/src/lib/analysis/pushFold.js";
import { PUSH_FOLD_EQUITY_META } from "../../frontend/src/lib/analysis/data/pushFoldEquity.js";
import { equityVsRange } from "../../frontend/src/lib/equity/index.js";
import { classByName, COMPAT, HAND_CLASSES, NUM_CLASSES } from "../../frontend/src/lib/solver/index.js";

const N = NUM_CLASSES;
const E = decodePushFoldEquity();

/** A table at 50/100: the small blind and big blind the last two, `ante` from everyone. */
function game(stacks: number[], ante: number, prizes: number[] | null): PushFoldGame {
  const k = stacks.length;
  const players = stacks.map((stack, x) => ({ stack, dead: ante, live: x === k - 1 ? 100 : x === k - 2 ? 50 : 0 }));
  const total = stacks.reduce((a, b) => a + b, 0);
  return {
    players,
    value: (end) => (prizes ? Float64Array.from(icm(Array.from(end), prizes).equity) : end.map((x) => x / total)),
  };
}

/** A strategy's weights as the class map `lib/equity` reads. */
function weights(strategy: Float64Array): Map<string, number> {
  const out = new Map<string, number>();
  for (let h = 0; h < N; h += 1) if (strategy[h] > 1e-9) out.set(HAND_CLASSES[h].name, Math.min(1, strategy[h]));
  return out;
}

describe("the committed equity table", () => {
  it("is the generator's: a million boards, complementary, a half on the diagonal", () => {
    expect(PUSH_FOLD_EQUITY_META.boards).toBe(PUSH_FOLD_EQUITY_BOARDS);
    expect(PUSH_FOLD_EQUITY_META.standardError).toBeLessThan(0.0005);
    for (let i = 0; i < N; i += 1) {
      expect(E[i * N + i]).toBe(0.5);
      for (let j = 0; j < N; j += 1) expect(E[i * N + j] + E[j * N + i]).toBeCloseTo(1, 12);
    }
  });

  it("agrees with lib/equity's range equity, class against class", () => {
    const pairs: Array<[string, string, string[]]> = [
      ["AA", "KK", ["As", "Ah"]],
      ["AKs", "QQ", ["As", "Ks"]],
      ["72o", "AA", ["7s", "2h"]],
      ["T9s", "AKo", ["Ts", "9s"]],
      ["55", "AKo", ["5s", "5h"]],
      ["AKo", "AQs", ["As", "Kh"]],
    ];
    for (const [hero, villain, cards] of pairs) {
      const check = equityVsRange({ hero: cards, range: new Map([[villain, 1]]), method: "monte-carlo", trials: 400_000, seed: 3 });
      const table = E[classByName(hero) * N + classByName(villain)];
      // The table's error (~0.0004) and the check's (~0.0008), with room.
      expect(Math.abs(table - check.equity)).toBeLessThan(0.004);
    }
  });
});

describe("the heads-up push/fold game", () => {
  const hu = game([1000, 1000], 0, null);
  const solved = solvePushFold(hu, 0);

  it("is near equilibrium: what a best response gains is tiny", () => {
    // In chips over the 2 000 in play: under a thousandth of a big blind.
    expect(solved.gap * 2000).toBeLessThan(0.1);
  });

  it("pushes the best hands, and more hands the shorter the stacks", () => {
    expect(solved.push[0][classByName("AA")]).toBeGreaterThan(0.99);
    expect(solved.call[0][1][classByName("AA")]).toBeGreaterThan(0.99);
    const at = (bb: number) => rangeShare(solvePushFold(game([bb * 100, bb * 100], 0, null), 0).push[0]);
    const shares = [3, 6, 10, 15, 20].map(at);
    for (let x = 1; x < shares.length; x += 1) expect(shares[x]).toBeLessThan(shares[x - 1]);
    expect(shares[0]).toBeGreaterThan(0.75);
  });

  it("values a push as the caller's solved range does, computed by hand", () => {
    // EV(push) = P(fold) · (stack + 100) + P(call) · (eq · 2000); as a share of the 2 000 chips.
    const range = solved.call[0][1];
    for (const [name, cards] of [
      ["A9o", ["As", "9h"]],
      ["K7s", ["Ks", "7s"]],
      ["44", ["4s", "4h"]],
    ] as const) {
      const h = classByName(name);
      let meets = 0;
      for (let x = 0; x < N; x += 1) meets += COMPAT[h * N + x] * range[x];
      const pCall = meets / 1225;
      const eq = equityVsRange({ hero: cards, range: weights(range), method: "monte-carlo", trials: 300_000, seed: 5 }).equity;
      const expected = ((1 - pCall) * 1100 + pCall * eq * 2000) / 2000;
      const values = pushValues(hu, solved, 0, h);
      expect(Math.abs(values.act - expected)).toBeLessThan(0.002);
      // Folding the small blind gives up 50 of 1 000.
      expect(values.fold).toBeCloseTo(950 / 2000, 12);
    }
  });

  it("is zero-sum in chips: a call's two sides add up", () => {
    const h = classByName("QJo");
    const call = callValues(hu, solved, 0, 1, h);
    // The big blind folding keeps 900 of 2 000.
    expect(call.fold).toBeCloseTo(900 / 2000, 12);
    expect(call.act).toBeGreaterThan(0);
    expect(call.act).toBeLessThan(1);
  });

  it("plays two players left by ICM as by chips: ICM is linear there", () => {
    const icmGame = game([1400, 600], 0, [65, 35]);
    const chips = game([1400, 600], 0, null);
    const a = solvePushFold(icmGame, 0);
    const b = solvePushFold(chips, 0);
    for (let h = 0; h < N; h += 1) {
      expect(a.push[0][h]).toBeCloseTo(b.push[0][h], 6);
      expect(a.call[0][1][h]).toBeCloseTo(b.call[0][1][h], 6);
    }
  });

  it("is deterministic", () => {
    expect(solvePushFold(hu, 0)).toEqual(solved);
  });
});

describe("a full table", () => {
  it("calls far tighter on a sit-and-go bubble than in chips, and so pushes wider", () => {
    // Four left of a 50 / 30 / 20 sit-and-go, 10bb each: the big blind facing the button's push.
    const stacks = [1000, 1000, 1000, 1000];
    const bubble = solvePushFold(game(stacks, 0, [50, 30, 20]), 0);
    const chips = solvePushFold(game(stacks, 0, null), 0);
    expect(rangeShare(bubble.call[1][3])).toBeLessThan(rangeShare(chips.call[1][3]) - 0.03);
    for (const [j, i] of [[0, 1], [0, 3], [2, 3]]) expect(rangeShare(bubble.call[j][i])).toBeLessThan(rangeShare(chips.call[j][i]) / 2);
    // Calls that tight are exploited: every seat pushes more.
    for (const j of [0, 1, 2]) expect(rangeShare(bubble.push[j])).toBeGreaterThan(rangeShare(chips.push[j]));
    expect(bubble.gap).toBeLessThan(0.05);
  });

  it("solves only the sub-game behind the first pusher, and values everyone's folds", () => {
    const g = game([1500, 800, 2200, 600, 1000, 1200, 900, 700, 1100], 10, [50, 30, 20]);
    const solved = solvePushFold(g, 5);
    expect(solved.start).toBe(5);
    expect(solved.push[4]).toBeUndefined();
    // The cutoff (5) facing nothing: a push and a fold, each its own value in prize equity.
    const values = pushValues(g, solved, 5, classByName("AKo"));
    expect(values.act).toBeGreaterThan(values.fold);
    expect(values.freq).toBeGreaterThan(0.99);
    // The big blind (8) facing the cutoff's push, the button and small blind having folded.
    const call = callValues(g, solved, 5, 8, classByName("72o"));
    expect(call.act).toBeLessThan(call.fold);
    expect(call.freq).toBeLessThan(0.01);
  });

  it("refuses a game a post put someone all in", () => {
    const g = game([1000, 50, 1000], 0, null);
    expect(pushFoldPlayable(g)).toBe(false);
    expect(() => solvePushFold(g, 0)).toThrow();
  });
});
