/**
 * The A5a turn speed-ups, each against the exact full tree:
 *
 * - **Suit isomorphism** deals one river card per class and reads the others
 *   back through a relabelling of the hands. It must be the same game: the
 *   isomorphic solve's strategy, spread over every river card, has exactly
 *   the exploitability and values the full tree computes for it.
 * - **Chance sampling** walks one stratum of river cards per iteration. It
 *   must be deterministic for a seed, exact in what it reports (best
 *   response always walks every card), and end within a small gap of the
 *   exact solve.
 * - **The coarse menu**: `allInMaxPot` leaves a deep shove out of the tree,
 *   and a turn-only result carries the turn and nothing below the river deal.
 *
 * Spots are small so this runs in CI time; `tests/scripts/solver-bench`
 * times realistic ones and measures the gaps there.
 */

import { describe, expect, it } from "vitest";

import {
  boardSymmetries,
  buildTurnGame,
  cardOrbit,
  comboCode,
  extract,
  NUM_COMBOS,
  parseCards,
  parseCombo,
  parseRange,
  permuteCombo,
  solveBuilt,
  Solver,
  solveTurn,
  spotSymmetries,
  symmetrize,
  type BetMenu,
  type BuiltSubgame,
  type TurnSpot,
} from "../../../frontend/src/lib/solver/index.js";
import { cardCode, cardIndex } from "../../../frontend/src/lib/equity/index.js";

const MENU: BetMenu = { bet: [0.75], raise: [], allIn: true };
// A two-tone turn: diamonds and clubs are off the board, so they are interchangeable.
const SPOT: TurnSpot = {
  board: ["Qs", "Jh", "7s", "4h"],
  ranges: ["QQ,77,AQs,KQs,QJs,JTs,98s,A5s,65s,KJo", "KK,JJ,44,AQo,KJs,T9s,86s,AK,A4s"],
  pot: 10,
  stack: 30,
  menus: [MENU, MENU],
  raiseCap: 1,
};

describe("suit symmetries of a spot", () => {
  it("finds the board's own symmetries", () => {
    expect(boardSymmetries(["Qs", "Jh", "7d", "4c"])).toHaveLength(1);
    // Two suits off the board: swap them.
    expect(boardSymmetries(["Qs", "Jh", "7s", "4h"])).toHaveLength(2);
    // Monotone: any relabelling of the other three.
    expect(boardSymmetries(["Qs", "Js", "7s", "4s"])).toHaveLength(6);
    // A pair whose two suits appear nowhere else: swap them.
    expect(boardSymmetries(["Ks", "Kh", "7d", "2c"])).toHaveLength(2);
    expect(boardSymmetries(["Ks", "Kh", "7s", "2c"])).toHaveLength(1);
  });

  it("keeps only the symmetries both ranges share, and symmetrises float noise away", () => {
    const board = ["Qs", "Jh", "7s", "4h"];
    const blind = parseRange("AA,AKs,T9s");
    expect(spotSymmetries(board, [blind, blind])).toHaveLength(2);
    // AdKd without AcKc: the swap is gone.
    const lopsided = parseRange("AA,AdKd");
    expect(spotSymmetries(board, [blind, lopsided])).toHaveLength(1);
    // Noise far below the tolerance keeps it, and symmetrize makes it exact.
    const noisy = Float64Array.from(blind);
    noisy[parseCombo("AdKd")] *= 1 + 1e-12;
    const group = spotSymmetries(board, [noisy, blind]);
    expect(group).toHaveLength(2);
    const exact = symmetrize(noisy, group);
    expect(exact[parseCombo("AdKd")]).toBe(exact[parseCombo("AcKc")]);
    let mass = 0;
    let before = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) {
      mass += exact[c];
      before += noisy[c];
    }
    expect(mass).toBeCloseTo(before, 12);
  });

  it("puts a card's orbit together", () => {
    const group = boardSymmetries(["Qs", "Js", "7s", "4s"]);
    expect(cardOrbit(cardIndex("2h"), group).map(cardCode)).toEqual(["2h", "2d", "2c"]);
    expect(cardOrbit(cardIndex("2s"), group).map(cardCode)).toEqual(["2s"]);
  });
});

/**
 * The full tree's average strategy, read off an isomorphic solve: a node
 * below a mirrored river card takes the strategy of the node below the card
 * that stands for it, hand by hand through the relabelling.
 */
