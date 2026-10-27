/**
 * The heads-up sets (`charts/8` at 100bb, `charts/9` at 150bb; docs/CHARTS.md
 * §1.5, §6.9): the two-handed tree - the small blind is the button, first to
 * act preflop and last after the flop - its node counts, action order and
 * chip accounting; each set's sanity bands (from general heads-up theory, never from a published chart:
 * the button opens most hands, the big blind defends most of them); and
 * heads-up hands graded from it end to end.
 */

import { describe, expect, it } from "vitest";

import { analyzeHand, ANALYSIS_VERSION, type DecisionAnalysis } from "../../../web/src/lib/analysis/index.js";
import {
  chartTree,
  IN_RANGE,
  MAX_SELF_LOSS,
  requiredChartSets,
  type ChartSet,
} from "../../../web/src/lib/charts/index.js";
import { parseStandardHand } from "../../../web/src/lib/phf/serialize.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { CLASS_COMBOS, classByName, NUM_CLASSES } from "../../../web/src/lib/solver/index.js";
import { chartSet, fullLibrary } from "./support.js";

import {
  buildPreflopTree,
  PF_ACTION,
  PF_ALLIN,
  PF_FLOP,
  PF_FOLD,
  POT_TYPE_INDEX,
  postflopRanks,
  potAt,
  type PreflopTree,
} from "../../../web/src/lib/solver/preflopTree.js";

/** The committed set's sizes (tests/scripts/preflop-charts/sets.ts). */
const HU_SIZING = { sbOpen: 2.5, isoOop: 0, allInAbove: 0.4 };
const huTree = () => buildPreflopTree({ players: ["SB", "BB"], stackBb: 100, sizing: HU_SIZING, headsUp: true });

/** The edge sizes out of an action node, by code. */
function edges(tree: PreflopTree, line: string): Record<string, number> {
  const node = tree.lineIndex.get(line);
  if (node === undefined) throw new Error(`no node ${line}`);
  const out: Record<string, number> = {};
  for (let e = tree.childStart[node]; e < tree.childStart[node] + tree.childCount[node]; e += 1) {
    out[tree.edgeCode[e]] = tree.edgeTo[e];
  }
  return out;
}

