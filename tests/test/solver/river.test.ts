/**
 * The heads-up river: tree rules, payoffs, the engine's terminal arithmetic
 * against a naive reference, convergence on a realistic spot, and the
 * meaning of what a result reports (EVs, frequencies, narrowed ranges).
 */

import { describe, expect, it } from "vitest";

import {
  buildRiverGame,
  comboHi,
  comboIndex,
  comboLo,
  decodeSolution,
  encodeSolution,
  nodeAt,
  rangesAt,
  Solver,
  SolutionFormatError,
  solveBuilt,
  solveRiver,
  SolverInputError,
  type BetMenu,
  type RiverSpot,
} from "../../../frontend/src/lib/solver/index.js";
import { cardIndex } from "../../../frontend/src/lib/equity/index.js";
import { naiveValues } from "../support/solverNaive.js";

const BOARD = ["Qs", "Jh", "7d", "4c", "2s"];
/** A big-blind-defence-like range and a button-like range: ~300 vs ~240 combos on BOARD. */
const OOP =
  "TT-22,AJs-A2s,KJs-K5s,QJs-Q8s,JTs-J8s,T9s-T7s,98s-96s,87s-85s,76s-75s,65s-64s,54s,AJo-A8o,KJo-K9o,QJo-Q9o,JTo-J9o,T9o";
const IP = "AA-22,AKs-A2s,KQs-K8s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,65s,AKo-ATo,KQo-KTo,QJo";
const MENU: BetMenu = { bet: [0.33, 0.75], raise: [0.75], allIn: true };

/** A narrow spot that the naive reference can afford. */
const SMALL: RiverSpot = {
  board: BOARD,
  ranges: ["AA,QQ,JJ,77,AQs,KQs,QJs,JTs,T9s,98s,A5s,K4s", "KK,QQ,44,22,AQo,KQo,QJo,J7s,T8s,65s,A3s"],
  pot: 10,
  stack: 25,
  menus: [MENU, { bet: [0.5], raise: [1], allIn: true }],
  raiseCap: 2,
};

describe("river tree", () => {
  it("offers bets, raises and all-in from the menu, capped", () => {
    const built = buildRiverGame({
      board: BOARD,
      ranges: ["AA", "KK"],
      pot: 10,
      stack: 100,
      menus: [
        { bet: [0.5, 1], raise: [1], allIn: true },
        { bet: [0.5, 1], raise: [1], allIn: true },
      ],
      raiseCap: 1,
    });
    const result = solveBuilt(built, { maxIterations: 1 });
    expect(result.nodes[0].labels).toEqual(["X", "B5", "B10", "A100"]);
    // Pot-sized raise over a 5 bet: call 5, then 20 more = raise to 25.
    expect(result.nodes[nodeAt(result, "B5")].labels).toEqual(["F", "C", "R25", "A100"]);
    // One raise allowed: the bettor may only fold or call it.
    expect(result.nodes[nodeAt(result, "B5-R25")].labels).toEqual(["F", "C"]);
    expect(result.nodes[nodeAt(result, "X")].labels).toEqual(["X", "B5", "B10", "A100"]);
    expect(nodeAt(result, "X-X")).toBe(-1); // check-check is a showdown, not a node

    const raise = result.nodes[nodeAt(result, "B5")].actions[2];
    expect(raise).toMatchObject({ kind: "raise", amount: 25, to: 25 });
    expect(raise.sizePot).toBeCloseTo(1, 12);
    const bet = result.nodes[0].actions[1];
    expect(bet).toMatchObject({ kind: "bet", amount: 5, to: 5, sizePot: 0.5 });
    expect(result.nodes[nodeAt(result, "B5")]).toMatchObject({ pot: 15, toCall: 5, behind: 100 });
  });

  it("applies the minimum raise, the all-in threshold and merges equal sizes", () => {
    const tiny = buildRiverGame({
      board: BOARD,
      ranges: ["AA", "KK"],
      pot: 10,
      stack: 100,
      menus: [
        { bet: [1, 1.0000001], raise: [0.1], allIn: false },
        { bet: [1], raise: [0.1], allIn: false },
      ],
    });
    const result = solveBuilt(tiny, { maxIterations: 1 });
    expect(result.nodes[0].labels).toEqual(["X", "B10"]);
    // 10% of the pot after calling 10 would be a raise to 13; the minimum is to 20.
    expect(result.nodes[nodeAt(result, "B10")].labels).toEqual(["F", "C", "R20"]);

    const shallow = solveBuilt(
      buildRiverGame({
        board: BOARD,
        ranges: ["AA", "KK"],
        pot: 10,
        stack: 30,
        menus: [
          { bet: [0.5, 1], raise: [], allIn: false },
          { bet: [1], raise: [], allIn: false },
        ],
        allInThreshold: 0.7,
      }),
      { maxIterations: 1 },
    );
    // A pot bet leaves 20 behind into a 30 pot after the call: below 0.7 x 30, so all-in.
    expect(shallow.nodes[0].labels).toEqual(["X", "B5", "A30"]);
  });

  it("stores net payoffs, with rake taken from the final pot", () => {
    const spot = {
      board: BOARD,
      ranges: ["AA", "KK"] as [string, string],
      pot: 10,
      stack: 100,
      menus: [
        { bet: [0.5], raise: [], allIn: false },
        { bet: [0.5], raise: [], allIn: false },
      ] as [BetMenu, BetMenu],
    };
    const payoffAfter = (rake: RiverSpot["rake"], labels: string[]) => {
      const { tree } = buildRiverGame({ ...spot, rake }).game;
      let node = tree.root;
      for (const label of labels) {
        const start = tree.childStart[node];
        node = tree.children[start + tree.edgeLabel.slice(start, start + tree.childCount[node]).indexOf(label)];
      }
      return Array.from(tree.payoff.subarray(node * 6, node * 6 + 6));
    };
    // B5 F: the bettor nets the pot (10); the folder loses nothing more.
    expect(payoffAfter(undefined, ["B5", "F"])).toEqual([10, 0, 0, 0, 0, 0]);
    // With 5% capped at 1: 15 in the middle, 0.75 raked.
    expect(payoffAfter({ percent: 0.05, cap: 1 }, ["B5", "F"])).toEqual([9.25, 0, 0, 0, 0, 0]);
    // B5 C showdown: 20 in the middle, 1 raked (capped). [win, lose, tie] per player.
    expect(payoffAfter({ percent: 0.05, cap: 1 }, ["B5", "C"])).toEqual([14, -5, 4.5, 14, -5, 4.5]);
  });

  it("rejects input it cannot solve", () => {
    const base = SMALL;
    expect(() => buildRiverGame({ ...base, board: BOARD.slice(0, 4) })).toThrow(SolverInputError);
    expect(() => buildRiverGame({ ...base, board: ["Qs", "Qs", "7d", "4c", "2s"] })).toThrow(SolverInputError);
    expect(() => buildRiverGame({ ...base, ranges: ["QsJh", "KK"] })).toThrow(SolverInputError); // blocked by the board
    expect(() => buildRiverGame({ ...base, pot: 0 })).toThrow(SolverInputError);
    expect(() =>
      buildRiverGame({ ...base, menus: [{ bet: [-1], raise: [], allIn: false }, MENU] }),
    ).toThrow(SolverInputError);
  });
});

