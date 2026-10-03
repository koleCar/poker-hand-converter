/**
 * The limp tree and the limp tremble (`charts/4`, phase A2d): open limps and
 * over-limps from every seat, isolation raises sized by the limpers, the caps
 * that keep the tree solvable, and the ε-perturbed solve that trains the
 * players facing a limp the equilibrium may never make.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  buildPreflopTree,
  classByName,
  FLAG_LIMPERS_CAP,
  NINE_MAX,
  NUM_CLASSES,
  PF_ACTION,
  PF_FLOP,
  preflopEquityTable,
  PreflopSolver,
  STANDARD_RAKE,
  type PreflopEquityTable,
} from "../../../frontend/src/lib/solver/index.js";

const H = NUM_CLASSES;
let table: PreflopEquityTable;
beforeAll(() => {
  table = preflopEquityTable({ boards: 2000, seed: 11 });
});

describe("the limp tree", () => {
  const tree = buildPreflopTree({ maxLimpers: 3 });
  const at = (line: string) => {
    const node = tree.lineIndex.get(line);
    expect(node, line).toBeDefined();
    return node as number;
  };
  const edges = (node: number) =>
    Array.from({ length: tree.childCount[node] }, (_, a) => ({
      code: tree.edgeCode[tree.childStart[node] + a],
      to: tree.edgeTo[tree.childStart[node] + a],
    }));

  it("leaves the charts/3 tree alone without maxLimpers", () => {
    const plain = buildPreflopTree();
    expect(plain.actionNodes).toBe(3825);
    expect(plain.maxLimpers).toBe(0);
    expect(buildPreflopTree({ players: NINE_MAX }).actionNodes).toBe(28591);
  });

  it("lets every seat but the big blind limp, first in or behind", () => {
    expect(edges(at("")).map((e) => e.code)).toEqual(["f", "c", "r"]);
    expect(edges(at(""))[1].to).toBe(1);
    // Behind a UTG limp: fold, over-limp, isolate.
    expect(edges(at("cff")).map((e) => e.code)).toEqual(["f", "c", "r"]);
    // The big blind behind limpers checks or raises; it never folds for free.
    expect(edges(at("cffff")).map((e) => e.code)).toEqual(["k", "r"]);
    expect(tree.actionNodes).toBeGreaterThan(3825);
  });

  it("sizes isolation raises by the limpers and the raiser's position", () => {
    // BTN over a UTG limp, in position: 4bb; over two limpers: 5bb.
    expect(edges(at("cff"))[2].to).toBe(4);
    expect(edges(at("cfc"))[2].to).toBe(5);
    // A blind isolating a non-blind limper is out of position: +1bb.
    expect(edges(at("fffc"))[2].to).toBe(5);
    expect(edges(at("fffcf"))[1].to).toBe(5);
    // The big blind over the small blind's limp is charts/3's 4bb.
    expect(edges(at("ffffc"))[1].to).toBe(4);
    // Three limpers (UTG, HJ, BTN), then the BB: 4 + 2 + 1 = 7bb.
    expect(edges(at("ccfcf"))[1].to).toBe(7);
  });

  it("re-raises an isolation 3x plus one per caller, and makes the next raise all-in", () => {
    // UTG limps, BTN isolates to 4, blinds fold: UTG limp-raises to 12.
    expect(edges(at("cffrff"))).toEqual([
      { code: "f", to: 1 },
      { code: "c", to: 4 },
      { code: "r", to: 12 },
    ]);
    // ... and the BTN's 4-bet is all-in behind an open limp.
    expect(edges(at("cffrffr")).map((e) => e.code)).toEqual(["f", "c", "a"]);
    // A caller of the isolation adds 1x: CO calls the BTN's iso, UTG re-raises to 16.
    expect(edges(at("cfcrffc"))[2].to).toBe(5 * 3 + 5);
  });

  it("caps the limpers at three, flagged, and counts them as entrants", () => {
    // UTG, HJ and CO limp: the BTN may not limp a fourth time.
    const fourth = at("ccc");
    expect(edges(fourth).map((e) => e.code)).toEqual(["f", "r"]);
    expect(tree.flags[fourth] & FLAG_LIMPERS_CAP).toBeTruthy();
    // Three limpers and an isolation are four entrants: the blinds only fold.
    const iso = tree.children[tree.childStart[fourth] + 1];
    expect(tree.line[iso]).toBe("cccrff");
    expect(tree.type[iso]).toBe(PF_ACTION);
    expect(tree.players[tree.actor[iso]]).toBe("UTG");
    // Three limpers and the big blind's check: a four-way limped pot.
    const check = tree.children[tree.childStart[at("cccff")]];
    expect(tree.type[check]).toBe(PF_FLOP);
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] === PF_ACTION) continue;
      let live = 0;
      for (let p = 0; p < 6; p += 1) if (tree.live[node] & (1 << p)) live += 1;
      expect(live).toBeLessThanOrEqual(4);
    }
  });
});

describe("the limp tremble", () => {
  const players = ["CO", "BTN", "SB", "BB"] as const;
  const solve = (limpFloor: number, iterations: number) => {
    const tree = buildPreflopTree({ players: [...players], stackBb: 30, maxLimpers: 2 });
    const solver = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE, limpFloor });
    solver.iterate(iterations);
    return { tree, solver };
  };

  it("limps every class at least ε at the non-blind seats' unopened nodes, and nowhere else", () => {
    const { tree, solver } = solve(0.01, 30);
    for (const line of ["", "f"]) {
      const node = tree.lineIndex.get(line) as number;
      const strat = solver.averageStrategy(node);
      for (let i = 0; i < H; i += 1) expect(strat[H + i]).toBeGreaterThanOrEqual(0.01 - 1e-12);
    }
    expect(solver.floorEdge[tree.lineIndex.get("ff") as number]).toBe(-1); // the SB completes freely
    expect(solver.floorEdge[tree.lineIndex.get("rf") as number]).toBe(-1); // facing a raise
  });

  it("trains the responses to a limp the equilibrium does not make", () => {
    const { tree, solver } = solve(0.005, 300);
    // The BTN facing a CO limp: AA isolates, 72o folds.
    const node = tree.lineIndex.get("c") as number;
    const strat = solver.averageStrategy(node);
    const iso = 2;
    const aa = classByName("AA");
    const seven2 = classByName("72o");
    expect(strat[iso * H + aa]).toBeGreaterThan(0.9);
    expect(strat[0 * H + seven2] + strat[1 * H + seven2]).toBeGreaterThan(0.5);
  });

  it("measures NashConv in the perturbed game, and converges in it", () => {
    const early = solve(0.005, 40).solver.exploitability();
    const late = solve(0.005, 400).solver.exploitability();
    expect(late.nashConvMbb).toBeLessThan(early.nashConvMbb);
    for (let p = 0; p < players.length; p += 1) {
      expect(late.bestResponse[p]).toBeGreaterThanOrEqual(late.value[p] - 1e-9);
    }
  });

  it("is deterministic, and the same as no tremble at ε = 0", () => {
    const a = solve(0.005, 20).solver;
    const b = solve(0.005, 20).solver;
    expect(Array.from(a.regrets)).toEqual(Array.from(b.regrets));
    const tree = buildPreflopTree({ players: [...players], stackBb: 30, maxLimpers: 2 });
    const plain = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE });
    const zero = new PreflopSolver({ tree, equity: table.equity, rake: STANDARD_RAKE, limpFloor: 0 });
    plain.iterate(15);
    zero.iterate(15);
    expect(Array.from(zero.strategySum)).toEqual(Array.from(plain.strategySum));
  });
});
