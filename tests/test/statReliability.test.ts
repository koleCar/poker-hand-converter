/**
 * Sample reliability (docs/RAIL-PLAN.md R2.5, docs/STATS-SPEC.md §13) on the
 * TypeScript side: `web/src/lib/stats/reliability.ts` and
 * `display.ts`'s `statReliability`.
 *
 * - **Parity.** `core/rail-stats/tests/data/reliability-vectors.json` holds,
 *   over display-vectors.json's corpus and synthetic totals, every shipped
 *   statistic's level, opacity and Wilson bounds as the TypeScript computed
 *   them, plus Wilson, level and `Math.sqrt` cases at the edges; Rust replays
 *   the same file (`core/rail-stats/tests/reliability.rs`). Here the
 *   TypeScript computes the same today.
 * - The behaviour the rule promises, in plain cases.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { showStat, type DisplaySums } from "../../web/src/lib/stats/display.js";
import { STANDARD_STATS } from "../../web/src/lib/stats/definitions.js";
import {
  OPACITY_FLOOR,
  WILSON_Z,
  sampleReliability,
  wilson,
} from "../../web/src/lib/stats/reliability.js";
import { COUNTER_KEYS, MONEY_KEYS, type SeatCounters, type SeatMoney } from "../../web/src/lib/stats/types.js";

const ROOT = join(import.meta.dirname, "../..");
type Json = Record<string, any>;
const read = (path: string): Json => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Json;

const VECTORS = read("core/rail-stats/tests/data/reliability-vectors.json");
const DISPLAY = read("core/rail-stats/tests/data/display-vectors.json");

function sumsOf(totals: Array<number | null>): DisplaySums {
  const counters = Object.fromEntries(COUNTER_KEYS.map((k, i) => [k, totals[i]])) as unknown as SeatCounters;
  const money = Object.fromEntries(
    MONEY_KEYS.map((k, i) => [k, totals[COUNTER_KEYS.length + i]]),
  ) as unknown as SeatMoney;
  return {
    counters,
    money,
    moneyHands: totals[COUNTER_KEYS.length + MONEY_KEYS.length] as number,
    evNetBbMilli: totals[COUNTER_KEYS.length + MONEY_KEYS.length + 1],
  };
}

const str = (x: number | null): string => (x === null ? "" : Object.is(x, -0) ? "-0" : String(x));

describe("reliability parity (Rust replays the same vectors)", () => {
  it("the vectors were written from these definitions and constants", () => {
    expect(VECTORS.meta.stats).toEqual(STANDARD_STATS.map((s) => s.def.id));
    expect(VECTORS.meta.z).toBe(String(WILSON_Z));
    expect(VECTORS.meta.opacityFloor).toBe(String(OPACITY_FLOOR));
  });

  it("every statistic over the corpus and synthetic totals", () => {
    const inputs = [...DISPLAY.groups, ...DISPLAY.synthetic] as Json[];
    const cases = VECTORS.stats as Json[];
    expect(cases.map((c) => c.key)).toEqual(inputs.map((c) => c.key));
    cases.forEach((vector, i) => {
      const sums = sumsOf(inputs[i].totals);
      STANDARD_STATS.forEach((stat, j) => {
        const shown = showStat(stat, sums, 2);
        const r = shown.reliability;
        const line = [
          r.level,
          str(r.opacity),
          str(r.interval?.low ?? null),
          str(r.interval?.high ?? null),
          r.intervalText?.low ?? "",
          r.intervalText?.high ?? "",
        ].join("|");
        expect(line, `${vector.key} ${stat.def.id}`).toBe(vector.out[j]);
        expect(r.level === "ok", `${vector.key} ${stat.def.id}: ok exactly when full`).toBe(shown.full);
      });
    });
  });

  it("wilson, levels and Math.sqrt at the edges", () => {
    for (const [made, n, low, high] of VECTORS.wilson as string[][]) {
      const interval = wilson(Number(made), Number(n));
      expect([str(interval?.low ?? null), str(interval?.high ?? null)], `wilson(${made}, ${n})`).toEqual([low, high]);
    }
    for (const [sample, min, level, opacity] of VECTORS.samples as [string | null, number, string, string][]) {
      const got = sampleReliability(sample === null ? null : Number(sample), min);
      expect([got.level, str(got.opacity)], `${sample} of ${min}`).toEqual([level, opacity]);
    }
    for (const [x, root] of VECTORS.sqrt as string[][]) {
      expect(str(Math.sqrt(Number(x))), `sqrt(${x})`).toBe(root);
    }
  });
});

describe("the rule", () => {
  it("gives a rate at 0 or 100% an honest interval, not ±0", () => {
    expect(wilson(0, 3)).toEqual({ low: 0, high: expect.closeTo(56.15, 2) });
    expect(wilson(3, 3)?.high).toBe(100);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(4, 3)).toBeNull();
    const big = wilson(300, 1000)!;
    expect(big.high - big.low).toBeLessThan(6);
  });

  it("dims below sample.min, continuously, and is ok from it", () => {
    expect(sampleReliability(null, 100)).toEqual({ level: "insufficient", opacity: OPACITY_FLOOR });
    expect(sampleReliability(0, 0)).toEqual({ level: "ok", opacity: 1 });
    expect(sampleReliability(24, 100).level).toBe("insufficient");
    expect(sampleReliability(25, 100)).toEqual({ level: "low", opacity: 0.8 });
    expect(sampleReliability(99, 100).opacity).toBeCloseTo(0.998, 3);
    expect(sampleReliability(100, 100)).toEqual({ level: "ok", opacity: 1 });
  });

  it("a win rate has a level but no interval", () => {
    const bb = STANDARD_STATS.find((s) => s.def.id === "bb_per_100")!;
    const sums = sumsOf(DISPLAY.groups[0].totals);
    const r = showStat(bb, sums).reliability;
    expect(r.interval).toBeNull();
    expect(r.intervalText).toBeNull();
  });
});
