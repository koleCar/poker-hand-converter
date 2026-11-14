/**
 * The real line onto a solved tree (§3.3, analysis/38): a size either player
 * took that the solve takes under `MIN_LINE_REACH` of the time is remapped to
 * the nearest size it takes at least that often - the hero's own earlier
 * sizes too, not only the opponent's (before: the opponent's, under 1%). An
 * edge that rare can only end the line `*-unreached`, so no line that reached
 * its node before moves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { followLine, MIN_LINE_REACH, solveRiverSpot, type RiverAct, type RiverSolve } from "../../web/src/lib/analysis/index.js";
import { loadCharts } from "../../web/src/lib/charts/index.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import { parseCards, parseRange, type SolvedNode, type SolveResult } from "../../web/src/lib/solver/index.js";
import { fileOf as chartFile } from "./charts/support.js";

const CHARTS = loadCharts(JSON.parse(readFileSync(chartFile("nlhe-cash-6max-100bb"), "utf8")));

/* ---------------------------------------------- a tree built by hand - */

type Edge = { label: string; kind: "fold" | "check" | "call" | "bet" | "raise" | "allin"; sizePot?: number; freq: number };

/**
 * A one-street tree with one combo per player, so a node's `frequency` is the
 * strategy and a line's reach is the product of its edges' frequencies. The
 * root is player 0's; every edge of it leads to a player-1 node with `reply`.
 */
function tree(root: Edge[], reply: Edge[], pot = 10): SolveResult {
  const node = (index: number, player: 0 | 1, path: string, parent: number, parentEdge: number, edges: Edge[], children: number[]): SolvedNode => ({
    kind: "action",
    player,
    street: "river",
    path,
    parent,
    parentEdge,
    pot,
    toCall: 0,
    behind: 50,
    labels: edges.map((e) => e.label),
    actions: edges.map((e) => ({ label: e.label, kind: e.kind, amount: (e.sizePot ?? 0) * pot, to: (e.sizePot ?? 0) * pot, sizePot: e.sizePot ?? 0 })),
    children,
    strategy: Float32Array.from(edges.map((e) => e.freq)),
    ev: new Float32Array(edges.length),
    frequency: edges.map((e) => e.freq),
  });
  const nodes: SolvedNode[] = [node(0, 0, "", -1, 0, root, root.map((_, e) => e + 1))];
  root.forEach((e, i) => nodes.push(node(i + 1, 1, e.label, 0, i, reply, reply.map(() => -1))));
  return {
    street: "river",
    board: [],
    pot,
    stack: 50,
    firstToAct: 0,
    hands: [Uint16Array.of(0), Uint16Array.of(1)],
    weights: [Float32Array.of(1), Float32Array.of(1)],
    nodes,
  } as unknown as SolveResult;
}

const bet = (seat: number, sizePot: number): RiverAct => ({ index: 1, seat, type: "bet", to: sizePot * 10, allIn: false, pot: 10, toCall: 0, sizePot });
const FOLD_CALL: Edge[] = [
  { label: "F", kind: "fold", freq: 0.5 },
  { label: "C", kind: "call", freq: 0.5 },
];
const rootWith = (b75: number): Edge[] => [
  { label: "X", kind: "check", freq: 0.6 - b75 },
  { label: "B3.3", kind: "bet", sizePot: 0.33, freq: 0.1 },
  { label: "B7.5", kind: "bet", sizePot: 0.75, freq: b75 },
  { label: "B15", kind: "bet", sizePot: 1.5, freq: 0.3 },
];
// The hero is player 1 (in position), facing the opponent's bet.
const facing = (result: SolveResult) =>
  ({ result, hero: 1, input: { heroFirst: false, heroSeat: 2, villainSeat: 1, stackBb: 50 } }) as unknown as RiverSolve;

