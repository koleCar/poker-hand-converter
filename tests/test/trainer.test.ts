/**
 * The Trainer (`web/src/components/trainer`, `docs/TRAINER.md`): its pure
 * parts - the settings and what each mode deals from them, a leak's target
 * as settings, the "For you" rotation, the table read off a dealt spot, and
 * which rule of thumb explains it. The deal and the grade are the training
 * library's, tested on their own (`trainingHeadsUp`, `trainingFlopMode`).
 */

import { describe, expect, it } from "vitest";

import { analyzeHand } from "../../web/src/lib/analysis/index.js";
import type { DecisionAnalysis } from "../../web/src/lib/analysis/types.js";
import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { dealPreflop, preflopAnswer } from "../../web/src/lib/training/preflop.js";
import { generateRiverSpot } from "../../web/src/lib/training/river.js";
import type { FocusArea } from "../../web/src/lib/training/plan.js";
import { trainerEn } from "../../web/src/lib/i18n/ns/trainer.en.js";
import { trainerHr } from "../../web/src/lib/i18n/ns/trainer.hr.js";
import { aroundHero, feltOf } from "../../web/src/components/trainer/felt.js";
import { focusTarget, GENERAL, HANDS_PER_AREA, trainableAreas } from "../../web/src/components/trainer/focus.js";
import { principleOf } from "../../web/src/components/trainer/principles.js";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  settingsFields,
  spotOptions,
  targetSettings,
  type TrainerSettings,
} from "../../web/src/components/trainer/settings.js";
import { initialSettings } from "../../web/src/components/analysis/train/trainerQuery.js";
import { fullLibrary } from "./charts/support.js";

const library = fullLibrary();

describe("trainer settings", () => {
  it("opens on For you, waiting after every answer, with the strategy and the facts shown", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.mode).toBe("focus");
    expect(DEFAULT_SETTINGS.pause).toBe("always");
  });

  it("round-trips through its fields, keeping only what differs from the default", () => {
    const s: TrainerSettings = { ...DEFAULT_SETTINGS, mode: "flop", side: "oop", role: "caller", facing: "bet", seat: "BB", pause: "mistakes", strategy: false };
    const fields = settingsFields(s);
    expect(fields).toEqual({ mode: "flop", seat: "BB", side: "oop", role: "caller", facing: "bet", pause: "mistakes", strategy: "0" });
    expect(parseSettings(fields)).toEqual(s);
  });

  it("drops anything it does not know rather than throw", () => {
    const s = parseSettings({ mode: "omaha", set: "nope", seat: "XX", line: "not-a-line", facing: 3, strategy: "maybe" });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("reads the old trainer's addresses (the study plan's and the leaks' links) for the spot, this browser's for the rest", () => {
    const s = initialSettings({ mode: "preflop", family: "vs-3bet", seat: "BTN", set: DEFAULT_CHART_SET }, { pause: "mistakes", facts: "0", family: "rfi" });
    expect(s.mode).toBe("preflop");
    expect(s.family).toBe("vs-3bet");
    expect(s.seat).toBe("BTN");
    expect(s.pause).toBe("mistakes");
    expect(s.facts).toBe(false);
    // No mode in the address: the stored settings, whole.
    expect(initialSettings({}, { mode: "river", side: "ip" })).toMatchObject({ mode: "river", side: "ip" });
  });

  it("gives each street the options its generator reads, on a table it deals from", () => {
    const s: TrainerSettings = { ...DEFAULT_SETTINGS, set: "nlhe-cash-9max-100bb", family: "rfi", seat: "UTG", vs: "BB", side: "ip", facing: "raise" };
    const preflop = spotOptions("preflop", s);
    // First in nobody has raised: no raiser to face.
    expect(preflop).toEqual({ kind: "preflop", options: { set: "nlhe-cash-9max-100bb", family: "rfi", seat: "UTG", vs: null, bias: "borderline" } });
    // The river and turn trainers deal the default 6-max set or a heads-up one; a raise is the flop's only.
    const river = spotOptions("river", s);
    expect(river.kind).toBe("river");
    expect(river.options).toMatchObject({ set: DEFAULT_CHART_SET, seat: "ip", facing: "any" });
    expect(spotOptions("turn", s).options).toMatchObject({ set: DEFAULT_CHART_SET, facing: "any" });
    expect(spotOptions("flop", s).options).toMatchObject({ facing: "raise" });
  });

  it("turns a leak's trainer target into the street and the spot, keeping how the player trains", () => {
    const base: TrainerSettings = { ...DEFAULT_SETTINGS, pause: "mistakes", strategy: false };
    const preflop = targetSettings({ mode: "preflop", family: "vs-open", seat: "SB", vs: "BTN" }, base);
    expect(preflop.mode).toBe("preflop");
    expect(preflop.settings).toMatchObject({ family: "vs-open", seat: "SB", vs: "BTN", pause: "mistakes", strategy: false });
    const flop = targetSettings({ mode: "flop", set: DEFAULT_CHART_SET, pot: "srp", side: "oop", role: "caller", seat: "BB", facing: "bet", line: null }, base);
    expect(flop.mode).toBe("flop");
    expect(flop.settings).toMatchObject({ pot: "srp", side: "oop", role: "caller", seat: "BB", facing: "bet" });
    const river = targetSettings({ mode: "river", pot: "3bp", side: "ip", role: "pfr" }, base);
    expect(river).toMatchObject({ mode: "river", settings: { pot: "3bp", side: "ip", role: "pfr", facing: "any" } });
  });
});

