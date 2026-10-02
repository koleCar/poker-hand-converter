/**
 * The calibration games: if the engine misses any of these, nothing it says
 * about a river can be trusted.
 *
 *  - Kuhn poker: the first player's value is exactly -1/18, and the second
 *    player's equilibrium strategy is unique. The engine's best response is
 *    also checked against a brute force over every pure strategy, for random
 *    profiles - that is what makes "exploitability -> 0" mean something.
 *  - Leduc hold'em: exploitability goes to ~0 and the value to ~-0.0856.
 *  - The clairvoyance game: closed-form bluff and call frequencies.
 */

import { describe, expect, it } from "vitest";

import {
  clairvoyanceGame,
  clairvoyanceSolution,
  kuhnGame,
  leducGame,
  Solver,
  type FlatTree,
} from "../../../frontend/src/lib/solver/index.js";

/** Node reached from the root by following edge labels. */
function nodeAt(tree: FlatTree, labels: string[]): number {
  let node = tree.root;
  for (const label of labels) {
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    const edge = tree.edgeLabel.slice(start, start + count).indexOf(label);
    expect(edge, `edge ${label}`).toBeGreaterThanOrEqual(0);
    node = tree.children[start + edge];
  }
  return node;
}

/** A tiny seeded generator, so a failure reproduces. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("Kuhn poker", () => {
  it("converges to the known value -1/18 for the first player", () => {
    const solver = new Solver(kuhnGame());
    solver.iterate(2000);
    const e = solver.exploitability();
    expect(e.value[0]).toBeCloseTo(-1 / 18, 4);
    expect(e.value[1]).toBeCloseTo(1 / 18, 4);
    expect(e.exploitability).toBeLessThan(2e-4);
    // Kuhn's antes are the big blind: 1 chip = 1000 mbb.
    expect(e.mbb).toBeCloseTo(e.exploitability * 1000, 9);
  });

  it("finds the second player's unique equilibrium strategy", () => {
    const game = kuhnGame();
    const solver = new Solver(game);
    solver.iterate(3000);
    // Facing a bet (cards J, Q, K): fold J, call Q 1/3, call K.
    const facing = solver.averageStrategy(nodeAt(game.tree, ["b"]));
    const call = (card: number) => facing[3 + card];
    expect(call(0)).toBeLessThan(0.01);
    expect(call(1)).toBeCloseTo(1 / 3, 2);
    expect(call(2)).toBeGreaterThan(0.99);
    // After a check: bet J 1/3 (bluff), check Q, bet K.
    const afterCheck = solver.averageStrategy(nodeAt(game.tree, ["k"]));
    const bet = (card: number) => afterCheck[3 + card];
    expect(bet(0)).toBeCloseTo(1 / 3, 2);
    expect(bet(1)).toBeLessThan(0.01);
    expect(bet(2)).toBeGreaterThan(0.99);
    // The first player's family: bets J with some a in [0, 1/3] and K with 3a.
    const root = solver.averageStrategy(game.tree.root);
    const a = root[3];
    expect(a).toBeGreaterThanOrEqual(-1e-3);
    expect(a).toBeLessThanOrEqual(1 / 3 + 1e-3);
    expect(root[5]).toBeCloseTo(3 * a, 2);
  });

  it("computes the same best response as brute force over every pure strategy", () => {
    const game = kuhnGame();
    const tree = game.tree;
    const nodes = {
      root: tree.root,
      check: nodeAt(tree, ["k"]),
      checkBet: nodeAt(tree, ["k", "b"]),
      bet: nodeAt(tree, ["b"]),
    };
    const rand = lcg(7);
    for (let trial = 0; trial < 20; trial += 1) {
      // Second-action probability per card at each node, rounded to f32 as stored
      // (the complement is stored in f32 too, hence 1e-7 rather than exact).
      const p = {
        bet0: [0, 1, 2].map(() => Math.fround(rand())),
        call0: [0, 1, 2].map(() => Math.fround(rand())),
        bet1: [0, 1, 2].map(() => Math.fround(rand())),
        call1: [0, 1, 2].map(() => Math.fround(rand())),
      };
      const solver = new Solver(game);
      const set = (node: number, second: number[]) =>
        solver.setAverageStrategy(node, [...second.map((x) => 1 - x), ...second]);
      set(nodes.root, p.bet0);
      set(nodes.checkBet, p.call0);
      set(nodes.check, p.bet1);
      set(nodes.bet, p.call1);

      // Player 0's payoff for a deal under explicit probabilities.
      const payoff = (i: number, j: number, bet0: number, call0: number, bet1: number, call1: number) => {
        const sd = i > j ? 1 : -1;
        const checkLine = (1 - bet1) * sd + bet1 * (call0 * 2 * sd + (1 - call0) * -1);
        const betLine = call1 * 2 * sd + (1 - call1) * 1;
        return (1 - bet0) * checkLine + bet0 * betLine;
      };
      const deals: [number, number][] = [];
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) {
          if (i !== j) {
            deals.push([i, j]);
          }
        }
      }
      const value = (f: (i: number, j: number) => number) => deals.reduce((acc, [i, j]) => acc + f(i, j), 0) / 6;
      const bit = (mask: number, card: number) => (mask >> card) & 1;
      let br0 = -Infinity;
      let br1 = -Infinity;
      for (let m1 = 0; m1 < 8; m1 += 1) {
        for (let m2 = 0; m2 < 8; m2 += 1) {
          br0 = Math.max(
            br0,
            value((i, j) => payoff(i, j, bit(m1, i), bit(m2, i), p.bet1[j], p.call1[j])),
          );
          br1 = Math.max(
            br1,
            value((i, j) => -payoff(i, j, p.bet0[i], p.call0[i], bit(m1, j), bit(m2, j))),
          );
        }
      }
      const v0 = value((i, j) => payoff(i, j, p.bet0[i], p.call0[i], p.bet1[j], p.call1[j]));
      const e = solver.exploitability();
      expect(e.bestResponse[0]).toBeCloseTo(br0, 7);
      expect(e.bestResponse[1]).toBeCloseTo(br1, 7);
      expect(e.value[0]).toBeCloseTo(v0, 7);
      expect(e.nashConv).toBeCloseTo(br0 + br1, 7);
    }
  });

  it("is deterministic: the same iterations give the same bits", () => {
    const a = new Solver(kuhnGame());
    const b = new Solver(kuhnGame());
    a.iterate(300);
    b.iterate(300);
    expect(Array.from(a.strategySum)).toEqual(Array.from(b.strategySum));
    expect(Array.from(a.regrets)).toEqual(Array.from(b.regrets));
  });
});

describe("Leduc hold'em", () => {
  it("drives exploitability to ~0 and the value to ~-0.0856", () => {
    const game = leducGame();
    const solver = new Solver(game);
    const run = solver.run({ maxIterations: 1500, targetExploitability: 0, checkEvery: 500 });
    expect(run.stoppedBy).toBe("max-iterations");
    expect(run.exploitability.exploitability).toBeLessThan(2e-4);
    expect(run.exploitability.mbb).toBeLessThan(0.2);
    expect(run.exploitability.value[0]).toBeCloseTo(-0.0856, 3);
  });

  it("gets less exploitable as it iterates", () => {
    const solver = new Solver(leducGame());
    const seen: number[] = [];
    solver.run({
      maxIterations: 400,
      targetExploitability: 0,
      checkEvery: 100,
      onProgress: ({ exploitability }) => {
        seen.push(exploitability.exploitability);
      },
    });
    expect(seen).toHaveLength(4);
    for (let k = 1; k < seen.length; k += 1) {
      expect(seen[k]).toBeLessThan(seen[k - 1]);
    }
  });

  it("stops early at the target, and when onProgress says so", () => {
    const solver = new Solver(leducGame());
    const run = solver.run({ maxIterations: 5000, targetExploitability: 1, checkEvery: 10 });
    expect(run.stoppedBy).toBe("target");
    expect(run.iterations).toBeLessThan(5000);
    expect(run.exploitability.percentPot).toBeLessThanOrEqual(1);

    const cancelled = new Solver(leducGame()).run({
      maxIterations: 5000,
      targetExploitability: 0,
      checkEvery: 10,
      onProgress: ({ iteration }) => iteration < 30,
    });
    expect(cancelled.stoppedBy).toBe("cancelled");
    expect(cancelled.iterations).toBe(30);
  });
});

describe("the clairvoyance game", () => {
  for (const s of [0.5, 1, 2]) {
    it(`matches the closed form for a ${s * 100}% pot bet`, () => {
      const v = 0.3;
      const game = clairvoyanceGame(s, v);
      const solver = new Solver(game);
      solver.iterate(4000);
      const want = clairvoyanceSolution(s, v);

      // Bettor: hands [nuts, air], actions [check, bet].
      const root = solver.averageStrategy(game.tree.root);
      const nutsBet = root[2];
      const airBet = root[3];
      expect(nutsBet).toBeGreaterThan(0.999);
      expect(airBet).toBeCloseTo(want.bluffFrequency, 2);
      const bluffShare = ((1 - v) * airBet) / ((1 - v) * airBet + v * nutsBet);
      expect(bluffShare).toBeCloseTo(s / (1 + 2 * s), 2);

      // Caller: one hand, actions [fold, call]; calls at MDF.
      const facing = solver.averageStrategy(game.tree.children[game.tree.childStart[game.tree.root] + 1]);
      expect(facing[1]).toBeCloseTo(1 / (1 + s), 2);

      const e = solver.exploitability();
      expect(e.value[0]).toBeCloseTo(want.value, 3);
      expect(e.percentPot).toBeLessThan(0.05);
    });
  }
});