function spreadOnto(full: BuiltSubgame, iso: BuiltSubgame, isoSolver: Solver, fullSolver: Solver) {
  const pathToIso = new Map<string, number>();
  iso.info.forEach((info, node) => {
    if (info) pathToIso.set(info.path, node);
  });
  const group = iso.isomorphism?.group ?? [[0, 1, 2, 3]];
  const reps = new Map<string, { rep: string; perm: number[] }>();
  for (const { card, mirrors } of iso.isomorphism?.classes ?? []) {
    reps.set(card, { rep: card, perm: [0, 1, 2, 3] });
    for (const other of mirrors) {
      const perm = group.find((p) => cardCode((cardIndex(other) & ~3) | p[cardIndex(other) & 3]) === card) as number[];
      reps.set(other, { rep: card, perm });
    }
  }
  const index = iso.combos.map((combos) => {
    const at = new Map<number, number>();
    combos.forEach((combo, i) => at.set(combo, i));
    return at;
  });
  let mirrored = 0;
  full.info.forEach((info, node) => {
    if (!info) return;
    const match = /\|([2-9TJQKA][shdc])\|/.exec(info.path);
    const { rep, perm } = match ? (reps.get(match[1]) as { rep: string; perm: number[] }) : { rep: "", perm: [0, 1, 2, 3] };
    const isoPath = match ? info.path.replace(`|${match[1]}|`, `|${rep}|`) : info.path;
    const isoNode = pathToIso.get(isoPath);
    if (isoNode === undefined) throw new Error(`no isomorphic node for ${info.path}`);
    if (match && rep !== match[1]) mirrored += 1;
    const player = full.game.tree.player[node];
    const source = isoSolver.averageStrategy(isoNode);
    const n = full.combos[player].length;
    const m = iso.combos[player].length;
    const count = full.game.tree.childCount[node];
    const out = new Float32Array(count * n);
    full.combos[player].forEach((combo, i) => {
      const j = index[player].get(permuteCombo(combo, perm)) as number;
      for (let a = 0; a < count; a += 1) out[a * n + i] = source[a * m + j];
    });
    fullSolver.setAverageStrategy(node, out);
  });
  return mirrored;
}

describe("river-card isomorphism", () => {
  it("deals one card per class and is exactly the full game", () => {
    const full = buildTurnGame(SPOT);
    const iso = buildTurnGame({ ...SPOT, isomorphism: true });
    expect(iso.isomorphism?.group).toHaveLength(2);
    // 44 river cards; the 22 diamonds and clubs (none on the board) pair up.
    expect(iso.isomorphism?.classes).toHaveLength(22 + 13);
    expect(iso.game.tree.size).toBeLessThan(full.game.tree.size);

    const isoSolver = new Solver(iso.game);
    isoSolver.iterate(25);
    const fullSolver = new Solver(full.game);
    const mirrored = spreadOnto(full, iso, isoSolver, fullSolver);
    expect(mirrored).toBeGreaterThan(0);

    const a = isoSolver.exploitability();
    const b = fullSolver.exploitability();
    for (const p of [0, 1]) {
      expect(a.bestResponse[p]).toBeCloseTo(b.bestResponse[p], 6);
      expect(a.value[p]).toBeCloseTo(b.value[p], 6);
    }
    // And per hand: the root EVs agree.
    const ea = isoSolver.evaluate();
    const eb = fullSolver.evaluate();
    for (const p of [0, 1]) {
      for (let i = 0; i < ea.rootEv[p].length; i += 1) expect(ea.rootEv[p][i]).toBeCloseTo(eb.rootEv[p][i], 5);
    }
  });

  it("finds no symmetry in a range that holds one suited combo but not its twin, and solves the full game", () => {
    const spot: TurnSpot = { ...SPOT, ranges: ["QQ,77,AdKd", SPOT.ranges[1]], isomorphism: true };
    const built = buildTurnGame(spot);
    expect(built.isomorphism).toBeUndefined();
    expect(built.game.mirrors).toBeUndefined();
  });

  it("gives an isomorphic board the same answer, relabelled", () => {
    // Swap hearts and diamonds everywhere: the same spot, spelled differently.
    const swap = (code: string) => code.replace(/h/g, "x").replace(/d/g, "h").replace(/x/g, "d");
    const relabelled: TurnSpot = {
      ...SPOT,
      board: (SPOT.board as string[]).map(swap),
      isomorphism: true,
    };
    const a = solveTurn({ ...SPOT, isomorphism: true }, { maxIterations: 30, targetExploitability: 0, nodes: "turn" });
    const b = solveTurn(relabelled, { maxIterations: 30, targetExploitability: 0, nodes: "turn" });
    expect(b.exploitabilityPct).toBeCloseTo(a.exploitabilityPct, 6);
    const root = 0;
    const perm = [0, 2, 1, 3];
    const n = a.hands[0].length;
    a.hands[0].forEach((combo, i) => {
      const j = b.hands[0].indexOf(permuteCombo(combo, perm));
      expect(j, comboCode(combo)).toBeGreaterThanOrEqual(0);
      for (let k = 0; k < a.nodes[root].actions.length; k += 1) {
        expect(b.nodes[root].strategy[k * n + j]).toBeCloseTo(a.nodes[root].strategy[k * n + i], 5);
      }
    });
  });
});

