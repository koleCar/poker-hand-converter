/**
 * Range locks (`docs/NODELOCK.md` §9.1): the ranges a nodelock solves the
 * flop from. The text syntax both ways, the canonical form and its hash, the
 * stored set's versions, the diff against GTO, the class shortcuts and the
 * quick scale, and the symmetry a range keeps.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalRange,
  classScores,
  classSet,
  classWeights,
  combosOfClass,
  formatRange,
  HAND_CLASSES,
  lockHash,
  lockSymmetries,
  liveCombos,
  NUM_COMBOS,
  paintClasses,
  parseCards,
  parseCombo,
  parseRange,
  parseRangeText,
  rangeDiff,
  rangeLocksOf,
  rangeLockSize,
  rangesHash,
  rangesWith,
  readLockSet,
  scaleRange,
  SolverInputError,
  withLockRanges,
  type LockSet,
} from "../../../web/src/lib/solver/index.js";

const BOARD = parseCards(["Ks", "8s", "2d"]);
const SPOT = { set: "test", line: "btn-bb", flop: "Ks8s2d" };
const classOf = (name: string) => HAND_CLASSES.findIndex((c) => c.name === name);

describe("range text", () => {
  it("reads the usual syntax, a weight as a share or a percentage", () => {
    const w = parseRangeText("AA, AKs,AQo:0.5 TT+ A2s-A5s AsKh:50%");
    for (const c of combosOfClass(classOf("AA"))) expect(w[c]).toBe(1);
    for (const c of combosOfClass(classOf("AQo"))) expect(w[c]).toBe(0.5);
    for (const name of ["TT", "JJ", "QQ", "KK", "A2s", "A3s", "A4s", "A5s"]) expect(w[combosOfClass(classOf(name))[0]]).toBe(1);
    expect(w[parseCombo("AsKh")]).toBe(0.5);
    expect(w[combosOfClass(classOf("99"))[0]]).toBe(0);
    expect(() => parseRangeText("AA,ZZ")).toThrow(SolverInputError);
    expect(() => parseRangeText("AA:150")).toThrow(SolverInputError);
  });

  it("writes a range that reads back the same, combo by combo where a class is mixed", () => {
    const w = parseRange("AA,KK:0.75,AKs,AQo:0.3333,76s:0.25,JTo");
    w[parseCombo("AhKh")] = 0.5;
    const text = formatRange(w);
    expect(text.startsWith("AA,AhKh:0.5")).toBe(false);
    expect(text).toContain("KK:0.75");
    expect(text).toContain("AhKh:0.5");
    expect(Array.from(parseRangeText(text))).toEqual(canonicalRange(w, []));
  });

  it("leaves out the board's combos", () => {
    const w = parseRange("KK,AKs");
    const text = formatRange(w, BOARD);
    // Three of KK's six combos hold the K♠: the other three are written as the class.
    expect(text).toBe("AKs,KK");
    expect(classWeights(w, BOARD).live[classOf("KK")]).toBe(3);
  });
});

describe("the canonical lock", () => {
  const gto: [Float64Array, Float64Array] = [parseRange("KK,88,AKs,KQs,QJs:0.5"), parseRange("AA,QQ,AQs,K8s")];

  it("is no lock at all when nothing changed on a live combo", () => {
    const edited = rangesWith(gto, null);
    // A board combo changed: no difference that counts.
    edited[0][parseCombo("KsKh")] = 0;
    expect(rangeLocksOf(gto, edited, BOARD)).toBeUndefined();
    edited[0][parseCombo("QhJh")] = 0.50004;
    expect(rangeLocksOf(gto, edited, BOARD)).toBeUndefined();
  });

  it("keeps only the changed player, quantised, with the board's combos 0", () => {
    const edited = rangesWith(gto, null);
    edited[1] = paintClasses(edited[1], [classOf("JJ")], 0.123456, BOARD);
    const locks = rangeLocksOf(gto, edited, BOARD);
    expect(locks?.map((l) => l.player)).toEqual([1]);
    const weights = locks![0].weights;
    expect(weights).toHaveLength(NUM_COMBOS);
    expect(weights[combosOfClass(classOf("JJ"))[0]]).toBe(0.1235);
    const live = liveCombos(BOARD);
    for (let c = 0; c < NUM_COMBOS; c += 1) if (!live[c]) expect(weights[c]).toBe(0);
    expect(rangesWith(gto, locks)[1][combosOfClass(classOf("JJ"))[0]]).toBe(0.1235);
  });

  it("hashes a set without ranges as v1 always did, and one with them apart", () => {
    const v1: LockSet = { version: 1, spot: SPOT, nodes: [], earlier: "player", targetPct: 1 };
    const flop = { ...v1, nodes: [{ street: "flop" as const, path: "", player: 0 as const, actions: ["X"], strategy: [new Array<number>(NUM_COMBOS).fill(1)], locked: new Array<number>(NUM_COMBOS).fill(1) }] };
    expect(lockHash(withLockRanges(flop, undefined))).toBe(lockHash(flop));
    expect(withLockRanges(flop, []).version).toBe(1);
    const edited = rangesWith(gto, null);
    edited[0] = paintClasses(edited[0], [classOf("A5s")], 1, BOARD);
    const ranged = withLockRanges(flop, rangeLocksOf(gto, edited, BOARD));
    expect(ranged.version).toBe(2);
    expect(lockHash(ranged)).not.toBe(lockHash(flop));
    // The same picture, painted another way, hashes the same.
    const again = rangesWith(gto, null);
    again[0] = paintClasses(paintClasses(again[0], [classOf("A5s")], 0.3, BOARD), [classOf("A5s")], 1, BOARD);
    expect(lockHash(withLockRanges(flop, rangeLocksOf(gto, again, BOARD)))).toBe(lockHash(ranged));
    expect(rangesHash(ranged.ranges)).toMatch(/^[0-9a-f]{64}$/);
    expect(rangesHash(undefined)).toBeNull();
  });
});

describe("stored lock sets (readLockSet)", () => {
  const node = { street: "flop" as const, path: "", player: 0 as const, actions: ["X"], strategy: [[1]], locked: [1] };
  const ranges = [{ player: 1 as const, weights: new Array<number>(NUM_COMBOS).fill(0.5) }];

  it("reads a v1 row as it is, so its stored hash stays its hash", () => {
    const v1 = { version: 1, spot: SPOT, nodes: [node], earlier: "player", targetPct: 1 };
    const read = readLockSet(JSON.parse(JSON.stringify(v1)));
    expect(read).toEqual(v1);
    expect(lockHash(read!)).toBe(lockHash(v1 as LockSet));
  });

  it("reads a v2 set with its ranges, a ranges-only one too", () => {
    expect(readLockSet({ version: 2, spot: SPOT, nodes: [node], earlier: "player", targetPct: 1, ranges })?.ranges).toEqual(ranges);
    expect(readLockSet({ version: 2, spot: SPOT, nodes: [], earlier: "player", targetPct: 1, ranges })?.nodes).toEqual([]);
  });

  it("refuses what it cannot apply", () => {
    expect(readLockSet(null)).toBeNull();
    expect(readLockSet({ version: 3, spot: SPOT, nodes: [node], earlier: "player", targetPct: 1 })).toBeNull();
    expect(readLockSet({ version: 1, spot: SPOT, nodes: [], earlier: "player", targetPct: 1 })).toBeNull();
    expect(readLockSet({ version: 1, spot: SPOT, nodes: [node], earlier: "player", targetPct: 1, ranges })).toBeNull();
    expect(readLockSet({ version: 2, spot: SPOT, nodes: [node], earlier: "player", targetPct: 1 })).toBeNull();
    expect(readLockSet({ version: 2, spot: SPOT, nodes: [{ ...node, street: "turn" }], earlier: "player", targetPct: 1, ranges })).toBeNull();
    expect(readLockSet({ version: 2, spot: SPOT, nodes: [], earlier: "player", targetPct: 1, ranges: [{ player: 0, weights: [1] }] })).toBeNull();
  });
});

describe("diff, shortcuts and scale", () => {
  it("counts the combos added and removed over the live combos", () => {
    const gto = parseRange("KK,QQ,AKs");
    const edited = parseRange("KK,JJ,AKs:0.5");
    const diff = rangeDiff(gto, edited, BOARD);
    // JJ: 6 combos in; QQ: 6 out; AKs: 3 live combos (A♠K♠ holds the K♠) half out.
    expect(diff.added).toBeCloseTo(6, 9);
    expect(diff.removed).toBeCloseTo(6 + 1.5, 9);
    expect(diff.gto.combos).toBeCloseTo(3 + 6 + 3, 9);
    expect(diff.edited.share).toBeCloseTo(diff.edited.combos / 1176, 12);
    expect(rangeLockSize(edited, []).share).toBeCloseTo((6 + 6 + 2) / 1326, 12);
  });

  it("has the class shortcuts a range editor needs", () => {
    expect(classSet("pairs")).toHaveLength(13);
    expect(classSet("suited")).toHaveLength(78);
    expect(classSet("offsuit")).toHaveLength(78);
    expect(classSet("broadways")).toHaveLength(25);
    expect(classSet("axSuited")).toHaveLength(12);
    expect(classSet("suitedConnectors").map((k) => HAND_CLASSES[k].name).sort()).toEqual(
      ["AKs", "KQs", "QJs", "JTs", "T9s", "98s", "87s", "76s", "65s", "54s", "43s", "32s"].sort(),
    );
  });

  it("widens with the best hands first and tightens with the worst first, by whole classes", () => {
    const score = Float64Array.from(HAND_CLASSES, (c) => c.hi * 13 + c.lo + (c.pair ? 200 : 0));
    const gto = parseRange("AA,KK,QQ,AKs");
    const before = rangeLockSize(gto, BOARD);
    const wider = scaleRange(gto, 0.01, score, BOARD);
    const after = rangeLockSize(wider, BOARD);
    expect(after.share - before.share).toBeCloseTo(0.01, 4);
    // JJ is the best pair not in: fully in; TT partly.
    expect(wider[combosOfClass(classOf("JJ"))[0]]).toBe(1);
    expect(wider[combosOfClass(classOf("TT"))[0]]).toBeGreaterThan(0);
    expect(wider[combosOfClass(classOf("TT"))[0]]).toBeLessThan(1);
    expect(wider[combosOfClass(classOf("22"))[0]]).toBe(0);
    const tighter = scaleRange(gto, -0.005, score, BOARD);
    expect(rangeLockSize(tighter, BOARD).share - before.share).toBeCloseTo(-0.005, 4);
    // AKs scores lowest of the four: it goes first.
    expect(tighter[parseCombo("AhKh")]).toBeLessThan(1);
    expect(tighter[parseCombo("AhAd")]).toBe(1);
  });

  it("widens a range from its edge: the hands better than its best come last", () => {
    // A calling range without the hands the line raised with: AA, KK stay out until everything below is in.
    const score = Float64Array.from(HAND_CLASSES, (c) => c.hi * 13 + c.lo + (c.pair ? 200 : 0));
    const calls = parseRange("QQ,JJ,TT");
    const wider = scaleRange(calls, 0.02, score, BOARD);
    expect(wider[parseCombo("AhAd")]).toBe(0);
    expect(wider[parseCombo("9h9d")]).toBe(1);
  });

  it("scores classes by preflop equity against the opponent's range", () => {
    // A tiny made-up table: class i beats class j by (i < j) in grid order.
    const n = HAND_CLASSES.length;
    const table = Float64Array.from({ length: n * n }, (_, k) => (Math.floor(k / n) < k % n ? 0.6 : 0.4));
    const scores = classScores(parseRange("22"), table);
    expect(scores[0]).toBeCloseTo(0.6, 12);
    expect(scores[n - 1]).toBeCloseTo(0.4, 12);
  });
});

describe("symmetry", () => {
  it("keeps a relabelling only when it maps every range lock onto itself", () => {
    const base: LockSet = { version: 2, spot: SPOT, nodes: [], earlier: "player", targetPct: 1, ranges: [{ player: 0, weights: canonicalRange(parseRange("AA,AKs"), BOARD) }] };
    const all = lockSymmetries({ ...base, ranges: undefined, version: 1 } as LockSet & { nodes: [] }, BOARD);
    expect(lockSymmetries(base, BOARD)).toHaveLength(all.length);
    // One suited combo alone breaks the hearts-clubs swap.
    const one = canonicalRange(parseRange("AhKh"), BOARD);
    expect(lockSymmetries({ ...base, ranges: [{ player: 0, weights: one }] }, BOARD).length).toBeLessThan(all.length);
  });
});
