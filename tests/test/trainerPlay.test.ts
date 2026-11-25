/**
 * A whole hand in the Trainer (T2, `web/src/lib/training/play.ts`): the
 * betting order, the opponent played by the reference, every hero decision
 * offered the analysis' own options and graded by it, and the hand settled.
 * Without the flop library here (Node, no bucket), a hand that reaches a flop
 * stops there with "no reference" - the browser reads the library.
 */

import { describe, expect, it } from "vitest";

import { advance, answerPlay, gradePlay, startHand, toAct, type PlayLibrary, type PlayState, type PlayStep } from "../../web/src/lib/training/play.js";
import { FLOP_REPRESENTATIVES, flopKey } from "../../web/src/lib/solver/index.js";
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

describe("the flop of a hand from preflop (#414)", () => {
  // A library holding one flop of the button's open called by the big blind: its chunk never loads here, but the flop
  // dealt must be that one - a flop the library does not hold leaves both players without a reference, and the hand
  // would stop at the hero's first flop decision with no buttons.
  const SET = "nlhe-cash-6max-100bb";
  const REP = FLOP_REPRESENTATIVES[17];
  const has = (set: string, line: string, flop: string) => set === SET && line === "btn-bb" && flop === REP;
  const library = {
    library: { tree: "flop-m1", has, get: () => null },
    ready: async () => true,
    load: async () => undefined,
  } as unknown as PlayLibrary;

  it("is one the library holds for the line, in suits that miss both hands", async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const state: PlayState = {
        seed,
        steps: 0,
        set: SET,
        hero: "BTN",
        villain: "BB",
        heroCards: ["Ah", "Kd"],
        villainCards: ["7c", "7s"],
        runout: ["2c", "2d", "2h", "3c", "3d"],
        script: {
          id: `T${seed}`,
          hero: "BTN",
          heroCards: ["Ah", "Kd"],
          stackBb: 100,
          preflop: [
            ...["UTG", "HJ", "CO"].map((position) => ({ position, type: "fold" as const })),
            { position: "BTN", type: "raise", to: 2.5 },
            { position: "SB", type: "fold" },
            { position: "BB", type: "call" },
          ],
        },
        approximate: false,
      };
      const step = await advance(state, charts, library);
      const board = (step.decision ?? step.over)!.board;
      expect(flopKey(board), `seed ${seed}`).toBe(REP);
      const cards = [...state.heroCards, ...state.villainCards, ...step.state.runout];
      expect(new Set(cards).size, `seed ${seed}`).toBe(9);
      expect(step.state.runout.slice(0, 3)).toEqual(board);
    }
  });

  it("is the runout's own on a line the library holds no flop of", async () => {
    const empty = { ...library, library: { ...library.library, has: () => false } } as unknown as PlayLibrary;
    const runout = ["2c", "2d", "2h", "3c", "3d"];
    const state: PlayState = {
      seed: 5,
      steps: 0,
      set: SET,
      hero: "BTN",
      villain: "BB",
      heroCards: ["Ah", "Kd"],
      villainCards: ["7c", "7s"],
      runout,
      script: {
        id: "T5",
        hero: "BTN",
        heroCards: ["Ah", "Kd"],
        stackBb: 100,
        preflop: [
          ...["UTG", "HJ", "CO"].map((position) => ({ position, type: "fold" as const })),
          { position: "BTN", type: "raise", to: 2.5 },
          { position: "SB", type: "fold" },
          { position: "BB", type: "call" },
        ],
      },
      approximate: false,
    };
    const step = await advance(state, charts, empty);
    expect(step.state.runout).toEqual(runout);
  });
});