describe("chance sampling", () => {
  const sampled = { groups: 4, seed: 7 };

  it("is deterministic for a seed, and reports an exact exploitability", () => {
    const built = buildTurnGame(SPOT);
    const one = solveBuilt(built, { maxIterations: 40, targetExploitability: 0, sampling: sampled, nodes: "turn" });
    const two = solveBuilt(buildTurnGame(SPOT), { maxIterations: 40, targetExploitability: 0, sampling: sampled, nodes: "turn" });
    expect(two.nodes[0].strategy).toEqual(one.nodes[0].strategy);
    expect(two.exploitabilityPct).toBe(one.exploitabilityPct);
    expect(one.samplingGroups).toBe(4);
    const other = solveBuilt(buildTurnGame(SPOT), {
      maxIterations: 40,
      targetExploitability: 0,
      sampling: { groups: 4, seed: 8 },
      nodes: "turn",
    });
    expect(other.nodes[0].strategy).not.toEqual(one.nodes[0].strategy);

    // The reported number is the full tree's: a fresh, unsampled solver
    // holding the same average strategy measures the same.
    const solver = new Solver(built.game, {}, { sampling: sampled });
    solver.iterate(40);
    const exact = new Solver(built.game);
    for (let node = 0; node < built.game.tree.size; node += 1) {
      if (built.game.tree.type[node] === 0) exact.setAverageStrategy(node, solver.averageStrategy(node));
    }
    expect(exact.exploitability().nashConv).toBeCloseTo(solver.exploitability().nashConv, 6);
  });

  it("ends within a small gap of the exact solve", () => {
    const exact = solveTurn(SPOT, { maxIterations: 400, targetExploitability: 0.3, nodes: "turn" });
    const run = solveTurn(SPOT, { maxIterations: 600, targetExploitability: 0.5, checkEvery: 20, sampling: sampled, nodes: "turn" });
    expect(run.stoppedBy).toBe("target");
    expect(run.exploitabilityPct).toBeLessThanOrEqual(0.5);
    // Values of the game agree to within the two exploitabilities.
    const gap = (Math.abs(run.value[0] - exact.value[0]) / SPOT.pot) * 100;
    expect(gap).toBeLessThan(run.exploitabilityPct + exact.exploitabilityPct + 0.1);
  });

  it("stops sampling after `until`", () => {
    const built = buildTurnGame(SPOT);
    const a = new Solver(built.game, {}, { sampling: { groups: 4, seed: 1, until: 8 } });
    a.iterate(8);
    const regretsAt8 = Float32Array.from(a.regrets);
    a.iterate(1);
    // An unsampled iteration touches every river subtree.
    let touched = 0;
    for (let k = 0; k < a.regrets.length; k += 1) if (a.regrets[k] !== regretsAt8[k]) touched += 1;
    const b = new Solver(built.game, {}, { sampling: { groups: 4, seed: 1 } });
    b.iterate(8);
    const before = Float32Array.from(b.regrets);
    b.iterate(1);
    let touchedSampled = 0;
    for (let k = 0; k < b.regrets.length; k += 1) if (b.regrets[k] !== before[k]) touchedSampled += 1;
    expect(touched).toBeGreaterThan(touchedSampled * 2);
  });
});

describe("the coarse turn menu and the turn-only result", () => {
  it("offers the all-in only up to allInMaxPot pots", () => {
    const capped: BetMenu = { bet: [0.75], raise: [0.75], allIn: true, allInMaxPot: 3 };
    const deep = buildTurnGame({ ...SPOT, stack: 90, menus: [capped, capped] });
    const rootDeep = deep.info[deep.game.tree.root];
    expect(rootDeep?.actions.map((a) => a.kind)).toEqual(["check", "bet"]);
    const shallow = buildTurnGame({ ...SPOT, stack: 25, menus: [capped, capped] });
    const rootShallow = shallow.info[shallow.game.tree.root];
    expect(rootShallow?.actions.map((a) => a.kind)).toEqual(["check", "bet", "allin"]);
  });

  it("stops a turn-only result at the river deal, with the same turn numbers", () => {
    const built = buildTurnGame({ ...SPOT, isomorphism: true });
    const solver = new Solver(built.game);
    const run = solver.run({ maxIterations: 20, targetExploitability: 0 });
    const all = extract(built, solver, run, "all");
    const turn = extract(built, solver, run, "turn");
    expect(turn.scope).toBe("turn");
    expect(turn.nodes.length).toBeLessThan(all.nodes.length / 10);
    for (const node of turn.nodes) {
      if (node.kind === "action") expect(node.street).toBe("turn");
      else expect(node.children.every((c) => c === -1)).toBe(true);
      const twin = all.nodes.find((x) => x.path === node.path && x.kind === node.kind)!;
      expect(Array.from(node.strategy)).toEqual(Array.from(twin.strategy));
      expect(Array.from(node.ev)).toEqual(Array.from(twin.ev));
    }
  });

  it("keeps the board and hands it was given", () => {
    const built = buildTurnGame({ ...SPOT, isomorphism: true });
    expect(built.board).toEqual(parseCards(SPOT.board));
    expect(built.combos[0].length).toBeGreaterThan(0);
  });
});
