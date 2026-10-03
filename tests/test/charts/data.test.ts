/**
 * Sanity properties of the committed chart set
 * (`frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json`).
 *
 * A preflop chart from a six-player CFR has no closed-form answer to compare
 * against, and multi-player CFR has no equilibrium guarantee. These are the
 * properties any sane 6-max 100bb chart has, whatever produced it; the bands
 * are deliberately wide (docs/CHARTS.md, "Sanity bands") so that they catch a
 * broken generator, not a model change:
 *
 *  - every frequency vector sums to 1, every array has 169 entries per option;
 *  - raise-first-in widths grow with position, UTG < HJ < CO < BTN, and fall
 *    in published-wisdom bands (UTG 13-20%, HJ 16-25%, CO 22-33%, BTN 38-55%,
 *    SB 40-70% including limps);
 *  - charts/2's bands (A2a.1): the big blind defends 55-70% against a button
 *    open and calls more than it 3-bets against every open; flats in
 *    position exist; UTG opens 66+ and suited hands ahead of A9o-A2o;
 *  - AA never folds anywhere; KK never folds where it is in range before an
 *    all-in (except cold against a 3-bet and a 4-bet), and folds a heads-up
 *    5-bet shove at most half the time (a 5-bet shove into a 3-bet and a
 *    4-bet is mostly AA);
 *  - 72o never opens UTG;
 *  - EVs are consistent with frequencies: for a class in range the chart's
 *    mix loses at most 2% of the pot to the class's best action, and the best
 *    action has a positive frequency (or is within that of one that does);
 *    off-range classes play their best response;
 *  - the convergence the generator recorded is good: NashConv under 1 mbb/hand.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHART_SET_VERSIONS,
  CHARTS_VERSION,
  chartTree,
  IN_RANGE,
  isOpenLimpNode,
  loadCharts,
  MAX_SELF_LOSS,
  type ChartNode,
} from "../../../frontend/src/lib/charts/index.js";
import { CLASS_COMBOS, classByName, NUM_CLASSES } from "../../../frontend/src/lib/solver/index.js";

const FILE = join(import.meta.dirname, "../../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json");
const text = readFileSync(FILE, "utf8");
const charts = loadCharts(JSON.parse(text));
const H = NUM_CLASSES;

function node(line: string): ChartNode {
  const found = charts.nodes.get(line);
  if (!found) throw new Error(`no node ${JSON.stringify(line)}`);
  return found;
}

/** Share of all 1326 combos that do not fold at an unopened node. */
function rfiWidth(line: string): number {
  const n = node(line);
  const fold = n.options.findIndex((o) => o.action === "fold");
  let sum = 0;
  for (let i = 0; i < H; i += 1) sum += CLASS_COMBOS[i] * (1 - n.freq[fold * H + i]);
  return sum / 1326;
}

