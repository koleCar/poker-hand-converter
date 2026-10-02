/**
 * Solver benchmark: realistic river and turn+river spots, timed to a target
 * exploitability. `npm run bench:solver` from `tests/`.
 *
 * It asserts only that each solve reaches its target, so a regression in
 * convergence fails loudly; the times are printed, not asserted, because they
 * describe the machine. Ranges are a big-blind-defence-like range against a
 * button-like range on a dry board, plus a wider pair for the ~600-combo case.
 * Amounts are in big blinds.
 */

import { describe, expect, it } from "vitest";

import {
  encodeSolution,
  parseCards,
  parseRange,
  rangeSize,
  solveRiver,
  solveTurn,
  type BetMenu,
  type SolveResult,
  type SpotInput,
} from "../../../frontend/src/lib/solver/index.js";

const BB_DEF =
  "TT-22,AJs-A2s,KJs-K5s,QJs-Q8s,JTs-J8s,T9s-T7s,98s-96s,87s-85s,76s-75s,65s-64s,54s,AJo-A8o,KJo-K9o,QJo-Q9o,JTo-J9o,T9o";
const BTN = "AA-22,AKs-A2s,KQs-K8s,QJs-Q9s,JTs-J9s,T9s,98s,87s,76s,65s,AKo-ATo,KQo-KTo,QJo";
const WIDE_OOP = "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K7o+,Q8o+,J8o+,T8o+,98o";
const WIDE_IP = "22+,A2s+,K5s+,Q7s+,J7s+,T7s+,97s+,86s+,75s+,64s+,54s,A5o+,K9o+,Q9o+,J9o+,T9o";

const two: BetMenu = { bet: [0.33, 0.75], raise: [0.75], allIn: true };
const three: BetMenu = { bet: [0.33, 0.75, 1.5], raise: [0.6, 1.2], allIn: true };
const one: BetMenu = { bet: [0.75], raise: [0.75], allIn: true };

interface Case {
  name: string;
  street: "river" | "turn";
  spot: SpotInput;
  target: number;
  maxIterations: number;
}

const RIVER = ["Qs", "Jh", "7d", "4c", "2s"];
const TURN = RIVER.slice(0, 4);

const cases: Case[] = [
  {
    name: "river, 2 sizes + all-in",
    street: "river",
    spot: { board: RIVER, ranges: [BB_DEF, BTN], pot: 20, stack: 80, menus: [two, two], raiseCap: 2 },
    target: 0.5,
    maxIterations: 2000,
  },
  {
    name: "river, 2 sizes + all-in, to 0.1%",
    street: "river",
    spot: { board: RIVER, ranges: [BB_DEF, BTN], pot: 20, stack: 80, menus: [two, two], raiseCap: 2 },
    target: 0.1,
    maxIterations: 4000,
  },
  {
    name: "river, 3 sizes + 2 raises + all-in, cap 3",
    street: "river",
    spot: { board: RIVER, ranges: [BB_DEF, BTN], pot: 20, stack: 80, menus: [three, three], raiseCap: 3 },
    target: 0.5,
    maxIterations: 2000,
  },
  {
    name: "river, ~600 combos a side, 3 sizes",
    street: "river",
    spot: {
      board: RIVER,
      ranges: [WIDE_OOP, WIDE_IP],
      pot: 12,
      stack: 94,
      menus: [three, three],
      raiseCap: 3,
      rake: { percent: 0.05, cap: 3 },
    },
    target: 0.5,
    maxIterations: 2000,
  },
  {
    name: "turn+river, 1 size + all-in",
    street: "turn",
    spot: { board: TURN, ranges: [BB_DEF, BTN], pot: 10, stack: 90, menus: [one, one], raiseCap: 1 },
    target: 0.5,
    maxIterations: 1000,
  },
  {
    name: "turn+river, 2 sizes + all-in",
    street: "turn",
    spot: { board: TURN, ranges: [BB_DEF, BTN], pot: 10, stack: 90, menus: [two, two], raiseCap: 2 },
    target: 0.5,
    maxIterations: 1000,
  },
];

function row(c: Case, result: SolveResult, ms: number) {
  const board = parseCards(c.spot.board);
  return {
    case: c.name,
    combos: `${rangeSize(parseRange(c.spot.ranges[0] as string), board).toFixed(0)} v ${rangeSize(
      parseRange(c.spot.ranges[1] as string),
      board,
    ).toFixed(0)}`,
    nodes: result.nodes.length,
    iterations: result.iterations,
    "expl %pot": Number(result.exploitabilityPct.toFixed(3)),
    "expl mbb": Number(result.exploitabilityMbb.toFixed(1)),
    ms: Math.round(ms),
    "ms/iter": Number((ms / result.iterations).toFixed(2)),
    "solver MB": Number((result.memoryBytes / 1e6).toFixed(1)),
    // Typed arrays live outside the V8 heap, so the process's resident set is
    // the honest number - cumulative over the run, so read it as a ceiling.
    "rss MB": Math.round(process.memoryUsage().rss / 1e6),
    "blob KB": Math.round(encodeSolution(result).length / 1024),
  };
}

describe("solver benchmark", () => {
  it("solves every case to its target", () => {
    const rows = [];
    // Warm the JIT so the first timed case is not paying for compilation.
    solveRiver(cases[0].spot, { maxIterations: 50, targetExploitability: 0 });
    for (const c of cases) {
      const t0 = performance.now();
      const result =
        c.street === "river"
          ? solveRiver(c.spot, { maxIterations: c.maxIterations, targetExploitability: c.target })
          : solveTurn(c.spot, { maxIterations: c.maxIterations, targetExploitability: c.target });
      const ms = performance.now() - t0;
      rows.push(row(c, result, ms));
      expect(result.exploitabilityPct, c.name).toBeLessThanOrEqual(c.target);
    }
    console.table(rows);
  });
});
