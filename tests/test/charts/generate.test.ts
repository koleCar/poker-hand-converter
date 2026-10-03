/**
 * The generator on a small configuration (button, small blind, big blind; a
 * small equity sample; a few dozen iterations): it must be deterministic -
 * the committed chart set is only reproducible if two runs write the same
 * bytes - and its output must survive the encode / decode round trip.
 *
 * The production run (`npm run charts:generate`) takes minutes and is not
 * part of the suite; `data.test.ts` checks what it produced.
 */

import { describe, expect, it } from "vitest";

import {
  CHARTS_VERSION,
  generateChartSet,
  isOpenLimpNode,
  loadCharts,
  serializeCharts,
} from "../../../frontend/src/lib/charts/index.js";
import { decodeBase64, encodeBase64 } from "../../../frontend/src/lib/charts/base64.js";
import { encodeEv, encodeFreq } from "../../../frontend/src/lib/charts/format.js";
import { buildPreflopTree, NINE_MAX, NUM_CLASSES, preflopEquityTable } from "../../../frontend/src/lib/solver/index.js";

const SMALL = {
  players: ["BTN", "SB", "BB"] as const,
  equityBoards: 400,
  equitySeed: 99,
  iterations: 60,
  checkEvery: 30,
  headsUpIterations: 30,
  minReach: 0,
};

describe("chart generator", () => {
  it("writes identical bytes for identical options", () => {
    const equity = preflopEquityTable({ boards: SMALL.equityBoards, seed: SMALL.equitySeed });
    const a = serializeCharts(generateChartSet({ ...SMALL, equity }).charts);
    // The second run computes its own equity table from the same seed.
    const b = serializeCharts(generateChartSet({ ...SMALL }).charts);
    expect(a).toBe(b);
    const set = loadCharts(JSON.parse(a));
    expect(set.version).toBe(CHARTS_VERSION);
    expect(set.id).toBe("nlhe-cash-3max-100bb");
    expect(set.nodes.get("")?.actor).toBe("BTN");
    const model = set.model as Record<string, any>;
    expect(model.solver.iterations).toBe(60);
    expect(model.convergence.history).toHaveLength(2);
    expect(model.equity.boards).toBe(400);
  });

  it("changes the model hash when an assumption changes", () => {
    const one = generateChartSet({ ...SMALL, iterations: 30 }).charts;
    const two = generateChartSet({ ...SMALL, iterations: 30, sizing: { open: 2.2 } }).charts;
    expect(one.model.hash).not.toBe(two.model.hash);
    expect((two.model as Record<string, any>).tree.sizing.open).toBe(2.2);
  });
});

describe("other tables and depths (A2c)", () => {
  it("builds full-ring trees from the stats engine's seat names", () => {
    expect(buildPreflopTree({ players: NINE_MAX }).actionNodes).toBe(28591);
    expect(buildPreflopTree({ players: ["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"] }).actionNodes).toBe(16266);
    // The 6-max tree is unchanged by the wider seat list.
    expect(buildPreflopTree().actionNodes).toBe(3825);
    expect(() => buildPreflopTree({ players: ["HJ", "UTG", "BB"] })).toThrow(/order/);
    expect(() => buildPreflopTree({ players: ["MP" as never, "BB"] })).toThrow(/unknown position/);
  });

  it("makes a raise all-in past `allInAbove` of the stack, and rounds sizes without float noise", () => {
    const sizing = { open: 2.2, roundTo: 0.1, allInAbove: 0.4 };
    const tree = buildPreflopTree({ stackBb: 40, sizing });
    const codes = (line: string) => {
      const node = tree.lineIndex.get(line) as number;
      const out: [string, number][] = [];
      for (let e = tree.childStart[node]; e < tree.childStart[node] + tree.childCount[node]; e += 1) {
        out.push([tree.edgeCode[e], tree.edgeTo[e]]);
      }
      return out;
    };
    expect(codes("")).toEqual([["f", 0], ["r", 2.2]]);
    // BTN 3-bets UTG in position: 3 x 2.2 = 6.6; UTG's 4-bet (2.5 x 6.6 = 16.5 > 16) is all-in.
    expect(codes("rff")).toEqual([["f", 0], ["c", 2.2], ["r", 6.6]]);
    expect(codes("rffrff")).toEqual([["f", 2.2], ["c", 6.6], ["a", 40]]);
    // At 100bb the same rule changes nothing before the 5-bet.
    const deep = buildPreflopTree({ sizing: { allInAbove: 0.4 } });
    expect(deep.actionNodes).toBe(3825);
  });

  it("generates a short-stacked set with 9-max seat names deterministically", () => {
    const config = {
      players: ["UTG+2", "BTN", "SB", "BB"] as const,
      stackBb: 40,
      sizing: { open: 2.2, roundTo: 0.1, allInAbove: 0.4 },
      equityBoards: 400,
      equitySeed: 99,
      iterations: 40,
      checkEvery: 20,
      headsUpIterations: 0,
      minReach: 0,
    };
    const a = serializeCharts(generateChartSet(config).charts);
    const b = serializeCharts(generateChartSet(config).charts);
    expect(a).toBe(b);
    const set = loadCharts(JSON.parse(a));
    expect(set.id).toBe("nlhe-cash-4max-40bb");
    expect(set.game.positions).toEqual(["UTG+2", "BTN", "SB", "BB"]);
    expect(set.nodes.get("")?.options.map((o) => [o.action, o.toBb])).toEqual([
      ["fold", 0],
      ["raise", 2.2],
    ]);
    const vs3bet = [...set.nodes.values()].filter((n) => n.scenario === "vs-3bet");
    expect(vs3bet.length).toBeGreaterThan(0);
    for (const n of vs3bet) expect(n.options.map((o) => o.action)).toContain("allin");
    expect((set.model as Record<string, any>).tree.sizing.allInAbove).toBe(0.4);
  });
});