describe("committed chart set", () => {
  it("is the 6-max 100bb set of a reasonable size, charts/2's fit on charts/4's limp tree", () => {
    // charts/4 (A2d) re-solved this set with limps, on the fit A2a.1 measured.
    expect(charts.version).toBe("charts/4");
    expect(CHART_SET_VERSIONS).toContain(charts.version);
    expect(CHARTS_VERSION).toBe("charts/4");
    expect(charts.id).toBe("nlhe-cash-6max-100bb");
    expect(charts.game.positions).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(charts.game.stackBb).toBe(100);
    expect(charts.nodes.size).toBeGreaterThan(100);
    expect(statSync(FILE).size).toBeLessThan(3_000_000);
    const model = charts.model as Record<string, any>;
    expect(model.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(model.rake.percent).toBe(0.05);
    expect(model.rake.capBb).toBe(3);
    expect(model.solver.iterations).toBeGreaterThanOrEqual(1000);
    // charts/2: the realisation model was fitted to the postflop solver, and says how.
    expect(model.realisation.name).toBe("charts/2-solver-fit");
    expect(model.realisationFit.rounds.length).toBeGreaterThanOrEqual(1);
  });

  it("recorded good convergence", () => {
    const convergence = (charts.model as Record<string, any>).convergence;
    expect(convergence.nashConvMbb).toBeLessThan(1);
    expect(convergence.headsUpBlindVsBlind.nashConvMbb).toBeLessThan(0.5);
    const history = convergence.history as { nashConvMbb: number }[];
    expect(history[history.length - 1].nashConvMbb).toBeLessThanOrEqual(history[0].nashConvMbb);
  });

  it("has frequencies that sum to 1 and arrays of the right length", () => {
    for (const n of charts.nodes.values()) {
      const count = n.options.length;
      expect(n.freq).toHaveLength(count * H);
      expect(n.ev).toHaveLength(count * H);
      expect(n.range).toHaveLength(H);
      for (let i = 0; i < H; i += 1) {
        let sum = 0;
        for (let a = 0; a < count; a += 1) sum += n.freq[a * H + i];
        expect(sum, `${n.line} class ${i}`).toBeCloseTo(1, 9);
      }
    }
  });

  it("opens wider in later position, within the sanity bands", () => {
    const utg = rfiWidth("");
    const hj = rfiWidth("f");
    const co = rfiWidth("ff");
    const btn = rfiWidth("fff");
    const sb = rfiWidth("ffff");
    expect(utg).toBeLessThan(hj);
    expect(hj).toBeLessThan(co);
    expect(co).toBeLessThan(btn);
    expect(utg).toBeGreaterThan(0.13);
    expect(utg).toBeLessThan(0.2);
    expect(hj).toBeGreaterThan(0.16);
    expect(hj).toBeLessThan(0.25);
    expect(co).toBeGreaterThan(0.22);
    expect(co).toBeLessThan(0.33);
    expect(btn).toBeGreaterThan(0.38);
    expect(btn).toBeLessThan(0.55);
    expect(sb).toBeGreaterThan(0.4);
    expect(sb).toBeLessThan(0.7);
  });

  it("never folds AA, never folds KK in range heads-up, never opens 72o UTG", () => {
    const aa = classByName("AA");
    const kk = classByName("KK");
    const tree = chartTree(charts);
    for (const n of charts.nodes.values()) {
      const fold = n.options.findIndex((o) => o.action === "fold");
      if (fold < 0) continue;
      expect(n.freq[fold * H + aa], `AA folds at ${JSON.stringify(n.line)}`).toBe(0);
      // KK continues before any all-in. Facing a 5-bet shove the model's
      // shoving ranges are AA-heavy, and KK (which blocks KK) is close to
      // indifferent heads-up and may fold with a cold 4-bettor still behind.
      if (n.range[kk] <= 0.01) continue;
      const kkFold = n.freq[fold * H + kk];
      // A cold player facing a 3-bet and a 4-bet ahead of it (two re-raisers,
      // fold or shove) may fold KK: one of them holds AA often enough.
      if (n.scenario === "vs-4bet" && n.cold) continue;
      // Cold behind an open limp the tree offers only fold or a 100bb shove (charts/4).
      if (n.cold && isOpenLimpNode(n)) continue;
      const at = tree.lineIndex.get(n.line) as number;
      // Behind an open limp the 4-bet is already all-in (charts/4): judged as a shove.
      if (tree.toMatch[at] < tree.stackBb) {
        expect(kkFold, `KK folds at ${JSON.stringify(n.line)}`).toBeLessThan(0.01);
        continue;
      }
      let live = 0;
      for (let p = 0; p < 6; p += 1) if (tree.live[at] & (1 << p)) live += 1;
      // Behind an open limp the shove is the 4-bet, from a range of aces and little else (charts/4).
      if (live === 2 && !isOpenLimpNode(n)) {
        expect(kkFold, `KK folds to a heads-up shove at ${JSON.stringify(n.line)}`).toBeLessThan(0.5);
      }
    }
    const utg = node("");
    const open = utg.options.findIndex((o) => o.action === "raise");
    expect(utg.freq[open * H + classByName("72o")]).toBe(0);
    // Every class limps at least the tremble's 0.5% (charts/4), AA a little more (a trap); it opens the rest.
    expect(utg.freq[open * H + classByName("AA")]).toBeGreaterThan(0.95);
  });

  it("has EVs consistent with its frequencies", () => {
    // For every class in range, the chart's own mix gives up at most 2% of
    // the pot against the class's best action (the generator leaves out nodes
    // where it does not; MAX_SELF_LOSS), plus the 0.01bb EV quantisation; and
    // the best action has a positive frequency or is within that tolerance of
    // an action that has one.
    let checked = 0;
    for (const n of charts.nodes.values()) {
      const count = n.options.length;
      const tolerance = MAX_SELF_LOSS * n.potBb + 0.02;
      for (let i = 0; i < H; i += 1) {
        if (n.range[i] < IN_RANGE) continue;
        let best = -Infinity;
        for (let a = 0; a < count; a += 1) best = Math.max(best, n.ev[a * H + i]);
        let loss = 0;
        let bestPlayed = -Infinity;
        for (let a = 0; a < count; a += 1) {
          const f = n.freq[a * H + i];
          loss += f * (best - n.ev[a * H + i]);
          if (f > 0) bestPlayed = Math.max(bestPlayed, n.ev[a * H + i]);
        }
        expect(loss, `${JSON.stringify(n.line)} class ${i}`).toBeLessThanOrEqual(tolerance);
        expect(bestPlayed).toBeGreaterThanOrEqual(best - tolerance);
        checked += 1;
      }
      // Off-range classes carry the best response: their played action is the best.
      for (let i = 0; i < H; i += 1) {
        if (n.range[i] > 0) continue;
        let best = -Infinity;
        for (let a = 0; a < count; a += 1) best = Math.max(best, n.ev[a * H + i]);
        const played = n.options.findIndex((_, a) => n.freq[a * H + i] === 1);
        expect(played).toBeGreaterThanOrEqual(0);
        expect(n.ev[played * H + i]).toBeGreaterThanOrEqual(best - 0.011);
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it("names scenarios the way the stats engine counts them", () => {
    expect(node("").scenario).toBe("rfi");
    expect(node("fff").steal).toBe(true);
    expect(node("").steal).toBe(false);
    expect(node("fffrf").scenario).toBe("vs-open");
    expect(node("fffrf").vsSteal).toBe(true);
    expect(node("ffffc").scenario).toBe("vs-limp");
    expect(node("ffffcr").scenario).toBe("vs-iso");
    expect(node("rfffc").scenario).toBe("squeeze");
    expect(node("rfffc").callers).toEqual(["SB"]);
    expect(node("rffrff").scenario).toBe("vs-3bet");
    expect(node("rffrff").facing).toEqual({ position: "BTN", toBb: 7.5 });
    expect(node("rffrffr").scenario).toBe("vs-4bet");
  });

  it("uses the 169-class reduction with the right combo counts", () => {
    let combos = 0;
    for (let i = 0; i < H; i += 1) combos += CLASS_COMBOS[i];
    expect(combos).toBe(1326);
    // The UTG range at the root is every combo.
    expect(Array.from(node("").range).every((r) => r === 1)).toBe(true);
  });
});

/** Share of the actor's range (combo- and reach-weighted) taking `action` at a node. */
function rangeShare(line: string, action: string): number {
  const n = node(line);
  const a = n.options.findIndex((o) => o.action === action);
  if (a < 0) return 0;
  let sum = 0;
  let total = 0;
  for (let i = 0; i < H; i += 1) {
    const w = CLASS_COMBOS[i] * n.range[i];
    sum += w * n.freq[a * H + i];
    total += w;
  }
  return sum / total;
}

/** Frequency of `action` for one class at a node. */
function freqOf(line: string, name: string, action: string): number {
  const n = node(line);
  const a = n.options.findIndex((o) => o.action === action);
  return a < 0 ? 0 : n.freq[a * H + classByName(name)];
}

describe("charts/2 bands (docs/CHARTS.md §8)", () => {
  // The bands A2a.1 set from general poker theory (never from a published
  // chart). The ones the model does not reach are in §9, not here.
  it("has the big blind defend 55-70% against a button open, mostly by calling", () => {
    const call = rangeShare("fffrf", "call");
    const threeBet = rangeShare("fffrf", "raise");
    expect(call + threeBet).toBeGreaterThan(0.55);
    expect(call + threeBet).toBeLessThan(0.7);
    expect(call).toBeGreaterThan(0.3);
    expect(call).toBeGreaterThan(2 * threeBet);
  });

  it("has the big blind call more than it 3-bets against every open, and defend wider against later ones", () => {
    const opens = ["rffff", "frfff", "ffrff", "fffrf"];
    for (const line of opens) expect(rangeShare(line, "call"), line).toBeGreaterThan(rangeShare(line, "raise"));
    const defend = opens.map((line) => 1 - rangeShare(line, "fold"));
    for (let k = 1; k < defend.length; k += 1) expect(defend[k]).toBeGreaterThan(defend[k - 1]);
  });

  it("flats in position as well as 3-betting", () => {
    expect(rangeShare("rff", "call")).toBeGreaterThan(0.01);
    expect(rangeShare("rff", "raise")).toBeGreaterThan(0.05);
    expect(rangeShare("ffr", "raise")).toBeGreaterThan(0.05);
  });

  it("opens pairs and suited hands UTG ahead of weak offsuit aces", () => {
    for (const pair of ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "66"]) {
      expect(freqOf("", pair, "raise"), pair).toBeGreaterThan(0.5);
    }
    for (const suited of ["A7s", "K7s", "Q9s", "JTs", "T9s"]) {
      expect(freqOf("", suited, "raise"), suited).toBeGreaterThan(0.5);
    }
    for (const ax of ["A9o", "A8o", "A7o", "A6o", "A5o", "A4o", "A3o", "A2o"]) {
      expect(freqOf("", ax, "raise"), ax).toBeLessThan(0.25);
    }
  });

  it("never folds KK to an open or a 3-bet", () => {
    for (const n of charts.nodes.values()) {
      if (n.scenario === "vs-allin" || n.scenario === "vs-4bet") continue;
      // Cold behind an open limp the tree offers only fold or a 100bb shove (charts/4).
      if (n.cold && isOpenLimpNode(n)) continue;
      const fold = n.options.findIndex((o) => o.action === "fold");
      if (fold < 0) continue;
      expect(n.freq[fold * H + classByName("KK")], `KK at ${JSON.stringify(n.line)}`).toBe(0);
    }
  });
});
