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
  nextSort,
  pageList,
  perHundred,
  placeOf,
  rangeBar,
  rangeColour,
  rangeScore,
  sortHands,
  targetRange,
} from "../../app/src/screens/live/model.js";
import { dateRange, EMPTY_FILTER, isInstant, POSITION_ORDER } from "../../packages/ui/hands/filter.js";
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

  it("leaves the win rates to the graph", () => {
    expect(LIVE_STATS).not.toContain("bb_per_100");
    expect(LIVE_STATS).not.toContain("allin_ev_bb_per_100");
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

describe("Live: the hands table's order", () => {
  const hand = (id: string, over: Partial<Parameters<typeof sortHands>[0][number]> = {}) => ({
    id,
    heroCards: [] as string[],
    board: [] as string[],
    heroPosition: null as string | null,
    totalPot: 0,
    bigBlind: 100,
    heroNet: null as number | null,
    heroNetBbMilli: null as number | null,
    ...over,
  });
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

  it("cycles a column: its first direction, the other, then the newest first", () => {
    expect(nextSort(null, "pot")).toEqual({ column: "pot", descending: true });
    expect(nextSort({ column: "pot", descending: true }, "pot")).toEqual({ column: "pot", descending: false });
    expect(nextSort({ column: "pot", descending: false }, "pot")).toBeNull();
    expect(nextSort(null, "position")).toEqual({ column: "position", descending: false });
    expect(nextSort({ column: "pot", descending: false }, "result")).toEqual({ column: "result", descending: true });
  });

  it("keeps the newest first without a sort and between equal hands", () => {
    const rows = [hand("a", { totalPot: 5 }), hand("b", { totalPot: 9 }), hand("c", { totalPot: 5 })];
    expect(ids(sortHands(rows, null, "bb", POSITION_ORDER))).toEqual(["a", "b", "c"]);
    expect(ids(sortHands(rows, { column: "pot", descending: true }, "money", POSITION_ORDER))).toEqual(["b", "a", "c"]);
    expect(ids(sortHands(rows, { column: "pot", descending: false }, "money", POSITION_ORDER))).toEqual(["a", "c", "b"]);
  });

  it("puts pairs above unpaired hands and suited above offsuit", () => {
    const rows = [
      hand("AKo", { heroCards: ["Ah", "Kd"] }),
      hand("22", { heroCards: ["2c", "2d"] }),
      hand("AKs", { heroCards: ["As", "Ks"] }),
      hand("none"),
      hand("KK", { heroCards: ["Kc", "Kh"] }),
      hand("T9s", { heroCards: ["Th", "9h"] }),
    ];
    expect(ids(sortHands(rows, { column: "hand", descending: true }, "bb", POSITION_ORDER))).toEqual(["KK", "22", "AKs", "AKo", "T9s", "none"]);
    expect(ids(sortHands(rows, { column: "hand", descending: false }, "bb", POSITION_ORDER))).toEqual(["T9s", "AKo", "AKs", "22", "KK", "none"]);
  });

  it("orders boards by street, positions by the order of action", () => {
    const boards = [hand("flop", { board: ["Ah", "2c", "3d"] }), hand("pre"), hand("river", { board: ["2h", "3c", "4d", "5s", "7h"] })];
    expect(ids(sortHands(boards, { column: "board", descending: true }, "bb", POSITION_ORDER))).toEqual(["river", "flop", "pre"]);
    const seats = [hand("bb", { heroPosition: "BB" }), hand("utg", { heroPosition: "UTG" }), hand("none"), hand("btn", { heroPosition: "BTN" })];
    expect(ids(sortHands(seats, { column: "position", descending: false }, "bb", POSITION_ORDER))).toEqual(["utg", "btn", "bb", "none"]);
  });

  it("sorts the result in the screen's unit, hands without one last", () => {
    const rows = [
      hand("small-bb-big-money", { heroNet: 5000, heroNetBbMilli: 2000 }),
      hand("none"),
      hand("big-bb-small-money", { heroNet: 100, heroNetBbMilli: 9000 }),
      hand("loss", { heroNet: -300, heroNetBbMilli: -3000 }),
    ];
    expect(ids(sortHands(rows, { column: "result", descending: true }, "bb", POSITION_ORDER))).toEqual([
      "big-bb-small-money",
      "small-bb-big-money",
      "loss",
      "none",
    ]);
    expect(ids(sortHands(rows, { column: "result", descending: true }, "money", POSITION_ORDER))).toEqual([
      "small-bb-big-money",
      "big-bb-small-money",
      "loss",
      "none",
    ]);
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
