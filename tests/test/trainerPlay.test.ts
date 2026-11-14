/**
 * A whole hand in the Trainer (T2, `web/src/lib/training/play.ts`): the
 * betting order, the opponent played by the reference, every hero decision
 * offered the analysis' own options and graded by it, and the hand settled.
 * Without the flop library here (Node, no bucket), a hand that reaches a flop
 * stops there with "no reference" - the browser reads the library.
 */

import { describe, expect, it } from "vitest";

import { answerPlay, gradePlay, startHand, toAct, type PlayStep } from "../../web/src/lib/training/play.js";
import type { HandScript } from "../../web/src/lib/training/handText.js";
import { fullLibrary } from "./charts/support.js";

const charts = fullLibrary();

describe("the betting", () => {
  const base: HandScript = { id: "T1", hero: "BB", heroCards: ["Ah", "Kd"], stackBb: 100, preflop: [] };

  it("preflop from under the gun, round to the big blind's option, closed when everyone has matched", () => {
    expect(toAct(base)).toBe("UTG");
    const folds: HandScript = { ...base, preflop: ["UTG", "HJ", "CO"].map((position) => ({ position, type: "fold" as const })) };
    expect(toAct(folds)).toBe("BTN");
    const open: HandScript = { ...folds, preflop: [...folds.preflop, { position: "BTN", type: "raise", to: 2.5 }, { position: "SB", type: "fold" }] };
    expect(toAct(open)).toBe("BB");
    expect(toAct({ ...open, preflop: [...open.preflop, { position: "BB", type: "call" }] })).toBeNull();
    // A 3-bet reopens it for the opener.
    expect(toAct({ ...open, preflop: [...open.preflop, { position: "BB", type: "raise", to: 11 }] })).toBe("BTN");
  });

  it("after the flop the big blind first, heads-up", () => {
    const flop: HandScript = {
      ...base,
      preflop: [
        ...["UTG", "HJ", "CO"].map((position) => ({ position, type: "fold" as const })),
        { position: "BTN", type: "raise", to: 2.5 },
        { position: "SB", type: "fold" },
        { position: "BB", type: "call" },
      ],
      board: ["2c", "7d", "Kh"],
      flop: [],
    };
    expect(toAct(flop)).toBe("BB");
    expect(toAct({ ...flop, flop: [{ position: "BB", type: "check" }] })).toBe("BTN");
    expect(toAct({ ...flop, flop: [{ position: "BB", type: "check" }, { position: "BTN", type: "check" }] })).toBeNull();
    expect(toAct({ ...flop, flop: [{ position: "BB", type: "bet", to: 2 }, { position: "BTN", type: "raise", to: 6 }] })).toBe("BB");
  });
});

describe("a whole hand from preflop", () => {
  it("deals the hero a chart spot against one opponent, offers the analysis' options, grades every answer and settles the pot", async () => {
    let played = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      let step: PlayStep | null = await startHand({ start: "preflop", preflop: { family: "random", bias: "range" }, flop: {} }, charts, null, seed);
      if (!step) continue;
      played += 1;
      const { state } = step;
      // Two different hands, no card twice, the runout apart from both.
      const cards = [...state.heroCards, ...state.villainCards, ...state.runout];
      expect(new Set(cards).size, `seed ${seed}`).toBe(9);
      expect(state.villain).not.toBe(state.hero);
      let moves = 0;
      while (step.decision) {
        expect(step.decision.menu.length).toBeGreaterThan(0);
        const pick = (seed + moves) % step.decision.menu.length;
        const graded = await gradePlay(step, pick, charts, null);
        expect(graded.decision?.status, `seed ${seed}`).toBe("analysed");
        expect(graded.decision?.chosen).not.toBeNull();
        const next: PlayStep | null = await answerPlay(step, pick, charts, null);
        expect(next).not.toBeNull();
        step = next!;
        moves += 1;
        expect(moves).toBeLessThan(12);
      }
      const over = step.over!;
      expect(over).not.toBeNull();
      // Never more than a stack lost; won, at most the opponent's stack and the blinds that folded (the GTO Wizard set's
      // small blind jams over a button open: it wins the button's 100bb and the big blind's 1bb).
      expect(-over.heroNetBb).toBeLessThanOrEqual(state.script.stackBb + 1e-9);
      expect(over.heroNetBb).toBeLessThanOrEqual(state.script.stackBb + 1.5 + 1e-9);
      // The winner of a fold gains, the folder loses what it put in (nothing, folding first in).
      if (over.reason === "fold" && over.winner === "hero") expect(over.heroNetBb).toBeGreaterThanOrEqual(0);
      if (over.reason === "fold" && over.winner === "villain") expect(over.heroNetBb).toBeLessThanOrEqual(0);
      if (over.reason === "showdown") {
        expect(over.villainCards).toEqual(state.villainCards);
        expect(over.board).toHaveLength(5);
      }
    }
    expect(played).toBeGreaterThan(20);
  }, 120_000);
});
