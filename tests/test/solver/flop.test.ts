/**
 * The flop game (phase A5b): flop betting, the turn dealt, the river dealt.
 * Small ranges and menus so it runs in CI time; the realistic timing is the
 * batch runner's pilot (`tests/scripts/flop-library`).
 *
 * - **Exact arithmetic through two deals**: best response and values agree
 *   with the naive pairwise evaluator.
 * - **Isomorphism on both deals is exact**: the isomorphic solve's strategy,
 *   spread over every turn and river card through the relabellings, has the
 *   full game's exploitability and values.
 * - **Convergence, determinism, 16-bit storage, cancel.**
 */

import { describe, expect, it } from "vitest";

import {
  buildFlopGame,
  comboCode,
  permuteCombo,
  Solver,
  solveFlop,
  type BetMenu,
  type BuiltSubgame,
  type FlopSpot,
} from "../../../frontend/src/lib/solver/index.js";
import { cardCode, cardIndex } from "../../../frontend/src/lib/equity/index.js";
import { naiveValues } from "../support/solverNaive.js";

const CHECK_ONLY: BetMenu = { bet: [], raise: [], allIn: false };
const HALF: BetMenu = { bet: [0.5], raise: [], allIn: false };
const BET_75: BetMenu = { bet: [0.75], raise: [], allIn: false };

/** A two-tone flop (hearts and clubs are off it), turn bets, a checked river. */
const SPOT: FlopSpot = {
  deepInfo: true,
  board: ["Ks", "8s", "2d"],
  ranges: ["KK,88,AKs,KQs,QJs,JTs,T9s,A5s,ATo", "AA,QQ,22,AQs,K8s,98s,76s,AJo,KJo"],
  pot: 10,
  stack: 20,
  menus: [HALF, HALF],
  raiseCap: 0,
  turnMenus: [BET_75, BET_75],
  riverMenus: [CHECK_ONLY, CHECK_ONLY],
};

/** The tiniest flop game: a flop bet, then checked down. For the naive evaluator. */
const TINY: FlopSpot = {
  deepInfo: true,
  board: ["Qs", "7h", "2d"],
  ranges: ["QQ,77,AQs,JTs,A5s", "AA,KK,22,KQs,98s"],
  pot: 10,
  stack: 20,
  menus: [HALF, HALF],
  raiseCap: 0,
  turnMenus: [CHECK_ONLY, CHECK_ONLY],
  riverMenus: [CHECK_ONLY, CHECK_ONLY],
};

describe("the flop game", () => {
  it("deals every turn and river card that is not on the board, and plays each street", () => {
    const built = buildFlopGame(SPOT);
    const tree = built.game.tree;
    expect(built.street).toBe("flop");
    expect(built.info[tree.root]?.street).toBe("flop");
    // X-X on the flop deals the turn: 49 cards; below a turn card, the river: 48.
    const chance = tree.children[tree.childStart[tree.children[tree.childStart[tree.root]]]];
    expect(tree.type[chance]).toBe(3);
    expect(tree.childCount[chance]).toBe(49);
    const turnNode = tree.children[tree.childStart[chance]];
    expect(built.info[turnNode]).toMatchObject({ street: "turn", path: "X-X|2s|", pot: 10 });
    // A called flop bet grows the turn pot: 10 + 2 x 5.
    const called = [...built.info.entries()].find(([, i]) => i?.path === "B5-C|2h|");
    expect(called?.[1]?.pot).toBeCloseTo(20, 9);
    expect(built.game.boards.length).toBe(49 * 48);
    expect(built.game.edgeMirrors).toBeUndefined();
  });

  it("agrees with a naive pairwise evaluation through both deals", () => {
    const built = buildFlopGame(TINY);
    const solver = new Solver(built.game);
    solver.iterate(8);
    const fast = solver.exploitability();
    const slow = naiveValues(built, solver);
    for (const p of [0, 1]) {
      expect(fast.bestResponse[p]).toBeCloseTo(slow.bestResponse[p], 6);
      expect(fast.value[p]).toBeCloseTo(slow.value[p], 6);
    }
  });
});

