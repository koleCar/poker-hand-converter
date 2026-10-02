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
  loadCharts,
  serializeCharts,
} from "../../../frontend/src/lib/charts/index.js";
import { decodeBase64, encodeBase64 } from "../../../frontend/src/lib/charts/base64.js";
import { encodeEv, encodeFreq } from "../../../frontend/src/lib/charts/format.js";
import { NUM_CLASSES, preflopEquityTable } from "../../../frontend/src/lib/solver/index.js";

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
