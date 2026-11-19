/**
 * The nodelock editor's Ranges step state (`app/src/solver/nodelock/editor/ranges.ts`,
 * `docs/NODELOCK.md` §9.4): painting with undo and redo, a drag as one step,
 * reset to GTO, the lock and the summary it gives, the lineage line.
 */
import { describe, expect, it } from "vitest";

import { initialRangeEdit, rangeChanged, rangeEditLocks, rangeEditReducer, rangesLineage, rangeShifts, shiftPp } from "../../app/src/solver/nodelock/editor/ranges";
import { canonicalRange, combosOfClass, HAND_CLASSES, paintClasses, parseCards, parseRange } from "../../web/src/lib/solver/index";

const BOARD = parseCards(["As", "6h", "3d"]);
const gto: [Float64Array, Float64Array] = [Float64Array.from(canonicalRange(parseRange("AA,KK,QQ,AKs,AQo"), BOARD)), Float64Array.from(canonicalRange(parseRange("22-99,AJs,KQs,QJs"), BOARD))];
const k = (name: string) => HAND_CLASSES.findIndex((c) => c.name === name);

describe("the Ranges step's state", () => {
  it("paints, with a drag as one undo step, and undoes and redoes", () => {
    let s = initialRangeEdit(gto, undefined);
    expect(rangeChanged(s, 1, BOARD)).toBe(false);
    s = rangeEditReducer(s, { type: "set", player: 1, weights: paintClasses(s.ranges[1], [k("TT")], 1, BOARD) });
    s = rangeEditReducer(s, { type: "set", player: 1, weights: paintClasses(s.ranges[1], [k("JJ")], 1, BOARD), merge: true });
    expect(s.past).toHaveLength(1);
    expect(rangeChanged(s, 1, BOARD)).toBe(true);
    expect(rangeChanged(s, 0, BOARD)).toBe(false);
    s = rangeEditReducer(s, { type: "undo" });
    expect(rangeChanged(s, 1, BOARD)).toBe(false);
    s = rangeEditReducer(s, { type: "redo" });
    expect(s.ranges[1][combosOfClass(k("JJ"))[0]]).toBe(1);
    s = rangeEditReducer(s, { type: "reset", player: 1 });
    expect(rangeChanged(s, 1, BOARD)).toBe(false);
    expect(s.past).toHaveLength(2);
  });

  it("opens on a lock's ranges, and gives the lock and the summary", () => {
    const wide = paintClasses(gto[1], [k("TT"), k("JJ")], 1, BOARD);
    const s = initialRangeEdit(gto, [{ player: 1, weights: Array.from(wide) }]);
    const locks = rangeEditLocks(s, BOARD);
    expect(locks?.map((l) => l.player)).toEqual([1]);
    const shifts = rangeShifts(s, BOARD, ["BB", "BTN"]);
    expect(shifts).toHaveLength(1);
    expect(shifts![0].position).toBe("BTN");
    expect(shifts![0].added).toBeCloseTo(12, 9);
    expect(shifts![0].removed).toBe(0);
    // 12 of 1,176 live combos ≈ +1 pp.
    expect(shiftPp(shifts![0])).toBe(1);
    expect(rangesLineage(shifts, { shift: (p, pp) => `${p} +${pp}%`, lineage: (x) => `Ranges: ${x}` })).toBe("Ranges: BTN +1%");
    expect(rangesLineage(undefined, { shift: () => "", lineage: (x) => x })).toBeNull();
    expect(rangeEditLocks(initialRangeEdit(gto, undefined), BOARD)).toBeUndefined();
  });
});
