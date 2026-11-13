/**
 * The Trainer's phases T3–T5 (`docs/TRAINER.md` §5): the range panel's
 * view, the mix input's grade, one button per action, saved drills, and the
 * turn spots "For you" deals for turn leaks.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { gradeMix, normalised } from "../../web/src/lib/training/frequency.js";
import { dealPreflop } from "../../web/src/lib/training/preflop.js";
import { spotRange } from "../../web/src/lib/training/rangeView.js";
import { generateRiverSpot } from "../../web/src/lib/training/river.js";
import type { AreaWhere, FocusArea } from "../../web/src/lib/training/plan.js";
import { groupChoices, groupForKey, type Choice } from "../../web/src/components/trainer/Decision.js";
import { parseDrills, withDrill, drillSettings } from "../../web/src/components/trainer/drills.js";
import { areaTarget, turnTarget } from "../../web/src/components/trainer/focus.js";
import { DEFAULT_SETTINGS, parseSettings, settingsFields, spotOptions, targetSettings } from "../../web/src/components/trainer/settings.js";
import { fullLibrary } from "./charts/support.js";

const library = fullLibrary();

describe("the range panel (T3)", () => {
  it("reads a preflop spot's chart node: 169 cells, the hero's class among those that reach it, shares summing to one", () => {
    const spot = dealPreflop(library, { set: DEFAULT_CHART_SET, family: "vs-open", seat: "BB", vs: "BTN", bias: "range" }, 5)!;
    const view = spotRange(spot, library, null)!;
    expect(view.cells).toHaveLength(169);
    expect(view.heroClass).toBe(spot.handClass);
    expect(view.cells.find((c) => c.name === spot.handClass)!.combos).toBeGreaterThan(0);
    expect(view.options).toHaveLength(spot.menu.length);
    expect(view.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
  });

  it("reads a river spot's solve: the same 169 cells, each reaching class's mix summing to one", () => {
    const spot = generateRiverSpot(library, { pot: "srp", seat: "ip" }, 21)!;
    const view = spotRange(spot, library, null)!;
    expect(view).not.toBeNull();
    expect(view.cells).toHaveLength(169);
    for (const cell of view.cells.filter((c) => c.combos > 0)) {
      expect(cell.freq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    }
  });
});

describe("answering with a mix (T5)", () => {
  const options = [
    { freq: 0.25, ev: 1 },
    { freq: 0.75, ev: 1.2 },
  ];

  it("is perfect at the reference's mix and loses only the EV of the worse share", () => {
    const exact = gradeMix([25, 75], options);
    expect(exact.accuracy).toBeCloseTo(1, 9);
    expect(exact.grade).toBe("perfect");
    expect(exact.evLoss).toBeCloseTo(0.05, 9);
  });

  it("falls with the distance between the mixes", () => {
    const flipped = gradeMix([75, 25], options);
    expect(flipped.accuracy).toBeCloseTo(0.5, 9);
    expect(flipped.grade).toBe("mistake");
    expect(gradeMix([0, 100], options).grade).toBe("good");
    expect(normalised([0, 0, 0])).toEqual([1, 0, 0]);
  });
});

describe("one button per action (T5)", () => {
  const choices: Choice[] = [
    { label: "Fold", tone: "fold", alias: "fold" },
    { label: "Call", tone: "call", alias: "call" },
    { label: "Raise to 9", tone: "raise", alias: null },
    { label: "Raise to 14", tone: "raise", alias: null },
    { label: "All-in", tone: "allin", alias: "allin" },
  ];

  it("keeps every size apart, or puts a raise's sizes behind one button (all-in its own)", () => {
    expect(groupChoices(choices, "all")).toEqual([[0], [1], [2], [3], [4]]);
    const simple = groupChoices(choices, "simple");
    expect(simple).toEqual([[0], [1], [2, 3], [4]]);
    expect(groupForKey(choices, simple, "3")).toBe(2);
    expect(groupForKey(choices, simple, "a")).toBe(3);
    expect(groupForKey(choices, simple, "c")).toBe(1);
  });
});

describe("saved drills (T4)", () => {
  it("keeps a named preset of the settings, newest first, a name saved again replaced", () => {
    const s1 = { ...DEFAULT_SETTINGS, mode: "flop" as const, side: "oop" as const, facing: "bet" as const };
    const s2 = { ...DEFAULT_SETTINGS, mode: "preflop" as const, family: "vs-3bet" as const };
    let drills = withDrill([], "BB flop vs bet", s1, "a");
    drills = withDrill(drills, "vs 3-bet", s2, "b");
    drills = withDrill(drills, "BB flop vs bet", { ...s1, pot: "3bp" }, "c");
    expect(drills.map((d) => d.name)).toEqual(["BB flop vs bet", "vs 3-bet"]);
    expect(drillSettings(drills[0])).toMatchObject({ mode: "flop", side: "oop", facing: "bet", pot: "3bp" });
    expect(withDrill(drills, "   ", s1, "d")).toHaveLength(2);
    expect(parseDrills([{ id: "x", name: "ok", fields: { mode: "omaha" } }, { nope: 1 }, "junk"])).toEqual([{ id: "x", name: "ok", fields: {} }]);
  });

  it("round-trips the new settings through their fields", () => {
    const s = { ...DEFAULT_SETTINGS, range: "strategy" as const, timebank: "15" as const, buttons: "simple" as const, input: "frequency" as const, tables: "2" as const };
    expect(settingsFields(s)).toEqual({ range: "strategy", timebank: "15", buttons: "simple", input: "frequency", tables: "2" });
    expect(parseSettings(settingsFields(s))).toEqual(s);
  });
});

describe("turn leaks in For you", () => {
  const where = (scenario: string, extra: Partial<AreaWhere> = {}): AreaWhere => ({ street: "turn", scenario, family: "", hero: "BB", villain: "BTN", ...extra });

  it("deals a turn spot with the area's role, side and pot", () => {
    expect(turnTarget(where("caller-oop-first"))).toEqual({ mode: "turn", pot: "srp", side: "oop", role: "caller" });
    expect(turnTarget(where("pfr-ip-vs-bet", { pot: "3bp" }))).toEqual({ mode: "turn", pot: "3bp", side: "ip", role: "pfr" });
    expect(turnTarget(where("caller-oop-first", { table: "hu" }))).toMatchObject({ set: "nlhe-cash-hu-100bb" });
    expect(turnTarget(where("caller-mw-oop-first"))).toBeNull();
    expect(turnTarget(where("caller-oop-first", { pot: "4bp" }))).toBeNull();
    expect(turnTarget({ ...where("caller-oop-first"), street: "river" })).toBeNull();
  });

  it("practises an area by its own trainer first, a turn area by its turn spot", () => {
    const turnArea = { trainer: null, where: where("caller-oop-first") } as unknown as FocusArea;
    const target = areaTarget(turnArea)!;
    expect(target.mode).toBe("turn");
    const shaped = targetSettings(target, DEFAULT_SETTINGS);
    expect(shaped.mode).toBe("turn");
    expect(spotOptions("turn", shaped.settings)).toMatchObject({ kind: "turn", options: { pot: "srp", seat: "oop", role: "caller" } });
  });
});