/** The suit permutation that takes `path`'s dealt cards onto a path of the isomorphic game, or null. */
function permuteDealt(path: string, perm: readonly number[]): string {
  return path.replace(/\|([2-9TJQKA][shdc])\|/g, (_, code: string) => {
    const card = cardIndex(code);
    return `|${cardCode((card & ~3) | perm[card & 3])}|`;
  });
}

/**
 * The full game's average strategy read off an isomorphic solve: each full
 * node takes the strategy of the node its dealt cards map onto under some
 * permutation of the group, hand by hand through that permutation.
 */
function spreadOnto(full: BuiltSubgame, iso: BuiltSubgame, isoSolver: Solver, fullSolver: Solver): number {
  const pathToIso = new Map<string, number>();
  iso.info.forEach((info, node) => {
    if (info) pathToIso.set(info.path, node);
  });
  const group = iso.flopIsomorphism?.group ?? [[0, 1, 2, 3]];
  const index = iso.combos.map((combos) => {
    const at = new Map<number, number>();
    combos.forEach((combo, i) => at.set(combo, i));
    return at;
  });
  let mirrored = 0;
  full.info.forEach((info, node) => {
    if (!info) return;
    let isoNode: number | undefined;
    let perm: readonly number[] = [0, 1, 2, 3];
    for (const candidate of group) {
      isoNode = pathToIso.get(permuteDealt(info.path, candidate));
      if (isoNode !== undefined) {
        perm = candidate;
        break;
      }
    }
    if (isoNode === undefined) throw new Error(`no isomorphic node for ${info.path}`);
    if (perm.some((s, k) => s !== k)) mirrored += 1;
    const player = full.game.tree.player[node];
    const source = isoSolver.averageStrategy(isoNode);
    const n = full.combos[player].length;
    const m = iso.combos[player].length;
    const count = full.game.tree.childCount[node];
    const out = new Float32Array(count * n);
    full.combos[player].forEach((combo, i) => {
      const j = index[player].get(permuteCombo(combo, perm));
      if (j === undefined) throw new Error(`${comboCode(combo)} has no image`);
      for (let a = 0; a < count; a += 1) out[a * n + i] = source[a * m + j];
    });
    fullSolver.setAverageStrategy(node, out);
  });
  return mirrored;
}

describe("suit isomorphism on the turn and the river", () => {
  for (const [name, board, turns] of [
    ["two-tone", ["Ks", "8s", "2d"], 49 - 13],
    ["monotone", ["Ks", "8s", "2s"], 10 + 13],
  ] as const) {
    it(`is exactly the full game on a ${name} flop`, () => {
      const spot: FlopSpot = { ...SPOT, board: [...board] };
      const full = buildFlopGame(spot);
      const iso = buildFlopGame({ ...spot, isomorphism: true });
      expect(iso.flopIsomorphism?.turns).toHaveLength(turns);
      expect(iso.game.tree.size).toBeLessThan(full.game.tree.size);
      // Below a turn card of a free suit the river has fewer classes than below one on the board's suit.
      const rivers = new Map(iso.flopIsomorphism?.turns.map((t) => [t.card, t.rivers]));
      expect(rivers.get("3s")).toBeLessThan(47);

      const isoSolver = new Solver(iso.game);
      isoSolver.iterate(12);
      const fullSolver = new Solver(full.game);
      expect(spreadOnto(full, iso, isoSolver, fullSolver)).toBeGreaterThan(0);
      const a = isoSolver.exploitability();
      const b = fullSolver.exploitability();
      for (const p of [0, 1]) {
        expect(a.bestResponse[p]).toBeCloseTo(b.bestResponse[p], 6);
        expect(a.value[p]).toBeCloseTo(b.value[p], 6);
      }
      const ea = isoSolver.evaluate();
      const eb = fullSolver.evaluate();
      for (const p of [0, 1]) {
        for (let i = 0; i < ea.rootEv[p].length; i += 1) expect(ea.rootEv[p][i]).toBeCloseTo(eb.rootEv[p][i], 5);
      }
    });
  }

  it("finds nothing to share on a rainbow flop", () => {
    const built = buildFlopGame({ ...SPOT, board: ["Ks", "8h", "2d"], isomorphism: true });
    expect(built.flopIsomorphism).toBeUndefined();
    expect(built.game.edgeMirrors).toBeUndefined();
  });
});

