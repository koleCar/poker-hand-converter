/**
 * The desktop app's Live screen helpers (`app/src/screens/live/model.ts`):
 * every statistic it shows exists, a statistic's target range is its
 * definition's "normal" band (a percentage only), a value's band places it
 * against the target, and the hands table's page buttons.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIVE_STATS,
  minutesBetween,
  pageList,
  perHundred,
  placeOf,
  rangeBar,
  rangeColour,
  rangeScore,
  targetRange,
  winRateBar,
} from "../../app/src/screens/live/model.js";
import { dateRange, EMPTY_FILTER, isInstant } from "../../packages/ui/hands/filter.js";
import type { StatDefinition } from "../../web/src/lib/stats/display.js";

const STANDARD = JSON.parse(readFileSync(join(__dirname, "../../config/stats/standard.json"), "utf8")) as {
  stats: StatDefinition[];
};

function definition(id: string): StatDefinition {
  const found = STANDARD.stats.find((stat) => stat.id === id);
  if (!found) throw new Error(`no definition ${id}`);
  return found;
}

describe("Live: the statistics", () => {
  it("shows only shipped statistics", () => {
    for (const id of LIVE_STATS) expect(() => definition(id)).not.toThrow();
  });

  it("takes a percentage's target from its normal band", () => {
    expect(targetRange(definition("vpip"))).toEqual({ low: 22, high: 30 });
    expect(targetRange(definition("pfr"))).toEqual({ low: 16, high: 22 });
    expect(targetRange(definition("wsd"))).toEqual({ low: 50, high: 55 });
  });

  it("gives a win rate no target", () => {
    expect(targetRange(definition("bb_per_100"))).toBeNull();
    expect(targetRange(definition("allin_ev_bb_per_100"))).toBeNull();
  });

  it("keeps an open end open", () => {
    const first = { format: { unit: "percent" as const, decimals: 1 }, bands: [{ below: 10, tone: "normal" as const }, { tone: "high" as const }] };
    expect(targetRange(first)).toEqual({ low: null, high: 10 });
    const last = { format: { unit: "percent" as const, decimals: 1 }, bands: [{ below: 10, tone: "low" as const }, { tone: "normal" as const }] };
    expect(targetRange(last)).toEqual({ low: 10, high: null });
    expect(targetRange({ format: { unit: "percent", decimals: 1 }, bands: [] })).toBeNull();
  });

  it("places a value by its band", () => {
    expect(placeOf("very-low")).toBe("below");
    expect(placeOf("low")).toBe("below");
    expect(placeOf("normal")).toBe("inRange");
    expect(placeOf("high")).toBe("above");
    expect(placeOf("very-high")).toBe("above");
    expect(placeOf(null)).toBeNull();
  });
});

describe("Live: the hands table's pages", () => {
  it("lists every page up to seven", () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the ends and the current page's neighbours beyond that", () => {
    expect(pageList(1, 20)).toEqual([1, 2, 3, 4, null, 20]);
    expect(pageList(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageList(20, 20)).toEqual([1, null, 17, 18, 19, 20]);
  });
});

describe("Live: the session's length", () => {
  it("is whole minutes, never negative", () => {
    expect(minutesBetween("2026-11-04T09:03:00Z", "2026-11-04T09:29:20Z")).toBe(26);
    expect(minutesBetween("2026-11-04T09:30:00Z", "2026-11-04T09:29:00Z")).toBe(0);
  });
});

describe("Live: a statistic against its target range", () => {
  it("scores the middle 0, the ends 1, further out more", () => {
    const range = { low: 45, high: 60 };
    expect(rangeScore(52.5, range)).toBe(0);
    expect(rangeScore(45, range)).toBe(1);
    expect(rangeScore(60, range)).toBe(1);
    expect(rangeScore(75, range)).toBe(3);
  });

  it("counts every value on an open side as the middle", () => {
    expect(rangeScore(5, { low: null, high: 10 })).toBe(0);
    expect(rangeScore(12.5, { low: null, high: 10 })).toBe(2);
    expect(rangeScore(20, { low: 10, high: null })).toBe(0);
  });

  it("goes from the profit colour through the warning colour to the loss colour", () => {
    expect(rangeColour(0)).toBe("color-mix(in oklab, var(--profit-fg) 100%, var(--warning-fg))");
    expect(rangeColour(1)).toBe("color-mix(in oklab, var(--profit-fg) 70%, var(--warning-fg))");
    expect(rangeColour(1.6)).toBe("color-mix(in oklab, var(--profit-fg) 0%, var(--warning-fg))");
    expect(rangeColour(3)).toBe("color-mix(in oklab, var(--warning-fg) 0%, var(--loss-fg))");
    expect(rangeColour(9)).toBe(rangeColour(3));
  });

  it("draws the band in a window two band-widths wider each side, the mark inside the ends", () => {
    const bar = rangeBar(52.5, { low: 45, high: 60 });
    expect(bar.bandLeft).toBeCloseTo(33.33, 1);
    expect(bar.bandRight).toBeCloseTo(33.33, 1);
    expect(bar.mark).toBeCloseTo(50);
    expect(rangeBar(500, { low: 45, high: 60 }).mark).toBe(98);
    expect(winRateBar(0).mark).toBe(50);
    expect(winRateBar(-400).mark).toBe(2);
  });
});

describe("Live: the money rate", () => {
  it("is the result over the hands, per hundred", () => {
    expect(perHundred(4500, 212)).toBeCloseTo(2122.64, 1);
    expect(perHundred(100, 0)).toBeNull();
  });
});

describe("Live: the last session opens Reports at its exact times", () => {
  it("keeps an instant as it is, the end one second on", () => {
    expect(isInstant("2026-11-04T19:14:00.000Z")).toBe(true);
    expect(isInstant("2026-11-04")).toBe(false);
    const range = dateRange(
      { ...EMPTY_FILTER, date: "custom", dateFrom: "2026-11-04T19:14:00.000Z", dateTo: "2026-11-04T22:02:00.000Z" },
      new Date("2026-11-05T10:00:00Z"),
    );
    expect(range).toEqual({ from: "2026-11-04T19:14:00.000Z", to: "2026-11-04T22:02:01.000Z" });
  });
});