describe("river solve", () => {
  it("agrees with a naive pairwise evaluation, with and without rake", () => {
    for (const rake of [undefined, { percent: 0.05, cap: 1.5 }]) {
      const built = buildRiverGame({ ...SMALL, rake });
      const solver = new Solver(built.game);
      solver.iterate(60);
      const fast = solver.exploitability();
      const slow = naiveValues(built, solver);
      for (const p of [0, 1]) {
        // Not bit-equal: the naive side reads the f32-rounded normalised strategy
        // and sums in another order. A card-removal or tie bug is far larger.
        expect(fast.bestResponse[p]).toBeCloseTo(slow.bestResponse[p], 6);
        expect(fast.value[p]).toBeCloseTo(slow.value[p], 6);
      }
      if (rake) {
        // Rake leaves the table: the two values sum to less than the pot.
        expect(fast.value[0] + fast.value[1]).toBeLessThan(SMALL.pot);
      } else {
        expect(fast.value[0] + fast.value[1]).toBeCloseTo(SMALL.pot, 9);
      }
    }
  });

  it("solves a realistic spot to under 0.5% of the pot", () => {
    const result = solveRiver(
      { board: BOARD, ranges: [OOP, IP], pot: 20, stack: 80, menus: [MENU, MENU], raiseCap: 2 },
      { maxIterations: 1000, targetExploitability: 0.3 },
    );
    expect(result.stoppedBy).toBe("target");
    expect(result.exploitabilityPct).toBeLessThanOrEqual(0.3);
    expect(result.exploitabilityMbb).toBeCloseTo(result.exploitability * 1000, 6);
    expect(result.hands[0].length).toBeGreaterThan(250);
    expect(result.hands[1].length).toBeGreaterThan(200);
    expect(result.value[0] + result.value[1]).toBeCloseTo(20, 6);
  });

  it("reports EVs that mean what grading needs them to mean", () => {
    const result = solveRiver(
      { board: BOARD, ranges: [OOP, IP], pot: 20, stack: 80, menus: [MENU, MENU] },
      { maxIterations: 600, targetExploitability: 0.1 },
    );
    const root = result.nodes[0];
    const n = result.hands[0].length;
    const k = root.labels.length;
    for (let i = 0; i < n; i += 1) {
      // The strategy's mix of action EVs is the hand's EV at the root.
      let mixed = 0;
      let best = -Infinity;
      for (let a = 0; a < k; a += 1) {
        mixed += root.strategy[a * n + i] * root.ev[a * n + i];
        best = Math.max(best, root.ev[a * n + i]);
      }
      expect(mixed).toBeCloseTo(result.rootEv[0][i], 3);
      // Near equilibrium every action played with real frequency is close to the best one.
      for (let a = 0; a < k; a += 1) {
        if (root.strategy[a * n + i] > 0.2) {
          expect(best - root.ev[a * n + i]).toBeLessThan(0.02 * result.pot);
        }
      }
    }
    // Per-hand EVs average back to the game value, each hand weighted by its
    // range weight times the opponent combos it does not block.
    const cards = (combo: number) => [comboHi(combo), comboLo(combo)];
    let total = 0;
    let mass = 0;
    result.hands[0].forEach((combo, i) => {
      const mine = cards(combo);
      let compatible = 0;
      result.hands[1].forEach((other, j) => {
        if (!cards(other).some((c) => mine.includes(c))) {
          compatible += result.weights[1][j];
        }
      });
      total += result.weights[0][i] * compatible * result.rootEv[0][i];
      mass += result.weights[0][i] * compatible;
    });
    expect(total / mass).toBeCloseTo(result.value[0], 3);
    // A set of sevens beats most of what the button has here; it wins more than the pot share.
    const set = result.hands[0].indexOf(comboIndex(cardIndex("7h"), cardIndex("7c")));
    expect(result.rootEv[0][set]).toBeGreaterThan(result.pot * 0.8);
  });

  it("reports range frequencies and narrowed ranges consistently", () => {
    const result = solveRiver(SMALL, { maxIterations: 200 });
    for (const node of result.nodes) {
      expect(node.frequency.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      const size = result.hands[node.player].length;
      for (let i = 0; i < size; i += 1) {
        let sum = 0;
        for (let a = 0; a < node.labels.length; a += 1) {
          sum += node.strategy[a * size + i];
        }
        expect(sum).toBeCloseTo(1, 5);
      }
    }
    const [r0, r1] = rangesAt(result, 0);
    expect(Array.from(r0)).toEqual(Array.from(result.weights[0]));
    const bet = nodeAt(result, result.nodes[0].labels[1]);
    const [b0, b1] = rangesAt(result, bet);
    expect(Array.from(b1)).toEqual(Array.from(r1));
    const total = r0.reduce((a, b) => a + b, 0);
    expect(b0.reduce((a, b) => a + b, 0) / total).toBeCloseTo(result.nodes[0].frequency[1], 6);
  });

  it("does not care which index acts first", () => {
    const a = solveRiver(SMALL, { maxIterations: 400, targetExploitability: 0.05 });
    const b = solveRiver(
      {
        ...SMALL,
        ranges: [SMALL.ranges[1], SMALL.ranges[0]],
        menus: [SMALL.menus[1], SMALL.menus[0]],
        firstToAct: 1,
      },
      { maxIterations: 400, targetExploitability: 0.05 },
    );
    expect(b.nodes[0].player).toBe(1);
    expect(b.nodes[0].labels).toEqual(a.nodes[0].labels);
    expect(b.value[1]).toBeCloseTo(a.value[0], 1);
    expect(b.value[0]).toBeCloseTo(a.value[1], 1);
  });

  it("is deterministic", () => {
    const a = encodeSolution(solveRiver(SMALL, { maxIterations: 50, targetExploitability: 0 }));
    const b = encodeSolution(solveRiver(SMALL, { maxIterations: 50, targetExploitability: 0 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("solution blob", () => {
  it("round-trips, with strategies quantised to 1/65535", () => {
    const result = solveRiver(SMALL, { maxIterations: 100 });
    const blob = encodeSolution(result);
    const back = decodeSolution(blob);
    expect(back.version).toBe("solver/1");
    expect(Array.from(back.hands[0])).toEqual(Array.from(result.hands[0]));
    expect(back.value).toEqual(result.value);
    expect(back.nodes.map((n) => n.path)).toEqual(result.nodes.map((n) => n.path));
    expect(back.nodes.map((n) => n.children)).toEqual(result.nodes.map((n) => n.children));
    result.nodes.forEach((node, k) => {
      expect(Array.from(back.nodes[k].ev)).toEqual(Array.from(node.ev));
      node.strategy.forEach((x, j) => {
        expect(Math.abs(back.nodes[k].strategy[j] - x)).toBeLessThan(5e-5);
      });
    });
    // A structured clone (what postMessage does) keeps everything.
    expect(structuredClone(result)).toEqual(result);
  });

  it("refuses a blob that is not this layout and version", () => {
    const blob = encodeSolution(solveRiver(SMALL, { maxIterations: 5 }));
    const wrongMagic = blob.slice();
    wrongMagic[0] = 0;
    expect(() => decodeSolution(wrongMagic)).toThrow(SolutionFormatError);
    const text = new TextDecoder().decode(blob.subarray(12, 200));
    expect(text).toContain('"version":"solver/1"');
    const stale = blob.slice();
    const at = 12 + text.indexOf("solver/1") + "solver/".length;
    stale[at] = "0".charCodeAt(0);
    expect(() => decodeSolution(stale)).toThrow(/solver\/0/);
  });
});
