/**
 * Action translation, the spot key, and combo/range parsing - the small pure
 * pieces the grading pipeline will lean on.
 */

import { describe, expect, it } from "vitest";

import {
  comboCards,
  comboCode,
  comboIndex,
  NUM_COMBOS,
  OFF_TREE_DISTANCE,
  parseCombo,
  parseRange,
  permuteRange,
  pseudoHarmonic,
  rangeSize,
  SolverInputError,
  spotHash,
  spotKey,
  SUIT_PERMUTATIONS,
  toRange,
  translateSize,
  type SpotKeyParts,
} from "../../../frontend/src/lib/solver/index.js";

describe("pseudo-harmonic action translation", () => {
  it("maps the endpoints to themselves and is decreasing in between", () => {
    expect(pseudoHarmonic(0.33, 0.33, 0.75)).toBe(1);
    expect(pseudoHarmonic(0.75, 0.33, 0.75)).toBe(0);
    let last = 1;
    for (let x = 0.34; x < 0.75; x += 0.01) {
      const f = pseudoHarmonic(x, 0.33, 0.75);
      expect(f).toBeLessThan(last);
      last = f;
    }
  });

  it("matches Ganzfried & Sandholm's formula", () => {
    // f(x) = (B - x)(1 + A) / ((B - A)(1 + x))
    expect(pseudoHarmonic(0.5, 0.33, 0.75)).toBeCloseTo((0.25 * 1.33) / (0.42 * 1.5), 12);
    // Half pot between a third and a full pot: slightly favours the smaller size.
    expect(pseudoHarmonic(0.5, 1 / 3, 1)).toBeCloseTo(0.5 * (4 / 3) / ((2 / 3) * 1.5), 12);
    // Not linear: the midpoint maps to A less than half the time.
    expect(pseudoHarmonic(0.54, 0.33, 0.75)).toBeLessThan(0.5);
  });

  it("translates a real size onto the nearest sizes in any order", () => {
    const sizes = [0.75, 0.33, 4];
    const mid = translateSize(0.5, sizes);
    expect(mid.mapped.map((m) => m.index)).toEqual([1, 0]);
    expect(mid.mapped[0].probability + mid.mapped[1].probability).toBeCloseTo(1, 12);
    expect(mid.offTree).toBe(false);

    expect(translateSize(0.75, sizes).mapped).toEqual([{ index: 0, size: 0.75, probability: 1 }]);
    expect(translateSize(0.1, sizes).mapped).toEqual([{ index: 1, size: 0.33, probability: 1 }]);
    expect(translateSize(6, sizes).mapped).toEqual([{ index: 2, size: 4, probability: 1 }]);
  });

  it("flags a size more than a quarter pot from every solved size as off-tree", () => {
    expect(OFF_TREE_DISTANCE).toBe(0.25);
    expect(translateSize(2, [0.33, 0.75, 4]).offTree).toBe(true);
    expect(translateSize(0.95, [0.33, 0.75, 4]).offTree).toBe(false);
    expect(translateSize(1.1, [0.33, 0.75, 4]).offTree).toBe(true);
  });
});