describe("For you", () => {
  const area = (id: string, evLossBb: number, trainer: FocusArea["trainer"], confidence: FocusArea["confidence"] = "high") =>
    ({ id, evLossBb, trainer, confidence, mistakes: 10, where: { street: "river", scenario: "caller-mw-oop-first", family: "", hero: "BB", villain: "BTN" } }) as unknown as FocusArea;

  it("works through the areas it can deal, the costliest first, and only those", () => {
    const areas = [
      area("a", 9, { mode: "preflop", family: "vs-open", seat: "BB", vs: "BTN" }),
      // A multiway river: no trainer deals it.
      area("multiway", 8, null),
      area("b", 5, { mode: "river", pot: "srp", side: "ip", role: "any" }),
    ];
    const picked = trainableAreas(areas);
    expect(picked.map((a) => a.id)).toEqual(["a", "b"]);
    expect(focusTarget(picked, 0).area?.id).toBe("a");
    expect(focusTarget(picked, 1).area?.id).toBe("b");
    expect(focusTarget(picked, 2).area?.id).toBe("a");
    expect(HANDS_PER_AREA).toBeGreaterThan(1);
  });

  it("deals the commonly misplayed spots when there is no leak to read", () => {
    expect(focusTarget([], 0)).toEqual({ area: null, target: GENERAL[0] });
    expect(focusTarget([], GENERAL.length + 1).target).toEqual(GENERAL[1]);
    // Every general spot deals.
    for (const target of GENERAL) {
      const shaped = targetSettings(target, DEFAULT_SETTINGS);
      expect(spotOptions(shaped.mode, shaped.settings).kind).toBe(target.mode);
    }
  });
});

describe("the table", () => {
  it("draws a preflop spot from the hand: every seat, the hero at the bottom, what is in front, the line so far", () => {
    const spot = dealPreflop(library, { set: DEFAULT_CHART_SET, family: "vs-open", seat: "BB", vs: "BTN", bias: "range" }, 7)!;
    expect(spot).not.toBeNull();
    const felt = feltOf(spot.hand);
    expect(felt.seats).toHaveLength(6);
    expect(aroundHero(felt.seats)[0].hero).toBe(true);
    expect(felt.seats.find((seat) => seat.hero)?.position).toBe("BB");
    expect(felt.seats.find((seat) => seat.position === "BTN")?.betBb).toBe(2.5);
    expect(felt.seats.find((seat) => seat.position === "BTN")?.acting).toBe(true);
    expect(felt.board).toEqual([]);
    expect(felt.strip.filter((item) => item.kind === "act").map((item) => item.kind === "act" && `${item.position} ${item.action}`)).toEqual([
      "UTG fold",
      "HJ fold",
      "CO fold",
      "BTN raise",
      "SB fold",
    ]);
    expect(felt.totalBb).toBeCloseTo(4, 5);
  });

  it("shows a river spot's whole board and marks each street where its cards came", () => {
    const spot = generateRiverSpot(library, { pot: "srp", seat: "oop" }, 11)!;
    expect(spot).not.toBeNull();
    const felt = feltOf(spot.hand, spot.board);
    expect(felt.board).toEqual(spot.board);
    const streets = felt.strip.filter((item) => item.kind === "street");
    expect(streets.map((item) => item.kind === "street" && item.street)).toEqual(["flop", "turn", "river"]);
    expect(streets.map((item) => item.kind === "street" && item.cards.length)).toEqual([3, 1, 1]);
    // Out of position on the river the hero acts first: nothing is in front of anyone.
    expect(felt.seats.every((seat) => seat.betBb === 0)).toBe(true);
  });
});

describe("why", () => {
  it("names a rule of thumb for every spot, and both languages have its words", () => {
    const spot = dealPreflop(library, { set: DEFAULT_CHART_SET, family: "vs-open", seat: "SB", bias: "range" }, 3)!;
    const graded = analyzeHand(preflopAnswer(spot, 0).hand, { charts: library });
    const decision = graded.decisions.find((d) => d.chosen !== null) as DecisionAnalysis;
    expect(principleOf(spot, decision)).toBe("vs-open-sb");
    const keys = Object.keys(trainerEn.principles).sort();
    expect(Object.keys(trainerHr.principles).sort()).toEqual(keys);
    expect(keys).toContain("river-vs-bet");
    expect(keys).toContain("flop-cbet");
  });
});
