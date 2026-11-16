/**
 * A flop solve split over turn cards (`web/src/lib/solver/split.ts`,
 * `docs/NODELOCK.md` §2.2) is the sequential solve, bit for bit: the same
 * strategies, EVs and exploitability at a fixed iteration count, whatever
 * the number of parts, in both storages, with frozen nodes too.
 */

import { describe, expect, it } from "vitest";

import {
  buildFlopGame,
  driveSync,
  SplitCoordinator,
  SplitPart,
  splitCards,
  solveFlop,
  solveFlopSplit,
  unitNodes,
  type BetMenu,
  type FlopSpot,
  type SolveResult,
} from "../../../web/src/lib/solver/index.js";

const HALF: BetMenu = { bet: [0.5], raise: [], allIn: false };
const BET_75: BetMenu = { bet: [0.75], raise: [], allIn: true, allInMaxPot: 3 };
const CHECK_ONLY: BetMenu = { bet: [], raise: [], allIn: false };

/** A two-tone flop with a raise on the flop, turn bets and a checked river: small enough for CI. */
const SPOT: FlopSpot = {
  board: ["Ks", "8s", "2d"],
  ranges: ["KK,88,AKs,KQs,QJs,JTs,T9s,A5s,ATo", "AA,QQ,22,AQs,K8s,98s,76s,AJo,KJo"],
  pot: 10,
  stack: 20,
  menus: [{ bet: [0.5], raise: [1], allIn: false }, HALF],
  raiseCap: 1,
  turnMenus: [BET_75, BET_75],
  riverMenus: [CHECK_ONLY, CHECK_ONLY],
  rake: { percent: 0.05, cap: 3 },
  isomorphism: true,
};

function expectSame(a: SolveResult, b: SolveResult): void {
  expect(b.exploitability).toBe(a.exploitability);
  expect(b.value).toEqual(a.value);
  expect(Array.from(b.rootEv[0])).toEqual(Array.from(a.rootEv[0]));
  expect(Array.from(b.rootEv[1])).toEqual(Array.from(a.rootEv[1]));
  expect(b.nodes.length).toBe(a.nodes.length);
  a.nodes.forEach((node, k) => {
    expect(b.nodes[k].path).toBe(node.path);
    expect(Array.from(b.nodes[k].strategy)).toEqual(Array.from(node.strategy));
    expect(Array.from(b.nodes[k].ev)).toEqual(Array.from(node.ev));
  });
}

describe("a split flop solve", () => {
  it("partitions the turn cards deterministically, each card once", () => {
    const built = buildFlopGame(SPOT, { keepTurn: () => false });
    const groups = splitCards(built, 4);
    expect(groups).toHaveLength(4);
    const all = groups.flat().sort((a, b) => a - b);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(built.game.tree.childCount[unitNodes(built)[0]]);
    expect(splitCards(built, 4)).toEqual(groups);
  });

  for (const storage of ["i16", "f32"] as const) {
    it(`is bit-identical to the sequential solve (${storage}), in 1, 3 and 7 parts`, () => {
      const options = { maxIterations: 12, targetExploitability: 0, checkFrom: 6, checkEvery: 6 };
      const sequential = solveFlop(SPOT, { ...options, storage });
      for (const parts of [1, 3, 7]) {
        const split = solveFlopSplit({ spot: SPOT, storage }, parts, options);
        expect(split.run.iterations).toBe(12);
        expectSame(sequential.result, split.result);
      }
    });
  }

  it("parts hold together about what one solver holds", () => {
    const one = solveFlopSplit({ spot: SPOT }, 1, { maxIterations: 1, checkFrom: 1 });
    const four = solveFlopSplit({ spot: SPOT }, 4, { maxIterations: 1, checkFrom: 1 });
    const sum = (parts: SplitPart[]) => parts.reduce((s, p) => s + p.bytes, 0);
    expect(sum(four.parts)).toBeLessThan(sum(one.parts) * 1.3);
    // A coordinator walks no turn: it holds the flop alone.
    expect(four.coordinator.solver.bytes).toBeLessThan(sum(one.parts) / 20);
  });

  it("stops between traversals when the generator is dropped", () => {
    const spec = { spot: SPOT };
    const probe = new SplitCoordinator(spec, []);
    const parts = splitCards(probe.built, 2).map((cards) => new SplitPart(spec, cards));
    const coordinator = new SplitCoordinator(spec, parts.map((p) => p.valueSum));
    const run = driveSync(
      coordinator.run({ maxIterations: 50, targetExploitability: 0, onIteration: (t) => t < 3 }),
      parts,
    );
    expect(run.stoppedBy).toBe("cancelled");
    expect(run.iterations).toBe(3);
  });
});
