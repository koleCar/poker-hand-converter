/**
 * Turn + river: the chance node that deals the river. Kept to narrow ranges
 * and one size so it runs in CI time; the realistic timing is in the
 * benchmark script.
 */

import { describe, expect, it } from "vitest";

import {
  buildTurnGame,
  nodeAt,
  parseCombo,
  rangesAt,
  Solver,
  solveBuilt,
  solveTurn,
  type TurnSpot,
} from "../../../frontend/src/lib/solver/index.js";
import { naiveValues } from "../support/solverNaive.js";

const SPOT: TurnSpot = {
  board: ["Qs", "Jh", "7d", "4c"],
  ranges: ["QQ,77,AQs,KQs,QJs,JTs,98s,A5s,65s", "KK,JJ,44,AQo,KJs,T9s,86s,AsKs"],
  pot: 10,
  stack: 30,
  menus: [
    { bet: [0.75], raise: [], allIn: true },
    { bet: [0.75], raise: [], allIn: true },
  ],
  raiseCap: 1,
};

describe("turn + river", () => {
  it("deals every river card that is not on the board, and plays the river on", () => {
    const result = solveBuilt(buildTurnGame(SPOT), { maxIterations: 1 });
    const chance = nodeAt(result, "X-X");
    expect(result.nodes[chance].kind).toBe("chance");
    expect(result.nodes[chance].labels).toHaveLength(48);
    expect(result.nodes[chance].labels).not.toContain("Qs");
    const river = nodeAt(result, "X-X|2c|");
    expect(result.nodes[river]).toMatchObject({ kind: "action", street: "river", player: 0, pot: 10 });
    // After a called turn bet the river pot has grown.
    expect(result.nodes[nodeAt(result, "B7.5-C|2c|")].pot).toBeCloseTo(25, 9);
    // An all-in called on the turn runs the river out with no more betting.
    const runout = nodeAt(result, "A30-C");
    expect(result.nodes[runout].kind).toBe("chance");
    expect(result.nodes[runout].children.every((c) => c === -1)).toBe(true);
    // Hands holding the river card are gone from the river ranges.
    const [r0] = rangesAt(result, nodeAt(result, "X-X|As|"));
    const at = (code: string) => result.hands[0].indexOf(parseCombo(code));
    expect(r0[at("As5s")]).toBe(0);
    // Ah5h survives, narrowed only by its own check at the root.
    expect(r0[at("Ah5h")]).toBeCloseTo(result.nodes[0].strategy[at("Ah5h")], 6);
  });

  it("agrees with a naive pairwise evaluation through the chance node", () => {
    const built = buildTurnGame(SPOT);
    const solver = new Solver(built.game);
    solver.iterate(20);
    const fast = solver.exploitability();
    const slow = naiveValues(built, solver);
    for (const p of [0, 1]) {
      expect(fast.bestResponse[p]).toBeCloseTo(slow.bestResponse[p], 6);
      expect(fast.value[p]).toBeCloseTo(slow.value[p], 6);
    }
  });

  it("converges", () => {
    const result = solveTurn(SPOT, { maxIterations: 300, targetExploitability: 0.5 });
    expect(result.stoppedBy).toBe("target");
    expect(result.exploitabilityPct).toBeLessThanOrEqual(0.5);
    expect(result.value[0] + result.value[1]).toBeCloseTo(SPOT.pot, 6);
  });
});