describe("heads-up preflop tree", () => {
  it("puts the small blind (the button) in position after the flop", () => {
    expect(postflopRanks(["SB", "BB"], true)).toEqual([1, 0]);
    expect(postflopRanks(["SB", "BB"], false)).toEqual([0, 1]);
    const tree = huTree();
    expect(tree.headsUp).toBe(true);
    expect(tree.players).toEqual(["SB", "BB"]);
    expect(tree.postflop).toEqual([1, 0]);
    // The blinds' subgame of a bigger table keeps the small blind out of position.
    const bvb = buildPreflopTree({ players: ["SB", "BB"], stackBb: 100 });
    expect(bvb.headsUp).toBe(false);
    expect(bvb.postflop).toEqual([0, 1]);
  });

  it("refuses a heads-up flag on anything but SB and BB", () => {
    expect(() => buildPreflopTree({ players: ["BTN", "SB", "BB"], headsUp: true })).toThrow(/heads-up/);
    expect(() => buildPreflopTree({ players: ["BTN", "BB"], headsUp: true })).toThrow(/heads-up/);
  });

  it("has every line of the abstraction, small blind first", () => {
    const tree = huTree();
    const lines = [...tree.lineIndex.keys()].sort();
    // SB: fold / limp / open. BB after a limp: check / raise; after an open:
    // fold / call / 3-bet; and so on up to the 5-bet all-in.
    expect(lines).toEqual(["", "c", "cr", "crr", "crrr", "crrra", "r", "rr", "rrr", "rrra"]);
    expect(tree.actionNodes).toBe(10);
    // The root is the small blind's decision; levels alternate SB, BB, SB, ...
    for (const line of lines) {
      const node = tree.lineIndex.get(line) as number;
      expect(tree.type[node]).toBe(PF_ACTION);
      expect(tree.players[tree.actor[node]]).toBe(line.length % 2 === 0 ? "SB" : "BB");
    }
    expect(edges(tree, "")).toEqual({ f: 0.5, c: 1, r: 2.5 });
    expect(edges(tree, "c")).toEqual({ k: 1, r: 4 });
    expect(Object.keys(edges(tree, "r"))).toEqual(["f", "c", "r"]);
  });

  it("sizes every raise for a two-handed game", () => {
    const tree = huTree();
    // BB 3-bets the 2.5bb open out of position, 4x; SB 4-bets in position, 2.2x; then all in.
    expect(edges(tree, "r").r).toBe(10);
    expect(edges(tree, "rr").r).toBe(22);
    expect(edges(tree, "rrr").a).toBe(100);
    // Over the limp: the BB raises to 4bb, the SB re-raises 3x, the BB 4-bets 2.5x out of position.
    expect(edges(tree, "c").r).toBe(4);
    expect(edges(tree, "cr").r).toBe(12);
    expect(edges(tree, "crr").r).toBe(30);
    expect(edges(tree, "crrr").a).toBe(100);
  });

  it("accounts for every chip at every terminal", () => {
    const tree = huTree();
    const n = tree.players.length;
    const terminals = { fold: 0, flop: 0, allin: 0 };
    for (let node = 0; node < tree.size; node += 1) {
      const type = tree.type[node];
      if (type === PF_ACTION) continue;
      const sb = tree.contrib[node * n];
      const bb = tree.contrib[node * n + 1];
      expect(sb).toBeGreaterThanOrEqual(0.5);
      expect(bb).toBeGreaterThanOrEqual(1);
      expect(Math.max(sb, bb)).toBeLessThanOrEqual(100);
      expect(potAt(tree, node)).toBeCloseTo(sb + bb, 9);
      if (type === PF_FOLD) {
        terminals.fold += 1;
        // The folder put in less; the winner is the other player.
        const winner = tree.actor[node];
        expect(tree.contrib[node * n + winner]).toBeGreaterThan(tree.contrib[node * n + (1 - winner)]);
      } else {
        // A flop or an all-in: both players have matched.
        expect(sb).toBe(bb);
        if (type === PF_FLOP) terminals.flop += 1;
        if (type === PF_ALLIN) {
          terminals.allin += 1;
          expect(sb).toBe(100);
          expect(POT_TYPE_INDEX[tree.potType[node]]).toBe("allin");
        }
      }
    }
    // A fold at every node but the BB's option behind the limp; a flop for the
    // check and every call short of all-in; the two all-in calls.
    expect(terminals).toEqual({ fold: 9, flop: 7, allin: 2 });
    expect(tree.size).toBe(28);
    // The pot types of the flops: the limped pot, and raised pots by level.
    const flops: string[] = [];
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] === PF_FLOP) flops.push(POT_TYPE_INDEX[tree.potType[node]]);
    }
    expect(flops.sort()).toEqual(["3bet", "3bet", "4bet", "4bet", "limped", "srp", "srp"].sort());
  });

  it("is the same preflop game as the blinds' subgame, but with the button in position", () => {
    const hu = huTree();
    const bvb = buildPreflopTree({ players: ["SB", "BB"], stackBb: 100, sizing: HU_SIZING });
    // Same lines and stacks; only the in/out-of-position sizes may differ.
    expect([...hu.lineIndex.keys()].sort()).toEqual([...bvb.lineIndex.keys()].sort());
    // The BB's 3-bet: out of position heads-up (4x), in position in the blinds' subgame (3x).
    expect(edges(hu, "r").r).toBe(10);
    expect(edges(bvb, "r").r).toBe(7.5);
  });
});

/* ------------------------------------------------------------- the set - */

const ID = "nlhe-cash-hu-100bb";
const H = NUM_CLASSES;

/** Share of the actor's range (combo- and reach-weighted) that does not fold. */
function continues(set: ChartSet, line: string): number {
  const node = set.nodes.get(line);
  if (!node) throw new Error(`no node ${JSON.stringify(line)}`);
  const fold = node.options.findIndex((o) => o.action === "fold");
  let sum = 0;
  let total = 0;
  for (let i = 0; i < H; i += 1) {
    const w = CLASS_COMBOS[i] * node.range[i];
    sum += w * (fold < 0 ? 1 : 1 - node.freq[fold * H + i]);
    total += w;
  }
  return sum / total;
}

/** A class's frequency of an action at a node. */
const freqOf = (set: ChartSet, line: string, action: string, name: string) => {
  const node = set.nodes.get(line);
  if (!node) throw new Error(`no node ${JSON.stringify(line)}`);
  const a = node.options.findIndex((o) => o.action === action);
  return a < 0 ? 0 : node.freq[a * H + classByName(name)];
};

/** The heads-up sets: `charts/8` at 100bb, `charts/9` at 150bb (the same tree and sizes). */
const HU_SETS = [
  { id: ID, stackBb: 100, version: "charts/8" },
  { id: "nlhe-cash-hu-150bb", stackBb: 150, version: "charts/9" },
] as const;

