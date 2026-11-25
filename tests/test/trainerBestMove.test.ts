/**
 * The trainer's Perfect is the best move, and every answer button's
 * frequency, EV and grade once graded (#417, `docs/TRAINER.md` §2).
 */

import { describe, expect, it } from "vitest";

import type { DecisionAnalysis, OptionAnalysis } from "../../web/src/lib/analysis/types.js";
import { bestMoveGrade, NO_LOSS_BB, optionGrades } from "../../web/src/lib/training/grade.js";
import { buttonInfo } from "../../web/src/components/trainer/Decision.js";

/** #417's spot: a flop facing a bet, 7bb pot, fold mixed nearly as often as the rest but 0.02bb worse. */
const OPTIONS: OptionAnalysis[] = [
  { action: "fold", freq: 0.5, ev: 0 },
  { action: "call", freq: 0.2, ev: 0.02 },
  { action: "raise", sizeBb: 8.1, freq: 0.3, ev: 0.02 },
];

function decision(chosen: number, grade: DecisionAnalysis["grade"], evLoss: number): DecisionAnalysis {
  return {
    street: "flop",
    options: OPTIONS,
    chosen,
    grade,
    evLoss,
    evLossPot: evLoss / 7,
    freqDiff: 0,
    score: 98,
    source: "solver",
    approximations: [],
    facts: { potBb: 7 },
  } as unknown as DecisionAnalysis;
}

describe("the trainer's Perfect (#417)", () => {
  it("is Good for a Perfect that loses EV the verdict shows", () => {
    expect(bestMoveGrade(decision(0, "perfect", 0.02)).grade).toBe("good");
  });

  it("stays Perfect at no EV lost, and leaves every other grade alone", () => {
    expect(bestMoveGrade(decision(1, "perfect", 0)).grade).toBe("perfect");
    expect(bestMoveGrade(decision(1, "perfect", NO_LOSS_BB)).grade).toBe("perfect");
    expect(bestMoveGrade(decision(0, "inaccurate", 0.5)).grade).toBe("inaccurate");
  });
});

describe("the buttons once graded (#417)", () => {
  it("grades every option as the answer: the best moves Perfect, the mixed-in fold Good", () => {
    expect(optionGrades(decision(0, "good", 0.02))).toEqual(["good", "perfect", "perfect"]);
  });

  it("keeps the answer's own grade on its button", () => {
    expect(optionGrades(decision(1, "inaccurate", 0))[1]).toBe("inaccurate");
  });

  it("puts a group of sizes behind one button: frequencies together, the best EV and grade", () => {
    const info = buttonInfo(decision(0, "good", 0.02), [[0], [1, 2]], (index) => index);
    expect(info).toEqual([
      { freq: 0.5, ev: 0, grade: "good" },
      { freq: 0.5, ev: 0.02, grade: "perfect" },
    ]);
  });

  it("shows nothing before the grade, and nothing on a button with no option", () => {
    expect(buttonInfo(null, [[0]], (index) => index)).toBeNull();
    expect(buttonInfo(decision(0, "good", 0.02), [[0], [5]], (index) => (index < 3 ? index : -1))).toEqual([
      { freq: 0.5, ev: 0, grade: "good" },
      null,
    ]);
  });
});