describe("solving a flop", () => {
  it("converges on a small tree, and reports flop-level nodes only", () => {
    const solved = solveFlop({ ...SPOT, isomorphism: true }, { maxIterations: 400, targetExploitability: 0.5, checkEvery: 20 });
    expect(solved.run.stoppedBy).toBe("target");
    expect(solved.result.exploitabilityPct).toBeLessThanOrEqual(0.5);
    expect(solved.result.scope).toBe("flop");
    for (const node of solved.result.nodes) {
      if (node.kind === "action") expect(node.street).toBe("flop");
      else {
        expect(node.street).toBe("turn");
        expect(node.children.every((c) => c === -1)).toBe(true);
      }
    }
    // The root's strategy is a distribution per hand, and EVs are finite.
    const root = solved.result.nodes[0];
    const n = solved.result.hands[0].length;
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let a = 0; a < root.actions.length; a += 1) sum += root.strategy[a * n + i];
      expect(sum).toBeCloseTo(1, 5);
    }
    expect(root.ev.every((x) => Number.isFinite(x))).toBe(true);
    expect(solved.stats.turnClasses).toBe(36);
  });

  it("is deterministic", () => {
    const run = () => solveFlop({ ...SPOT, isomorphism: true }, { maxIterations: 30, targetExploitability: 0, checkEvery: 30 });
    const one = run();
    const two = run();
    expect(two.result.exploitabilityPct).toBe(one.result.exploitabilityPct);
    one.result.nodes.forEach((node, k) => {
      expect(Array.from(two.result.nodes[k].strategy)).toEqual(Array.from(node.strategy));
      expect(Array.from(two.result.nodes[k].ev)).toEqual(Array.from(node.ev));
    });
  });

  it("solves as well with 16-bit storage as with float32, in a third of the memory", () => {
    const options = { maxIterations: 60, targetExploitability: 0, checkEvery: 60 };
    const f32 = solveFlop({ ...SPOT, isomorphism: true }, { ...options, storage: "f32" });
    const i16 = solveFlop({ ...SPOT, isomorphism: true }, { ...options, storage: "i16" });
    expect(i16.stats.solverBytes).toBeLessThan(f32.stats.solverBytes * 0.45);
    expect(i16.result.exploitabilityPct).toBeLessThan(Math.max(0.5, f32.result.exploitabilityPct * 1.5));
    // Same game value within the two exploitabilities, and nearly the same root strategy.
    const gap = (Math.abs(i16.result.value[0] - f32.result.value[0]) / SPOT.pot) * 100;
    expect(gap).toBeLessThan(i16.result.exploitabilityPct + f32.result.exploitabilityPct + 0.05);
    const a = f32.result.nodes[0].strategy;
    const b = i16.result.nodes[0].strategy;
    let diff = 0;
    for (let k = 0; k < a.length; k += 1) diff += Math.abs(a[k] - b[k]);
    expect(diff / a.length).toBeLessThan(0.02);
  });

  it("reports progress after every iteration and can be cancelled", () => {
    const seen: number[] = [];
    const solved = solveFlop(TINY, {
      maxIterations: 100,
      targetExploitability: 0,
      onIteration: (progress) => {
        seen.push(progress.iteration);
        return progress.iteration < 3;
      },
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(solved.run.stoppedBy).toBe("cancelled");
    expect(solved.result.iterations).toBe(3);
  });
});