describe("an opponent's size the solve takes under MIN_LINE_REACH", () => {
  it("is remapped to the nearest size taken at least that often (1% to 2%: unreached before analysis/38)", () => {
    // A pot-size bet translates to 75% (the likelier side), taken 1.5% of the time.
    const line = followLine(facing(tree(rootWith(0.015), FOLD_CALL)), [bet(1, 1)]);
    expect(line.ok).toBe(true);
    if (!line.ok) return;
    expect(line.node).toBe(4); // B15: 0.5 pots away; 33% is 0.67 away.
    expect(line.distance).toBeCloseTo(0.5, 10);
    expect(line.reach.villain).toBeCloseTo(0.3, 6);
  });

  it("keeps a size the solve takes at least that often, and the line it reaches", () => {
    const line = followLine(facing(tree(rootWith(0.03), FOLD_CALL)), [bet(1, 1)]);
    expect(line.ok).toBe(true);
    if (!line.ok) return;
    expect(line.node).toBe(3); // B7.5
    expect(line.distance).toBeCloseTo(0.25, 10);
    expect(line.reach.villain).toBeCloseTo(0.03, 6);
    expect(line.reach.villain).toBeGreaterThanOrEqual(MIN_LINE_REACH);
  });

  it("stays unreached when the solve takes no size that often", () => {
    const root: Edge[] = [
      { label: "X", kind: "check", freq: 0.97 },
      { label: "B3.3", kind: "bet", sizePot: 0.33, freq: 0.01 },
      { label: "B7.5", kind: "bet", sizePot: 0.75, freq: 0.015 },
      { label: "B15", kind: "bet", sizePot: 1.5, freq: 0.005 },
    ];
    const line = followLine(facing(tree(root, FOLD_CALL)), [bet(1, 1)]);
    expect(line.ok).toBe(false);
    if (!line.ok) expect(line.reason).toBe("river-unreached");
  });
});

/* ------------------------------------------------ a real solve - */

describe("the hero's own earlier size", { timeout: 120_000 }, () => {
  // Out of position, the hero's range bets 33% about 15% of the time and 75%
  // under 1%; against 33% the opponent's sets raise all-in about a third of the time.
  const solve = solveRiverSpot({
    hand: {} as PhfHand,
    heroSeat: 1,
    villainSeat: 2,
    heroFirst: true,
    heroCards: [parseCards(["Ah"])[0], parseCards(["Kc"])[0]],
    board: parseCards(["Ks", "Qd", "7h", "4c", "2s"]),
    potBb: 10,
    stackBb: 50,
    ranges: { hero: parseRange("AK, KQ, KJ, QJ, 65s, J9s, 98s"), villain: parseRange("77, 44, 22, TT, 99, 88, AQ, KT") },
    charts: CHARTS,
    model: "test",
    key: { players: 6, stackBucket: "100bb", preflopLine: "srp", positions: ["BB", "BTN"] },
  }) as RiverSolve;

  it("is remapped like the opponent's when the solve (almost) never takes it", () => {
    expect(solve.ok).toBe(true);
    const root = solve.result.nodes[0];
    const freq = (label: string) => root.frequency[root.labels.indexOf(label)];
    expect(freq("B7.5")).toBeLessThan(MIN_LINE_REACH);
    expect(freq("B3.3")).toBeGreaterThanOrEqual(MIN_LINE_REACH);
    // The hero bets 60% (translates to 75%, the likelier side) and is shoved on.
    const shove = solve.result.nodes[root.children[root.labels.indexOf("B3.3")]];
    const allIn = shove.actions.findIndex((a) => a.kind === "allin");
    expect(shove.frequency[allIn]).toBeGreaterThanOrEqual(MIN_LINE_REACH);
    const acts: RiverAct[] = [
      { index: 1, seat: 1, type: "bet", to: 6, allIn: false, pot: 10, toCall: 0, sizePot: 0.6 },
      { index: 2, seat: 2, type: "raise", to: 50, allIn: true, pot: 16, toCall: 6, sizePot: 44 / 22 },
    ];
    const line = followLine(solve, acts);
    expect(line.ok).toBe(true);
    if (!line.ok) return;
    expect(solve.result.nodes[line.node].path).toBe("B3.3-A50");
    expect(line.distance).toBeCloseTo(0.27, 6);
    expect(line.reach.hero).toBeGreaterThanOrEqual(MIN_LINE_REACH);
  });

  it("keeps a size the solve takes", () => {
    const acts: RiverAct[] = [
      { index: 1, seat: 1, type: "bet", to: 3.3, allIn: false, pot: 10, toCall: 0, sizePot: 0.33 },
      { index: 2, seat: 2, type: "raise", to: 50, allIn: true, pot: 13.3, toCall: 3.3, sizePot: 46.7 / 16.6 },
    ];
    const line = followLine(solve, acts);
    expect(line.ok).toBe(true);
    if (line.ok) {
      expect(solve.result.nodes[line.node].path).toBe("B3.3-A50");
      expect(line.distance).toBe(0);
    }
  });
});
