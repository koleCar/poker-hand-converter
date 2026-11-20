/**
 * The Trainer's one panel (canvas `ideas-trainer` A): the range view's
 * combos and EV, the short why (`lib/training/brief.ts`) and its words in
 * both languages.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import type { DecisionAnalysis, OptionAnalysis } from "../../web/src/lib/analysis/types.js";
import { briefGain, briefHead, briefPoints, cellOf, playOf, rangeExamples, type BriefPoint } from "../../web/src/lib/training/brief.js";
import { dealPreflop } from "../../web/src/lib/training/preflop.js";
import { spotRange } from "../../web/src/lib/training/rangeView.js";
import { generateRiverSpot } from "../../web/src/lib/training/river.js";
import { trainerEn } from "../../web/src/lib/i18n/ns/trainer.en.js";
import { trainerHr } from "../../web/src/lib/i18n/ns/trainer.hr.js";
import { fullLibrary } from "./charts/support.js";

const library = fullLibrary();

function option(action: OptionAnalysis["action"], freq: number, ev: number, sizePot: number | null = null): OptionAnalysis {
  return { action, freq, ev, sizeBb: sizePot === null ? undefined : 9 * sizePot, sizePot: sizePot ?? undefined, allIn: false } as OptionAnalysis;
}

/** A river decision checked to the hero with two pair, as in the canvas. */
function riverDecision(chosen: number): DecisionAnalysis {
  return {
    street: "river",
    source: "solver",
    grade: "good",
    chosen,
    options: [option("check", 0.39, 6.31), option("bet", 0.54, 6.42, 0.33), option("bet", 0.07, 6.18, 0.75)],
    facts: {
      street: "river",
      toCallBb: 0,
      potOdds: null,
      spr: 4.6,
      draws: [],
      blockers: ["set"],
      equity: null,
      preflopScenario: null,
      position: "BTN",
      river: {
        heroBeats: 0.93,
        role: "value",
        villain: { strong: 0.07, medium: 0.4, weak: 0.53, shape: "mixed" },
        blocks: { strong: 0.11, weak: 0.04 },
      },
    },
  } as unknown as DecisionAnalysis;
}

describe("the short why", () => {
  it("names a value hand that still checks a lot thin value, and the small bet its play", () => {
    expect(briefHead(riverDecision(0))).toEqual({ role: "thin", play: "bet-small" });
    expect(playOf({ action: "bet", allIn: false, sizePot: 0.75 })).toBe("bet-big");
  });

  it("says what the best play earns over yours, or over the next best when you found it", () => {
    const over = briefGain(riverDecision(0));
    expect(over).toMatchObject({ kind: "over-yours", best: 1, other: 0 });
    expect(over && "bb" in over ? over.bb : 0).toBeCloseTo(0.11, 5);
    expect(briefGain(riverDecision(1))).toMatchObject({ kind: "found", best: 1, other: 0 });
  });

  it("keeps at most three points, the deciding number first", () => {
    const points = briefPoints(riverDecision(0));
    expect(points.length).toBeLessThanOrEqual(3);
    expect(points[0]).toEqual({ kind: "beats", beats: 0.93 });
    expect(points.some((p) => p.kind === "removes")).toBe(true);
  });

  it("has words for every point and role in both languages", () => {
    const points: BriefPoint[] = [
      { kind: "beats", beats: 0.5 },
      { kind: "price", need: 0.3, have: 0.58 },
      { kind: "price", need: 0.3, have: null },
      { kind: "equity", equity: 0.4 },
      { kind: "polar", strong: 0.4, weak: 0.5 },
      { kind: "merged", medium: 0.6 },
      { kind: "removes", strong: 0.1, weak: 0.02 },
      { kind: "blockers", blockers: ["set"] },
      { kind: "rivers-weak", share: 0.2 },
      { kind: "rivers-strong", share: 0.2 },
      { kind: "draws", draws: ["gutshot"] },
      { kind: "spr", spr: 2.5 },
      { kind: "capped" },
      { kind: "estimate" },
    ];
    for (const words of [trainerEn, trainerHr]) {
      for (const p of points) {
        const w = words.brief.point(p);
        expect(w.lead.length).toBeGreaterThan(0);
        expect(w.text.length).toBeGreaterThan(0);
      }
      expect(Object.keys(words.brief.roles).sort()).toEqual(Object.keys(trainerEn.brief.roles).sort());
      expect(Object.keys(words.brief.plays).sort()).toEqual(Object.keys(trainerEn.brief.plays).sort());
      expect(Object.keys(words.brief.groups).sort()).toEqual(Object.keys(trainerEn.brief.groups).sort());
      expect(words.brief.gain("over-yours", "Bet 3 bb (33%)", "Check", 0.11).value).toMatch(/^\+0[.,]11 bb$/);
    }
    expect(trainerEn.brief.head("Thin value", "bet small")).toBe("Thin value — bet small");
  });
});

describe("the range view and its example hands", () => {
  it("carries every combo of a river solve, with the mix, EV and strength, and the hero's own", () => {
    const spot = generateRiverSpot(library, { pot: "srp", seat: "ip" }, 21)!;
    const view = spotRange(spot, library, null)!;
    expect(view.street).toBe("river");
    expect(view.combos!.length).toBeGreaterThan(0);
    const combo = view.combos![0];
    expect(combo.cards).toMatch(/^[2-9TJQKA][shdc][2-9TJQKA][shdc]$/);
    expect(combo.freq).toHaveLength(view.options.length);
    expect(combo.ev).toHaveLength(view.options.length);
    expect(combo.hs).toBeGreaterThanOrEqual(0);
    expect(combo.hs).toBeLessThanOrEqual(1);
    expect(view.combos!.some((c) => c.cards === view.heroCombo)).toBe(true);
    expect(view.cells.find((c) => c.combos > 0)!.ev).toHaveLength(view.options.length);

    for (const group of rangeExamples(view)) {
      expect(group.hands.length).toBeGreaterThan(0);
      expect(group.hands.length).toBeLessThanOrEqual(2);
      for (const hand of group.hands) {
        expect(view.cells[hand.cell].combos).toBeGreaterThan(0);
        expect(view.options[hand.option]).toBeDefined();
      }
    }
  });

  it("groups a preflop chart by the play, the hero's class first, each with the chart's EV", () => {
    const spot = dealPreflop(library, { set: DEFAULT_CHART_SET, family: "vs-open", seat: "BB", vs: "BTN", bias: "range" }, 5)!;
    const view = spotRange(spot, library, null)!;
    expect(view.combos).toBeNull();
    expect(view.street).toBe("preflop");
    const groups = rangeExamples(view);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length).toBeLessThanOrEqual(3);
    const mine = groups.flatMap((g) => g.hands).filter((h) => h.me);
    expect(mine.length).toBeLessThanOrEqual(1);
    if (mine.length === 1) expect(mine[0].cell).toBe(cellOf(spot.handClass));
    for (const hand of groups.flatMap((g) => g.hands)) expect(hand.ev === null || Number.isFinite(hand.ev)).toBe(true);
  });

  it("finds a class's grid cell", () => {
    expect(cellOf("AA")).toBe(0);
    expect(cellOf("AKs")).toBe(1);
    expect(cellOf("AKo")).toBe(13);
    expect(cellOf("22")).toBe(168);
  });
});