describe("limp trees (A2d)", () => {
  const config = {
    players: ["CO", "BTN", "SB", "BB"] as const,
    stackBb: 40,
    maxLimpers: 2,
    limpFloor: 0.01,
    minLimpReach: 0,
    equityBoards: 400,
    equitySeed: 99,
    iterations: 150,
    checkEvery: 150,
    headsUpIterations: 0,
    minReach: 0,
  };

  it("generates a set with limped pots deterministically, and records the tree", () => {
    const a = serializeCharts(generateChartSet(config).charts);
    expect(serializeCharts(generateChartSet(config).charts)).toBe(a);
    const set = loadCharts(JSON.parse(a));
    const tree = (set.model as Record<string, any>).tree;
    expect(tree.maxLimpers).toBe(2);
    expect(tree.limpFloor).toBe(0.01);
    expect(set.nodes.get("")?.options.map((o) => o.action)).toEqual(["fold", "call", "raise"]);
    // The button behind the cutoff's limp, the limper facing the button's isolation.
    const vsLimp = set.nodes.get("c");
    expect(vsLimp?.scenario).toBe("vs-limp");
    expect(vsLimp?.limpers).toEqual(["CO"]);
    expect(isOpenLimpNode(vsLimp!)).toBe(true);
    expect(set.nodes.get("crff")?.scenario).toBe("vs-iso");
    // Two limpers: the small blind may not complete a third time.
    expect(set.nodes.get("cc")?.cut).toContain("limpers-cap");
    // The blinds' own limped pot is not an open limp.
    expect(isOpenLimpNode(set.nodes.get("ffc")!)).toBe(false);
    // Every class limps at least the tremble at the cutoff (a uint8 rounds 1% to 3/255).
    const root = set.nodes.get("")!;
    for (let i = 0; i < NUM_CLASSES; i += 1) expect(root.freq[NUM_CLASSES + i]).toBeGreaterThanOrEqual(2 / 255);
  });

  it("keeps nodes behind a limp down to their own reach floor", () => {
    const strict = loadCharts(JSON.parse(serializeCharts(generateChartSet({ ...config, minReach: 0.01, minLimpReach: 0.01 }).charts)));
    const loose = loadCharts(JSON.parse(serializeCharts(generateChartSet({ ...config, minReach: 0.01, minLimpReach: 0 }).charts)));
    const limped = (set: typeof strict) => [...set.nodes.values()].filter((n) => isOpenLimpNode(n)).length;
    expect(limped(loose)).toBeGreaterThan(limped(strict));
    // Nodes off the limp are the same either way.
    const plain = (set: typeof strict) => [...set.nodes.values()].filter((n) => !isOpenLimpNode(n)).map((n) => n.line);
    expect(plain(loose)).toEqual(plain(strict));
  });
});

describe("encoding", () => {
  it("round-trips base64", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 169, 507]) {
      const bytes = Uint8Array.from({ length }, (_, k) => (k * 37 + 11) & 255);
      expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("quantises frequencies to sum to exactly 255 per class", () => {
    const freq = new Float64Array(3 * NUM_CLASSES);
    for (let i = 0; i < NUM_CLASSES; i += 1) {
      freq[i] = 1 / 3;
      freq[NUM_CLASSES + i] = 1 / 3;
      freq[2 * NUM_CLASSES + i] = 1 / 3;
    }
    const bytes = decodeBase64(encodeFreq(freq, 3));
    for (let i = 0; i < NUM_CLASSES; i += 1) {
      expect(bytes[i] + bytes[NUM_CLASSES + i] + bytes[2 * NUM_CLASSES + i]).toBe(255);
    }
  });

  it("stores EVs to a hundredth of a big blind", () => {
    const bytes = decodeBase64(encodeEv([-100, -1, 0, 0.004, 12.346, 150]));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3, 4, 5].map((k) => view.getInt16(k * 2, true) / 100)).toEqual([-100, -1, 0, 0, 12.35, 150]);
  });
});
