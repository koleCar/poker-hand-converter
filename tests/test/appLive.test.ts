/**
 * The desktop app's Live screen helpers (`app/src/screens/live/model.ts`):
 * every statistic it shows exists, a statistic's target range is its
 * definition's "normal" band (a percentage only), a value's band places it
 * against the target, and the hands table's page buttons.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LIVE_STATS, minutesBetween, pageList, placeOf, targetRange } from "../../app/src/screens/live/model.js";
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
