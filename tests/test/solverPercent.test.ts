/**
 * The Solver library's printed frequencies (`shownPercent`,
 * `web/src/lib/format.ts`, through the `solver` dictionaries): one decimal
 * at the edges, whole between, and 0% or 100% only for exactly 0 or 1 - a
 * 99.6% fold beside a 0.4% call never reads 100%.
 */

import { describe, expect, it } from "vitest";

import { shownPercent } from "../../web/src/lib/format.js";
import { en } from "../../web/src/lib/i18n/en.js";
import { hr } from "../../web/src/lib/i18n/hr.js";

describe("shownPercent", () => {
  it("prints one decimal under 10% and over 90%, whole between", () => {
    expect(shownPercent(0.045)).toEqual({ value: 4.5, digits: 1, bound: null });
    expect(shownPercent(0.004)).toEqual({ value: 0.4, digits: 1, bound: null });
    expect(shownPercent(0.523)).toEqual({ value: 52, digits: 0, bound: null });
    expect(shownPercent(0.955)).toEqual({ value: 95.5, digits: 1, bound: null });
    expect(shownPercent(0.996)).toEqual({ value: 99.6, digits: 1, bound: null });
    // On the band's edge a tenth that rounds into it reads whole: 10%, not 10.0%.
    expect(shownPercent(0.0996)).toEqual({ value: 10, digits: 0, bound: null });
    expect(shownPercent(0.9004)).toEqual({ value: 90, digits: 0, bound: null });
  });

  it("reads 0% and 100% only for exactly 0 and 1", () => {
    expect(shownPercent(0)).toEqual({ value: 0, digits: 0, bound: null });
    expect(shownPercent(1)).toEqual({ value: 100, digits: 0, bound: null });
    expect(shownPercent(0.0004)).toEqual({ value: 0.1, digits: 1, bound: "<" });
    expect(shownPercent(0.9996)).toEqual({ value: 99.9, digits: 1, bound: ">" });
    // Rounding up to the next tenth is not a bound.
    expect(shownPercent(0.0006)).toEqual({ value: 0.1, digits: 1, bound: null });
    expect(shownPercent(0.9994)).toEqual({ value: 99.9, digits: 1, bound: null });
  });

  it("never prints 0 or 100 for anything strictly between", () => {
    const wrong: number[] = [];
    for (let i = 1; i < 100000; i += 1) {
      const shown = shownPercent(i / 100000);
      if (!(shown.value > 0 && shown.value < 100)) wrong.push(i / 100000);
    }
    expect(wrong).toEqual([]);
  });
});

describe("the solver dictionaries' frequencies", () => {
  it("reads a cell's mix without passing 100%", () => {
    expect(en.solver.cellLabel("A6s", [en.solver.part("Fold", 0.996), en.solver.part("Call", 0.004)], false)).toBe(
      "A6s: Fold 99.6%, Call 0.4%",
    );
    expect([0, 0.0004, 0.045, 0.52, 0.9996, 1].map(en.solver.freq)).toEqual(["0%", "<0.1%", "4.5%", "52%", ">99.9%", "100%"]);
    expect([0, 0.0004, 0.045, 0.52, 0.9996, 1].map(hr.solver.freq)).toEqual(["0 %", "<0,1 %", "4,5 %", "52 %", ">99,9 %", "100 %"]);
    expect(en.solver.shareOnly(0.996)).toBe("99.6%");
  });
});
