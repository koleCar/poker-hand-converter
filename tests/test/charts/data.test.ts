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
 *  - AA never folds anywhere; KK never folds where it is in range before an
 *    all-in, and folds a heads-up 5-bet shove at most a quarter of the time;
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
  CHARTS_VERSION,
  chartTree,
  IN_RANGE,
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
  it("is a charts/1 6-max 100bb set of a reasonable size", () => {
    expect(charts.version).toBe(CHARTS_VERSION);
    expect(charts.id).toBe("nlhe-cash-6max-100bb");
    expect(charts.game.positions).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(charts.game.stackBb).toBe(100);
    expect(charts.nodes.size).toBeGreaterThan(100);
    expect(statSync(FILE).size).toBeLessThan(1_500_000);
    const model = charts.model as Record<string, any>;
    expect(model.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(model.rake.percent).toBe(0.05);
    expect(model.rake.capBb).toBe(3);
    expect(model.solver.iterations).toBeGreaterThanOrEqual(1000);
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
      if (n.scenario !== "vs-allin") {
        expect(kkFold, `KK folds at ${JSON.stringify(n.line)}`).toBeLessThan(0.01);
        continue;
      }
      const at = tree.lineIndex.get(n.line) as number;
      let live = 0;
      for (let p = 0; p < 6; p += 1) if (tree.live[at] & (1 << p)) live += 1;
      if (live === 2) expect(kkFold, `KK folds to a heads-up shove at ${JSON.stringify(n.line)}`).toBeLessThan(0.25);
    }
    const utg = node("");
    expect(utg.freq[1 * H + classByName("72o")]).toBe(0);
    expect(utg.freq[1 * H + classByName("AA")]).toBe(1);
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