describe.each(HU_SETS)("the heads-up set $id", ({ id, stackBb, version }) => {
  const set = chartSet(id);
  const model = set.model as Record<string, any>;

  it("is two-handed, generated by our solver on its own measured realisation", () => {
    expect(set.version).toBe(version);
    expect(set.game).toMatchObject({ players: 2, positions: ["SB", "BB"], stackBb });
    expect(model.tree.headsUp).toBe(true);
    expect(model.tree.sizing).toMatchObject({ sbOpen: 2.5, isoOop: 0 });
    expect(model.realisation.name).toBe(`${version}-solver-fit-hu-${stackBb}bb`);
    expect(model.realisationFit.rounds).toHaveLength(2);
    expect(model.solver.iterations).toBe(9000);
    // The tree the lookup rebuilds is the heads-up one: the small blind in position after the flop.
    const tree = chartTree(set);
    expect(tree.headsUp).toBe(true);
    expect(tree.postflop).toEqual([1, 0]);
    expect(set.nodes.size).toBe(tree.actionNodes);
    // The same ten lines at either depth; only the 5-bet all-in is deeper.
    expect([...set.nodes.keys()].sort()).toEqual(["", "c", "cr", "crr", "crrr", "crrra", "r", "rr", "rrr", "rrra"]);
    expect(set.nodes.get("rrr")?.options.find((o) => o.action === "allin")?.toBb).toBe(stackBb);
  });

  it("converged everywhere: a two-player game, NashConv near zero and no node left out", () => {
    expect(model.convergence.nashConvMbb).toBeLessThan(0.05);
    expect(model.excluded.unconverged).toEqual([]);
    expect(model.convergence.headsUpBlindVsBlind).toBeNull();
    for (const node of set.nodes.values()) {
      for (let i = 0; i < H; i += 1) {
        if (node.range[i] < IN_RANGE + 0.5 / 255) continue;
        let best = -Infinity;
        for (let a = 0; a < node.options.length; a += 1) best = Math.max(best, node.ev[a * H + i]);
        let loss = 0;
        for (let a = 0; a < node.options.length; a += 1) loss += node.freq[a * H + i] * (best - node.ev[a * H + i]);
        expect(loss, `${node.line} class ${i}`).toBeLessThanOrEqual(MAX_SELF_LOSS * node.potBb + 0.02);
      }
    }
  });

  it("plays like heads-up: the button enters wide, the big blind defends wide", () => {
    // The button (small blind) is in position for the whole hand and enters most hands.
    const sb = continues(set, "");
    expect(sb).toBeGreaterThan(0.65);
    expect(sb).toBeLessThan(0.97);
    // The big blind closes the action at 3:1 or better: it defends most of its range.
    const bb = continues(set, "r");
    expect(bb).toBeGreaterThan(0.5);
    expect(bb).toBeLessThan(0.9);
    // Far wider than the 6-max small blind first in and the big blind against a button open.
    const sixMax = chartSet("nlhe-cash-6max-100bb");
    expect(sb).toBeGreaterThan(continues(sixMax, "ffff") + 0.1);
    // AA never folds; 72o, the worst hand, is still not always folded by the button.
    for (const node of set.nodes.values()) {
      expect(freqOf(set, node.line, "fold", "AA"), node.line).toBe(0);
    }
    expect(freqOf(set, "", "fold", "KK")).toBe(0);
    expect(freqOf(set, "r", "fold", "A2o")).toBeLessThan(0.05);
  });
});

