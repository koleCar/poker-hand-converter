/**
 * Both ranges at a decision (`web/src/lib/solver/ranges.ts`, the Solver
 * library's Ranges tab and hand filters): the made hand and draw of a combo,
 * the equity sweep against a brute-force count, both players' EV on the
 * committed pilot, and the filter's include / exclude rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE } from "../../web/src/lib/analysis/index.js";
import { cardIndex, evaluate } from "../../web/src/lib/equity/index.js";
import {
  buildEquityTable,
  comboHi,
  comboIds,
  comboIndex,
  comboLo,
  decodeChunk,
  DRAWS,
  exploreNode,
  handFeature,
  MADE_HANDS,
  nodeRanges,
  passes,
  rangeEquity,
  type FlopChunk,
  type FlopManifest,
} from "../../web/src/lib/solver/index.js";

const DIR = join(import.meta.dirname, "../scripts/flop-library/pilot/nlhe-cash-6max-100bb", FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));

function chunks(): FlopChunk[] {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest;
  return manifest.entries.map((e) => decodeChunk(readFileSync(join(DIR, e.path))));
}

const cards = (text: string) => (text.match(/../g) ?? []).map(cardIndex);
function feature(hole: string, board: string) {
  const [a, b] = cards(hole);
  const f = handFeature(a, b, cards(board));
  return { made: MADE_HANDS[f.made], draw: f.draw < 0 ? null : DRAWS[f.draw] };
}

describe("handFeature", () => {
  it("names the made hand with the hole cards in it", () => {
    expect(feature("JhTd", "Js9h5d").made).toBe("topPair");
    expect(feature("Th9d", "Js9h5d").made).toBe("secondPair");
    expect(feature("6h5c", "Js9h5d").made).toBe("thirdPair");
    expect(feature("QhQd", "Js9h5d").made).toBe("overpair");
    expect(feature("TcTd", "Js9h5d").made).toBe("secondPair");
    expect(feature("4c4d", "Js9h5d").made).toBe("underpair");
    expect(feature("9c9d", "Js9h5d").made).toBe("set");
    expect(feature("Jc9d", "Js9h5d").made).toBe("twoPair");
    expect(feature("AcKd", "Js9h5d").made).toBe("aceHigh");
    expect(feature("KcQd", "Js9h5d").made).toBe("kingHigh");
    expect(feature("8c7d", "Js9h5d").made).toBe("nothing");
    expect(feature("QcTd", "Js9h8d").made).toBe("straight");
    // The board's own pair is not the hand's.
    expect(feature("AcKd", "9s9h5d").made).toBe("aceHigh");
    expect(feature("9c4d", "9s9h5d").made).toBe("trips");
  });

  it("names the strongest draw, none on the river", () => {
    expect(feature("AsKs", "Js9s5d").draw).toBe("flushDraw");
    expect(feature("QsTs", "Js9s5d").draw).toBe("comboDraw");
    expect(feature("QcTd", "Js9h5d").draw).toBe("oesd");
    expect(feature("Kc2d", "Js9h5d").draw).toBe("noDraw");
    expect(feature("Kc8d", "Js9h5d").draw).toBe("bdsd");
    expect(feature("KcTd", "Js9h5d").draw).toBe("gutshot");
    expect(feature("AhKh", "Js9h5d").draw).toBe("bdfd2");
    expect(feature("AsKc", "Js9s5d").draw).toBe("bdfd1");
    expect(feature("QcTd", "Js9h5d2c3h").draw).toBeNull();
  });
});

describe("rangeEquity", () => {
  it("matches a brute-force count over every runout", () => {
    const board = cards("Js9h5d");
    const pick = (codes: string[]) => Uint16Array.from(codes, (c) => comboIndex(cardIndex(c.slice(0, 2)), cardIndex(c.slice(2, 4))));
    const hands: [Uint16Array, Uint16Array] = [pick(["AhJh", "QcTd", "7c7d", "As2s"]), pick(["JdJc", "Kh9c", "8s7s", "AdQd", "Ah5h"])];
    const reach: [Float64Array, Float64Array] = [Float64Array.from([1, 0.5, 1, 0.25]), Float64Array.from([1, 0.3, 0.7, 1, 0.5])];
    const eq = rangeEquity(buildEquityTable(hands, board), reach);
    for (const p of [0, 1] as const) {
      const o = 1 - p;
      hands[p].forEach((combo, i) => {
        const mine = [comboHi(combo), comboLo(combo)];
        let num = 0;
        let den = 0;
        hands[o].forEach((other, j) => {
          const theirs = [comboHi(other), comboLo(other)];
          if (theirs.some((c) => mine.includes(c))) return;
          const dead = new Set([...board, ...mine, ...theirs]);
          const rest = Array.from({ length: 52 }, (_, c) => c).filter((c) => !dead.has(c));
          for (let x = 0; x < rest.length; x += 1) {
            for (let y = x + 1; y < rest.length; y += 1) {
              const run = [...board, rest[x], rest[y]];
              const a = evaluate([...run, ...mine]);
              const b = evaluate([...run, ...theirs]);
              num += reach[o][j] * (a > b ? 1 : a === b ? 0.5 : 0);
              den += reach[o][j];
            }
          }
        });
        expect(eq[p][i]).toBeCloseTo(num / den, 10);
      });
    }
  });
});

describe.skipIf(!PRESENT)("nodeRanges on the pilot", () => {
  it("gives both players their EV: the actor's mix, the other's from the action that led here", () => {
    for (const chunk of chunks().slice(0, 3)) {
      const { nodes } = chunk.result;
      const root = nodeRanges(chunk, 0);
      expect(root.sides[0].ev).not.toBeNull();
      expect(root.sides[1].ev).not.toBeNull();
      for (let index = 1; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.kind !== "action") continue;
        const parent = nodes[node.parent];
        if (parent.kind !== "action") continue;
        const view = nodeRanges(chunk, index);
        const other = view.sides[parent.player as 0 | 1];
        const size = chunk.result.hands[parent.player].length;
        const expected = parent.ev.subarray(node.parentEdge * size, (node.parentEdge + 1) * size);
        other.ev!.forEach((v, i) => expect(v - other.invested).toBeCloseTo(expected[i], 4));
        // The actor's range EV is exploreNode's, plus what they put in.
        const actor = view.sides[view.actor];
        const reach = actor.reach.reduce((s, r) => s + r, 0);
        const mean = actor.ev!.reduce((s, v, i) => s + v * actor.reach[i], 0) / reach;
        expect(mean - actor.invested).toBeCloseTo(exploreNode(chunk, index).value, 6);
        // What the two take back out of the pot is about the pot, less rake. Each side's EV is
        // averaged against the other's range with card removal, so a range of a few combos
        // (a shove) can stray; wide ones cannot by much.
        const otherReach = other.reach.reduce((s, r) => s + r, 0);
        if (reach < 20 || otherReach < 20) continue;
        const otherMean = other.ev!.reduce((s, v, i) => s + v * other.reach[i], 0) / otherReach;
        expect(mean + otherMean).toBeLessThanOrEqual(node.pot * 1.02);
        expect(mean + otherMean).toBeGreaterThan(node.pot * 0.6);
      }
    }
  });
});

describe("passes", () => {
  const ids = comboIds("AhKh", { made: MADE_HANDS.indexOf("topPair"), draw: DRAWS.indexOf("flushDraw") }, 0.8);

  it("ors within a group and ands across groups", () => {
    expect(passes({ include: [], exclude: [] }, ids)).toBe(true);
    expect(passes({ include: ["made:topPair", "made:set"], exclude: [] }, ids)).toBe(true);
    expect(passes({ include: ["made:set"], exclude: [] }, ids)).toBe(false);
    expect(passes({ include: ["made:topPair", "draw:oesd"], exclude: [] }, ids)).toBe(false);
    expect(passes({ include: ["made:topPair", "eq:best"], exclude: [] }, ids)).toBe(true);
    expect(passes({ include: ["band:80"], exclude: [] }, ids)).toBe(true);
  });

  it("drops anything excluded, and reads suits as dealt", () => {
    expect(passes({ include: [], exclude: ["draw:flushDraw"] }, ids)).toBe(false);
    expect(passes({ include: ["suit:sh"], exclude: [] }, ids)).toBe(true);
    expect(passes({ include: ["suit:oh"], exclude: [] }, ids)).toBe(false);
    const offsuit = comboIds("AhKd", { made: 0, draw: 0 }, Number.NaN);
    expect(passes({ include: ["suit:od"], exclude: [] }, offsuit)).toBe(true);
    // No equity yet: an equity bucket lets nothing through.
    expect(passes({ include: ["eq:best"], exclude: [] }, offsuit)).toBe(false);
  });
});
