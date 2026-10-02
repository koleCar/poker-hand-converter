/**
 * One hand against a weighted range (`lib/equity/range.ts`).
 *
 * The anchor is `equity()`, which has its own suite: a range of one combo is
 * just a heads-up all-in, so the two engines must agree exactly whenever both
 * enumerate. Everything else here is the range notation, card removal, and the
 * determinism a stored analysis depends on.
 */

import { describe, expect, it } from "vitest";

import {
  allClasses,
  classCombos,
  equity,
  equityVsRange,
  parseRange,
  rangeCombos,
  rangeShare,
  strongestOfRange,
  cardIndex,
  EquityInputError,
} from "../../frontend/src/lib/equity/index.js";

const sorted = (range: Map<string, number>) => [...range.keys()].sort();

describe("range notation", () => {
  it("has 169 classes and 1,326 combos", () => {
    expect(allClasses()).toHaveLength(169);
    expect(allClasses().reduce((sum, name) => sum + classCombos(name).length, 0)).toBe(1326);
    expect(rangeShare(parseRange("*"))).toBe(1);
  });

  it("reads pairs-plus, kicker-plus and spans", () => {
    expect(sorted(parseRange("QQ+"))).toEqual(["AA", "KK", "QQ"]);
    expect(sorted(parseRange("ATs+"))).toEqual(["AJs", "AKs", "AQs", "ATs"]);
    expect(sorted(parseRange("77-55"))).toEqual(["55", "66", "77"]);
    expect(sorted(parseRange("T9s-76s"))).toEqual(["76s", "87s", "98s", "T9s"]);
    expect(sorted(parseRange("KQ"))).toEqual(["KQo", "KQs"]);
  });

  it("keeps the larger weight when a class is named twice", () => {
    const range = parseRange("AKs, AK:0.5");
    expect(range.get("AKs")).toBe(1);
    expect(range.get("AKo")).toBe(0.5);
  });

  it("refuses what it cannot read, rather than skipping it", () => {
    expect(() => parseRange("AX")).toThrow(EquityInputError);
    expect(() => parseRange("AKs:2")).toThrow(EquityInputError);
    expect(() => parseRange("KAs")).toThrow(EquityInputError);
    expect(() => parseRange("T9s-75s")).toThrow(EquityInputError);
  });

  it("removes every combo that touches a dead card", () => {
    expect(rangeCombos(parseRange("AKs"), [cardIndex("As")])).toHaveLength(3);
    expect(rangeCombos(parseRange("AA"), [cardIndex("As"), cardIndex("Ah")])).toHaveLength(1);
    expect(rangeCombos(parseRange("72o"))).toHaveLength(12);
  });
});

describe("equityVsRange", () => {
  it("agrees exactly with equity() for a range of one combo", () => {
    const board = ["Qh", "7h", "2c", "3s"];
    const single = [{ cards: [cardIndex("Qs"), cardIndex("Qd")] as [number, number], weight: 1 }];
    const ours = equityVsRange({ hero: ["Ah", "Kh"], range: single, board });
    const theirs = equity({ game: "holdem", hands: [["Ah", "Kh"], ["Qs", "Qd"]], board });
    expect(ours.method).toBe("exhaustive");
    expect(ours.equity).toBeCloseTo(theirs.equity[0], 12);
  });

  it("weights each combo by its weight, not by its class", () => {
    // Two villains: one hand the hero always beats, one it never does.
    const board = ["2c", "7d", "9h", "Kc", "3s"];
    const range = [
      { cards: [cardIndex("4h"), cardIndex("5h")] as [number, number], weight: 1 },
      { cards: [cardIndex("Ks"), cardIndex("Kd")] as [number, number], weight: 0.25 },
    ];
    const result = equityVsRange({ hero: ["Ah", "Ad"], range, board });
    expect(result.equity).toBeCloseTo(1 / 1.25, 12);
    expect(result.win).toBeCloseTo(0.8, 12);
    expect(result.tie).toBe(0);
  });

  it("is exhaustive on the turn and the river and sampled on the flop, deterministically", () => {
    const range = parseRange("22+, A2s+, KTs+, ATo+, KJo+");
    expect(equityVsRange({ hero: ["Jh", "Th"], range, board: ["9h", "8c", "2d", "Ks"] }).method).toBe("exhaustive");
    const a = equityVsRange({ hero: ["Jh", "Th"], range, board: ["9h", "8c", "2d"], seed: 7 });
    const b = equityVsRange({ hero: ["Jh", "Th"], range, board: ["9h", "8c", "2d"], seed: 7 });
    expect(a.method).toBe("monte-carlo");
    expect(a).toEqual(b);
    const exact = equityVsRange({ hero: ["Jh", "Th"], range, board: ["9h", "8c", "2d"], method: "exhaustive" });
    expect(Math.abs(a.equity - exact.equity)).toBeLessThan(0.02);
  });

  it("applies card removal from the hero's hand and the board", () => {
    // AsKs on an ace-high board: the opponent has 3 aces left, not 4.
    const result = equityVsRange({ hero: ["As", "Ks"], range: parseRange("AA"), board: ["Ad", "7c", "2h", "9s", "Jd"] });
    expect(result.combos).toBe(1);
    expect(result.equity).toBe(0);
  });

  it("says so when card removal empties the range, instead of dividing by zero", () => {
    const result = equityVsRange({ hero: ["As", "Ah"], range: parseRange("AA"), board: ["Ad", "7c", "2h"] });
    expect(result.combos).toBe(0);
  });

  it("refuses an impossible request", () => {
    expect(() => equityVsRange({ hero: ["As", "As"], range: parseRange("KK") })).toThrow(EquityInputError);
    expect(() => equityVsRange({ hero: ["As", "Kd"], range: parseRange("KK"), board: ["2c", "3c"] })).toThrow(
      EquityInputError,
    );
  });
});

describe("strongestOfRange", () => {
  it("keeps the best hands on the board, ties at the cut included", () => {
    const board = ["Kd", "7c", "2s", "9h", "3d"];
    const range = parseRange("KK, 77, AK, KQ, QJ, T8");
    const top = strongestOfRange(range, board, 0.05);
    // 62 combos, 5% of them is 3.1: the three sets of kings, then the cut lands
    // inside the sets of sevens, which all go in because they tie.
    const names = new Set(top.map((combo) => combo.cards.map((card) => card >> 2).join(",")));
    expect(top.length).toBeGreaterThanOrEqual(3);
    expect([...names].every((ranks) => ranks === "11,11" || ranks === "5,5")).toBe(true);
    // Never weaker against the hero than the whole range.
    const whole = equityVsRange({ hero: ["Ah", "Kc"], range, board });
    const strong = equityVsRange({ hero: ["Ah", "Kc"], range: strongestOfRange(range, board, 0.25), board });
    expect(strong.equity).toBeLessThanOrEqual(whole.equity);
  });
});