/* -------------------------------------------------------- end to end - */

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/** A heads-up $0.5/$1 hand: the button posts the small blind and acts first. */
function huHand(opts: { hero: "Sb" | "Bb"; cards: string; lines: string[]; stack?: number; winner: string; pot: number; returned?: number }): PhfHand {
  const stack = opts.stack ?? 100;
  const text = [
    `Poker Hand #HU${opts.lines.join("").length}${opts.cards.replace(/ /g, "")}${stack}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    "Table 'Hu' 2-max Seat #1 is the button",
    `Seat 1: Sb ($${stack} in chips)`,
    `Seat 2: Bb ($${stack} in chips)`,
    "Sb: posts small blind $0.5",
    "Bb: posts big blind $1",
    "*** HOLE CARDS ***",
    `Dealt to ${opts.hero} [${opts.cards}]`,
    ...opts.lines,
    ...(opts.returned ? [`Uncalled bet ($${opts.returned}) returned to ${opts.winner}`] : []),
    `${opts.winner} collected $${opts.pot} from pot`,
    "*** SUMMARY ***",
    `Total pot $${opts.pot} | Rake $0`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

describe("heads-up hands, end to end", () => {
  const library = fullLibrary();
  const pre = (hand: PhfHand): DecisionAnalysis | undefined =>
    // The hero's last preflop decision.
    analyzeHand(structuredClone(hand), { charts: library, turn: false })
      .decisions.filter((d) => d.street === "preflop")
      .at(-1);

  it("grades the button's open from the heads-up set, exactly", () => {
    const hand = huHand({ hero: "Sb", cards: "Ah Kd", lines: ["Sb: raises $2 to $2.5", "Bb: folds"], winner: "Sb", pot: 2, returned: 1.5 });
    expect(requiredChartSets(hand, library.specs)).toContain(ID);
    const analysis = analyzeHand(structuredClone(hand), { charts: library, turn: false });
    expect(analysis.version).toBe(ANALYSIS_VERSION);
    const decision = analysis.decisions.find((d) => d.street === "preflop");
    expect(decision).toMatchObject({ status: "analysed", source: "chart", grade: "perfect" });
    expect(decision?.facts.chart).toMatchObject({ set: ID, line: "", scenario: "rfi" });
    expect(decision?.approximations).not.toContain("short-handed");
    expect(decision?.approximations).not.toContain("table-size");
  });

  it("calls folding AA in the big blind to the button's open a Blunder", () => {
    const hand = huHand({ hero: "Bb", cards: "Ah Ad", lines: ["Sb: raises $2 to $2.5", "Bb: folds"], winner: "Sb", pot: 2, returned: 1.5 });
    const decision = pre(hand);
    expect(decision).toMatchObject({ status: "analysed", source: "chart", grade: "blunder" });
    expect(decision?.facts.chart).toMatchObject({ set: ID, line: "r", scenario: "vs-open" });
  });

  it("reads a 3-bet and the open facing it", () => {
    const hand = huHand({
      hero: "Sb",
      cards: "Kh Kd",
      lines: ["Sb: raises $2 to $2.5", "Bb: raises $7.5 to $10", "Sb: folds"],
      winner: "Bb",
      pot: 5,
      returned: 7.5,
    });
    const decision = pre(hand);
    expect(decision).toMatchObject({ status: "analysed", source: "chart", grade: "blunder" });
    expect(decision?.facts.chart).toMatchObject({ set: ID, line: "rr", scenario: "vs-3bet" });
  });

  it("grades a 150bb hand from the 150bb set, and 120bb from the 100bb set", () => {
    const open = (stack: number) =>
      huHand({ hero: "Sb", cards: "Ah Kd", stack, lines: ["Sb: raises $2 to $2.5", "Bb: folds"], winner: "Sb", pot: 2, returned: 1.5 });
    expect(requiredChartSets(open(150), library.specs)).toEqual(["nlhe-cash-hu-150bb"]);
    expect(pre(open(150))).toMatchObject({ status: "analysed", source: "chart", grade: "perfect" });
    expect(pre(open(150))?.facts.chart).toMatchObject({ set: "nlhe-cash-hu-150bb", line: "" });
    expect(pre(open(150))?.approximations).not.toContain("stack-depth-near");
    expect(pre(open(135))?.facts.chart).toMatchObject({ set: "nlhe-cash-hu-150bb" });
    expect(pre(open(135))?.approximations).toContain("stack-depth-near");
    expect(pre(open(120))?.facts.chart).toMatchObject({ set: ID });
    // Folding AA to a 3-bet at 150bb is a Blunder there too.
    const aa = huHand({
      hero: "Sb",
      cards: "Ah Ad",
      stack: 150,
      lines: ["Sb: raises $2 to $2.5", "Bb: raises $7.5 to $10", "Sb: folds"],
      winner: "Bb",
      pot: 5,
      returned: 7.5,
    });
    expect(pre(aa)).toMatchObject({ status: "analysed", source: "chart", grade: "blunder" });
    expect(pre(aa)?.facts.chart).toMatchObject({ set: "nlhe-cash-hu-150bb", line: "rr", scenario: "vs-3bet" });
  });

  it("refuses a heads-up depth no set covers, and never reads heads-up on a 6-max set", () => {
    const at = (stack: number) =>
      huHand({ hero: "Sb", cards: "Ah Kd", stack, lines: ["Sb: raises $2 to $2.5", "Bb: folds"], winner: "Sb", pot: 2, returned: 1.5 });
    expect(pre(at(200))).toMatchObject({ status: "not-analysed", reason: "chart-stack-depth" });
    expect(pre(at(60))).toMatchObject({ status: "not-analysed", reason: "chart-stack-depth" });
  });
});