describe("spot key", () => {
  const parts: SpotKeyParts = {
    format: "nlhe-cash",
    players: 6,
    stackBucket: "100bb",
    preflopLine: "srp",
    positions: ["BB", "BTN"],
    board: ["Ah", "Kd", "7c", "2s", "3h"],
    line: "X-B33-C/X-X",
    sprBucket: "spr4",
    rake: "5%/3bb",
    tree: "m1",
  };

  it("reads as the canonical spot, with no hole cards or names", () => {
    expect(spotKey(parts)).toBe("spot1|nlhe-cash|6|100bb|srp|BB>BTN|AsKh7d2c3s|X-B33-C/X-X|spr4|5%/3bb|m1|-");
    expect(spotHash(spotKey(parts))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is the same for isomorphic boards and different for different spots", () => {
    const iso = spotKey({ ...parts, board: ["Ac", "Ks", "7h", "2d", "3c"] });
    expect(iso).toBe(spotKey(parts));
    expect(spotKey({ ...parts, line: "X-B75-C/X-X" })).not.toBe(spotKey(parts));
    expect(spotHash(spotKey({ ...parts, rake: "none" }))).not.toBe(spotHash(spotKey(parts)));
  });

  it("hashes ranges after relabelling them with the board, ignoring float noise", () => {
    const r0 = parseRange("AA-TT,AKs,AhQh:0.5");
    const r1 = parseRange("KK-77,KQs,AJo");
    const key = spotKey({ ...parts, ranges: [r0, r1] });
    expect(key.endsWith("|-")).toBe(false);
    // Swap hearts and clubs everywhere: the same spot.
    const swap = SUIT_PERMUTATIONS.find((p) => p.join("") === "0321") as number[];
    const relabelled = spotKey({
      ...parts,
      board: ["Ac", "Kd", "7h", "2s", "3c"],
      ranges: [permuteRange(r0, swap), permuteRange(r1, swap)],
    });
    expect(relabelled).toBe(key);
    const noisy = Float64Array.from(r0, (w) => (w ? w - 1e-7 : 0));
    expect(spotKey({ ...parts, ranges: [noisy, r1] })).toBe(key);
    const narrower = Float64Array.from(r0);
    narrower[parseCombo("AsAd")] = 0;
    expect(spotKey({ ...parts, ranges: [narrower, r1] })).not.toBe(key);
  });

  it("refuses fields that would make the key ambiguous", () => {
    expect(() => spotKey({ ...parts, line: "X|B" })).toThrow(SolverInputError);
    expect(() => spotKey({ ...parts, tree: "my tree" })).toThrow(SolverInputError);
  });
});

describe("combos and ranges", () => {
  it("index all 1326 combos without holes", () => {
    const seen = new Set<number>();
    for (let a = 0; a < 52; a += 1) {
      for (let b = 0; b < a; b += 1) {
        const index = comboIndex(a, b);
        expect(comboIndex(b, a)).toBe(index);
        expect(comboCards(index)).toEqual([a, b]);
        seen.add(index);
      }
    }
    expect(seen.size).toBe(NUM_COMBOS);
    expect(Math.max(...seen)).toBe(NUM_COMBOS - 1);
    expect(comboCode(parseCombo("KdAh"))).toBe("AhKd");
    expect(parseCombo("AhAh")).toBe(-1);
  });

  it("parse the usual range notation", () => {
    const count = (text: string) => parseRange(text).reduce((a, w) => a + (w > 0 ? 1 : 0), 0);
    expect(count("AA")).toBe(6);
    expect(count("AKs")).toBe(4);
    expect(count("AKo")).toBe(12);
    expect(count("AK")).toBe(16);
    expect(count("TT+")).toBe(30);
    expect(count("22-55")).toBe(24);
    expect(count("A2s+")).toBe(48);
    expect(count("A5s-A2s")).toBe(16);
    expect(count("KTo+")).toBe(36);
    expect(count("T9s-54s")).toBe(24);
    expect(count("AhKh, AsKs")).toBe(2);
    expect(count("AA-22, AKs")).toBe(82);
  });

  it("let later tokens override earlier ones, and carry weights", () => {
    const range = parseRange("AA-QQ:0.5, AA");
    expect(range[parseCombo("AhAd")]).toBe(1);
    expect(range[parseCombo("KhKd")]).toBe(0.5);
    expect(parseRange("JJ+, QQ:0")[parseCombo("QsQc")]).toBe(0);
    expect(rangeSize(parseRange("AA,KK"), [48])).toBe(9); // As removed: 3 aces left
  });

  it("accept vectors and maps, and reject junk", () => {
    expect(toRange({ AhKh: 0.25 })[parseCombo("AhKh")]).toBe(0.25);
    expect(toRange(new Float64Array(NUM_COMBOS).fill(1)).length).toBe(NUM_COMBOS);
    expect(() => parseRange("AKx")).toThrow(SolverInputError);
    expect(() => parseRange("AA:2")).toThrow(SolverInputError);
    expect(() => parseRange("AA-KQs")).toThrow(SolverInputError);
    expect(() => toRange([1, 2, 3])).toThrow(SolverInputError);
    expect(() => toRange({ Ah: 1 })).toThrow(SolverInputError);
  });
});
