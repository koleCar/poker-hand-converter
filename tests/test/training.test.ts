/**
 * Training (phase A7, `docs/ANALYSIS-PLAN.md` §7, `frontend/src/lib/training`).
 *
 * - **The scheduler** on the same table of cases as the database's
 *   `drill_next` (`supabase/tests/database/analysis_training.test.sql`), so
 *   the screen's preview and the stored schedule cannot drift apart.
 * - **Dealing**: preflop weights are the chart range × combos × the card
 *   removal of the earlier players, `borderline` tilts them toward mixed and
 *   close classes; a river hand is dealt from the hero's range at the node and
 *   never shares a card with the board.
 * - **One grader**: a trainer answer's grade is the analysis' grade of the
 *   same hand, decision for decision, preflop and river.
 * - **Determinism**: the same seed deals the same spot.
 * - Drills grade against their stored options with the analysis' caps; the
 *   session score counts streaks and classes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeHand, grade, opponentRanges, removalFactors, type DecisionAnalysis } from "../../frontend/src/lib/analysis/index.js";
import { handClassOf, loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { fullLibrary } from "./charts/support.js";
import { comboHi, comboLo, HAND_CLASSES, rangesAt } from "../../frontend/src/lib/solver/index.js";
import { cardCode, cardIndex } from "../../frontend/src/lib/equity/evaluator.js";
import {
  BORDERLINE_FLOOR,
  INITIAL_EASE,
  PREFLOP_FAMILIES,
  QUALITY,
  RELEARN_MINUTES,
  addAnswer,
  asAnswered,
  dealPreflop,
  dealingWeights,
  emptySession,
  generateRiverSpot,
  generateTurnSpot,
  gradeAnswer,
  gradeDrill,
  handUpTo,
  interest,
  isDue,
  lastHeroDecision,
  newDrillState,
  nextDrillState,
  pickWeighted,
  preflopAnswer,
  reviewDrill,
  riverAnswer,
  riverDealingWeights,
  riverLines,
  scriptHand,
  scriptMoney,
  seeded,
  sessionAccuracy,
  sessionScore,
  trainerNodes,
  turnAnswer,
  type DrillDecision,
  type HandScript,
  type RiverTrainerSpot,
} from "../../frontend/src/lib/training/index.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

/** The analysis' own verdict on one decision of a hand, from a full run. */
function analysed(hand: Parameters<typeof analyzeHand>[0], actionIndex: number): DecisionAnalysis | undefined {
  // A trainer river is built and graded on the heuristic narrowing (A5a: `turn: false`).
  return analyzeHand(structuredClone(hand), { charts: CHARTS, turn: false }).decisions.find((d) => d.actionIndex === actionIndex);
}

/* ------------------------------------------------------------ scheduler - */

describe("drill scheduling (SM-2)", () => {
  // The same rows as the pgTAP test: reps, lapses, ease, interval, quality >
  // reps, lapses, ease, interval, relearn.
  const CASES: Array<[number, number, number, number, number, number, number, number, number, boolean]> = [
    [0, 0, 2.5, 0, 5, 1, 0, 2.6, 1, false],
    [1, 0, 2.6, 1, 5, 2, 0, 2.7, 6, false],
    [2, 0, 2.7, 6, 5, 3, 0, 2.8, 17, false],
    [3, 0, 2.8, 17, 4, 4, 0, 2.8, 48, false],
    [4, 0, 2.8, 48, 3, 5, 0, 2.66, 128, false],
    [5, 0, 2.66, 128, 1, 0, 1, 2.12, 0, true],
    [0, 1, 2.12, 0, 0, 0, 2, 1.32, 0, true],
    [0, 2, 1.32, 0, 0, 0, 3, 1.3, 0, true],
    [6, 0, 3, 200, 5, 7, 0, 3, 365, false],
    [3, 0, 1.45, 10, 4, 4, 0, 1.45, 15, false],
    [2, 0, 2.5, 6, 3, 3, 0, 2.36, 14, false],
  ];
  const now = new Date("2026-10-02T12:00:00Z");

  it.each(CASES)("(%i, %i, %f, %i) answered %i", (reps, lapses, ease, intervalDays, q, r2, l2, e2, i2, relearn) => {
    const next = nextDrillState({ reps, lapses, ease, intervalDays, dueAt: now.toISOString() }, q, now);
    expect([next.reps, next.lapses, next.ease, next.intervalDays]).toEqual([r2, l2, e2, i2]);
    const minutes = (new Date(next.dueAt).getTime() - now.getTime()) / 60_000;
    expect(minutes).toBe(relearn ? RELEARN_MINUTES : i2 * 24 * 60);
  });

  it("maps grades to qualities, passes Inaccurate and fails Mistake", () => {
    expect(QUALITY).toEqual({ perfect: 5, good: 4, inaccurate: 3, mistake: 1, blunder: 0 });
    const fresh = newDrillState(now);
    expect(fresh).toEqual({ reps: 0, lapses: 0, ease: INITIAL_EASE, intervalDays: 0, dueAt: now.toISOString() });
    expect(isDue(fresh, now)).toBe(true);
    expect(reviewDrill(fresh, "inaccurate", now).reps).toBe(1);
    expect(reviewDrill(fresh, "mistake", now).lapses).toBe(1);
    // A spot answered right three times in a row is out of the way for weeks.
    let state = fresh;
    for (const g of ["perfect", "perfect", "good"] as const) state = reviewDrill(state, g, now);
    // 1 day, 6 days, then 6 × 2.7 = 16.2 → 16.
    expect(state.intervalDays).toBe(16);
    expect(isDue(state, new Date(now.getTime() + 15 * 86_400_000))).toBe(false);
  });
});

/* ------------------------------------------------------------- dealing - */

describe("the seeded generator", () => {
  it("repeats itself for a seed and draws in proportion to the weights", () => {
    const a = seeded(42);
    const b = seeded(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    const rng = seeded(7);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i += 1) counts[pickWeighted([1, 0, 3], rng)] += 1;
    expect(counts[1]).toBe(0);
    expect(counts[2] / counts[0]).toBeGreaterThan(2.8);
    expect(counts[2] / counts[0]).toBeLessThan(3.2);
    expect(pickWeighted([0, 0], rng)).toBe(-1);
  });
});

describe("trainer hands", () => {
  const script: HandScript = {
    id: "TT1",
    hero: "BB",
    heroCards: ["Qh", "Jh"],
    stackBb: 100,
    preflop: [
      { position: "UTG", type: "fold" },
      { position: "HJ", type: "fold" },
      { position: "CO", type: "fold" },
      { position: "BTN", type: "raise", to: 2.5 },
      { position: "SB", type: "fold" },
      { position: "BB", type: "call" },
    ],
    board: ["Kd", "7c", "2s", "9h", "3d"],
    flop: [
      { position: "BB", type: "check" },
      { position: "BTN", type: "bet", to: 1.82 },
      { position: "BB", type: "call" },
    ],
    turn: [],
  };

  it("parse as a real hand, with the money the script says", () => {
    const hand = scriptHand(script);
    expect(hand.game.variant).toBe("holdem");
    expect(hand.players.find((p) => p.isHero)?.holeCards).toEqual(["Qh", "Jh"]);
    const money = scriptMoney(script);
    expect(money.streetPot).toEqual({ flop: 5.5, turn: 9.14 });
    expect(money.behind.BB).toBeCloseTo(95.68, 10);
    const decision = lastHeroDecision(hand);
    expect(decision?.type).toBe("call");
    expect(decision?.street).toBe("flop");
  });

  it("show a player only what they could see at the decision", () => {
    const hand = scriptHand({ ...script, turn: [{ position: "BB", type: "check" }] });
    const stop = lastHeroDecision(hand)?.index ?? -1;
    const spot = handUpTo(hand, stop);
    expect(spot.actions.every((a) => a.index < stop)).toBe(true);
    expect(spot.board.runouts[0].turn).toBe("9h");
    expect(spot.board.runouts[0].river).toBeNull();
    expect(spot.players.filter((p) => !p.isHero).every((p) => p.holeCards.length === 0)).toBe(true);
    expect(spot.results.winners).toEqual([]);
    expect(handUpTo(hand, stop, true).players.every((p) => p.holeCards.length === 0)).toBe(true);
  });
});

describe("preflop dealing", () => {
  it("has spots in every family", () => {
    for (const family of PREFLOP_FAMILIES) {
      expect(trainerNodes(CHARTS, family).length, family).toBeGreaterThan(0);
    }
    expect(trainerNodes(CHARTS, "rfi", "BTN").map((n) => n.line)).toEqual(["fff"]);
  });

  it("weights a class by the chart range, its combos and the earlier players' card removal", () => {
    const utg = CHARTS.nodes.get("");
    const btn = CHARTS.nodes.get("fff");
    const bbVsBtn = CHARTS.nodes.get("fffrf");
    if (!utg || !btn || !bbVsBtn) throw new Error("chart nodes missing");
    const aa = handClassOf("AA");
    const s72 = handClassOf("72o");
    // First to act: nothing to remove.
    const first = dealingWeights(CHARTS, utg);
    for (let k = 0; k < 169; k += 1) expect(first[k]).toBeCloseTo(HAND_CLASSES[k].combos * utg.range[k], 12);
    // Behind three folds: the folders kept their aces less often than their
    // junk, so aces are likelier on the button than their chart weight, and
    // 72o less likely.
    const factor = (node: typeof btn, k: number) =>
      dealingWeights(CHARTS, node)[k] / (HAND_CLASSES[k].combos * node.range[k]);
    expect(factor(btn, aa)).toBeGreaterThan(1);
    expect(factor(btn, aa)).toBeGreaterThan(factor(btn, s72));
    // Facing an open: exactly A3's removal factors of the players before.
    const removal = removalFactors(opponentRanges(CHARTS, bbVsBtn.line));
    for (const k of [aa, s72, handClassOf("T9s")]) expect(factor(bbVsBtn, k)).toBeCloseTo(removal[k], 12);
    expect(removal[aa]).not.toBeCloseTo(1, 3);
  });

  it("tilts toward mixed and close hands when asked", () => {
    const node = CHARTS.nodes.get("fffrf");
    if (!node) throw new Error("chart node missing");
    const plain = dealingWeights(CHARTS, node, "range");
    const tilted = dealingWeights(CHARTS, node, "borderline");
    for (let k = 0; k < 169; k += 1) {
      expect(tilted[k]).toBeCloseTo(plain[k] * (BORDERLINE_FLOOR + interest(node, k)), 12);
    }
    const share = (w: Float64Array) => {
      let mixed = 0;
      let all = 0;
      for (let k = 0; k < 169; k += 1) {
        all += w[k];
        if (interest(node, k) > 0.5) mixed += w[k];
      }
      return mixed / all;
    };
    expect(share(tilted)).toBeGreaterThan(share(plain));
  });

  it("deals the same spot for the same seed", () => {
    for (const seed of [1, 99, 123456]) {
      const a = dealPreflop(CHARTS, { family: "random", bias: "borderline" }, seed);
      const b = dealPreflop(CHARTS, { family: "random", bias: "borderline" }, seed);
      expect(a && { ...a, hand: null }).toEqual(b && { ...b, hand: null });
      expect(a?.hand.actions).toEqual(b?.hand.actions);
    }
    const spot = dealPreflop(CHARTS, { family: "vs-3bet", seat: "CO" }, 5);
    expect(spot?.hero).toBe("CO");
    expect(spot?.family).toBe("vs-3bet");
  });

  it("grades an answer exactly as the analysis grades the same hand", () => {
    let graded = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const spot = dealPreflop(CHARTS, { family: "random", bias: "borderline" }, seed);
      if (!spot) throw new Error(`no spot for seed ${seed}`);
      spot.menu.forEach((_, index) => {
        const { hand, actionIndex } = preflopAnswer(spot, index);
        const mine = gradeAnswer(hand, actionIndex, CHARTS);
        expect(mine).toEqual(analysed(hand, actionIndex));
        expect(mine?.source).toBe("chart");
        expect(mine?.facts.chart?.line).toBe(spot.line);
        expect(mine?.facts.handClass).toBe(spot.handClass);
        graded += 1;
      });
    }
    expect(graded).toBeGreaterThan(24);
  });
});

describe("preflop dealing from other tables and depths (A2c)", () => {
  const library = fullLibrary();

  it("deals a 9-max spot as a nine-handed hand and grades it from the same set", () => {
    let graded = 0;
    for (const set of ["nlhe-cash-9max-100bb", "nlhe-cash-9max-200bb", "nlhe-cash-6max-40bb"]) {
      for (let seed = 1; seed <= 6; seed += 1) {
        const spot = dealPreflop(library, { set, family: "random", bias: "borderline" }, seed);
        if (!spot) throw new Error(`no spot for ${set} seed ${seed}`);
        expect(spot.set).toBe(set);
        const seats = library.sets.get(set)?.game.positions ?? [];
        expect(spot.hand.players).toHaveLength(seats.length);
        expect(spot.script.stackBb).toBe(library.sets.get(set)?.game.stackBb);
        spot.menu.forEach((_, index) => {
          const { hand, actionIndex } = preflopAnswer(spot, index);
          const mine = gradeAnswer(hand, actionIndex, library);
          expect(mine?.source, `${set} ${seed}`).toBe("chart");
          expect(mine?.facts.chart?.set).toBe(set);
          expect(mine?.facts.chart?.line).toBe(spot.line);
          expect(mine?.approximations).not.toContain("short-handed");
          graded += 1;
        });
      }
    }
    expect(graded).toBeGreaterThan(30);
    // A 9-max seat and raiser are dealt as asked.
    const lj = dealPreflop(library, { set: "nlhe-cash-9max-100bb", family: "vs-open", seat: "BB", vs: "UTG+1" }, 3);
    expect(lj?.hero).toBe("BB");
    expect(lj?.line).toMatch(/^fr/);
    expect(() => dealPreflop(CHARTS, { set: "nlhe-cash-9max-100bb", family: "rfi" }, 1)).toThrow(/not available/);
  });
});

/* ---------------------------------------------------------------- river - */

describe("river spots", () => {
  const spots: RiverTrainerSpot[] = [];
  for (let seed = 1; spots.length < 4 && seed < 40; seed += 1) {
    const spot = generateRiverSpot(CHARTS, { bias: "range" }, seed);
    if (spot) spots.push(spot);
  }

  it("come from the chart lines the set can play", () => {
    expect(riverLines(CHARTS).length).toBeGreaterThanOrEqual(10);
    expect(spots.length).toBe(4);
    expect(new Set(spots.map((s) => s.seat)).size).toBeGreaterThan(0);
  });

  it("deal the hero a combo from their range at the node, never one of the board's cards", () => {
    for (const spot of spots) {
      expect(spot.cards.some((c) => spot.board.includes(c))).toBe(false);
      expect(new Set([...spot.cards, ...spot.board]).size).toBe(7);
      expect(spot.menu.length).toBeGreaterThan(1);
      if (spot.facing) expect(spot.toCallBb).toBeGreaterThan(0);
    }
  });

  it("weights a combo by its reach at the node (borderline: times how mixed it plays)", () => {
    const spot = spots[0];
    const { hand, actionIndex } = riverAnswer(spot, 0);
    expect(hand.actions.find((a) => a.index === actionIndex)?.street).toBe("river");
    // The weights are the solve's reach for the hero; the board's cards are not in the solve's hands at all.
    const regenerated = generateRiverSpot(CHARTS, { bias: "range" }, spot.seed);
    expect(regenerated?.cards).toEqual(spot.cards);
  });

  it("grade an answer exactly as the analysis grades the same hand", () => {
    for (const spot of spots.slice(0, 3)) {
      for (let index = 0; index < spot.menu.length; index += 1) {
        const { hand, actionIndex } = riverAnswer(spot, index);
        const mine = gradeAnswer(hand, actionIndex, CHARTS);
        expect(mine).toEqual(analysed(hand, actionIndex));
        expect(mine?.status).toBe("analysed");
        expect(mine?.source).toBe("solver");
        expect(mine?.approximations).toContain("narrowing-heuristic");
        // The hero's own menu maps onto the solve's own edges: never off the tree.
        expect(mine?.approximations).not.toContain("off-tree-size");
      }
    }
  });

  it("are the same spot for the same seed", () => {
    for (const spot of spots.slice(0, 2)) {
      const again = generateRiverSpot(CHARTS, { bias: "range" }, spot.seed);
      expect(again && { ...again, hand: null }).toEqual({ ...spot, hand: null });
    }
  });

  it("can be asked for a pot type and a seat", () => {
    const spot = generateRiverSpot(CHARTS, { pot: "3bp", seat: "oop", bias: "borderline" }, 11);
    expect(spot?.pot).toBe("3bp");
    expect(spot?.seat).toBe("oop");
    expect(spot?.facing).toBeNull();
  });
});

describe("river dealing weights", () => {
  it("are the solve's reach at the node, and exclude the board", async () => {
    const { solveRiverSpot, walkRanges } = await import("../../frontend/src/lib/analysis/index.js");
    const { buildContext } = await import("../../frontend/src/lib/stats/context.js");
    const spot = generateRiverSpot(CHARTS, { seat: "oop" }, 3);
    if (!spot) throw new Error("no spot");
    const hand = scriptHand({ ...spot.script, river: [{ position: spot.hero, type: "check" }] });
    const heroSeat = hand.players.find((p) => p.isHero)?.seat ?? -1;
    const villainSeat = hand.players.find((p) => p.name === spot.villain)?.seat ?? -1;
    const walk = walkRanges(hand, buildContext(hand), heroSeat, villainSeat, CHARTS);
    if (!walk.ok || !walk.riverStart) throw new Error("no walk");
    const board = spot.board.map(cardIndex);
    const solve = solveRiverSpot({
      hand,
      heroSeat,
      villainSeat,
      heroFirst: true,
      heroCards: [cardIndex(spot.cards[0]), cardIndex(spot.cards[1])],
      board,
      potBb: spot.potBb,
      stackBb: spot.stackBb,
      ranges: walk.riverStart,
      charts: CHARTS,
      model: walk.model,
      key: { players: 6, stackBucket: "100bb", preflopLine: spot.pot, positions: [spot.hero, spot.villain] },
    });
    if (!solve.ok) throw new Error("no solve");
    const weights = riverDealingWeights(solve, 0, "range");
    const reach = rangesAt(solve.result, 0)[solve.hero];
    const hands = solve.result.hands[solve.hero];
    for (let i = 0; i < hands.length; i += 1) {
      expect(weights[i]).toBe(reach[i] > 0 ? reach[i] : 0);
      const cards = [cardCode(comboHi(hands[i])), cardCode(comboLo(hands[i]))];
      expect(cards.some((c) => spot.board.includes(c))).toBe(false);
    }
  });
});

/* ---------------------------------------------- facing filter, turn spots - */

describe("spots facing a check or a bet (Learn L1)", () => {
  it("deal an in-position river hero the villain's check, or a bet, as asked", () => {
    const checked = generateRiverSpot(CHARTS, { pot: "3bp", role: "pfr", facing: "check" }, 5);
    expect(checked?.seat).toBe("ip");
    expect(checked?.facing).toBeNull();
    expect(checked?.script.river?.[0]).toMatchObject({ position: checked?.villain, type: "check" });
    const bet = generateRiverSpot(CHARTS, { pot: "srp", facing: "bet" }, 9);
    expect(bet?.seat).toBe("ip");
    expect(bet?.facing).not.toBeNull();
  });

  it("leave the unfiltered river deal exactly as it was", () => {
    // `facing` absent draws the villain's action from the same weights as before.
    const a = generateRiverSpot(CHARTS, { bias: "range" }, 77);
    const b = generateRiverSpot(CHARTS, { bias: "range", facing: "any" }, 77);
    expect(b && { ...b, hand: null }).toEqual(a && { ...a, hand: null });
  });
});

describe("turn spots (Learn L1)", () => {
  it("deal an in-position 3-bet-pot hero a check, a combo from their range, and the turn tree's menu", () => {
    for (const role of ["pfr", "caller"] as const) {
      const spot = generateTurnSpot(CHARTS, { pot: "3bp", seat: "ip", role, facing: "check" }, 11);
      if (!spot) throw new Error(`no ${role} turn spot`);
      expect(spot.kind).toBe("turn");
      expect(spot.board).toHaveLength(4);
      expect(spot.seat).toBe("ip");
      expect(spot.facing).toBeNull();
      expect(spot.cards.some((card) => spot.board.includes(card))).toBe(false);
      expect(spot.menu.map((item) => item.kind)).toContain("check");
      expect(spot.menu.some((item) => item.kind === "bet" || item.kind === "allin")).toBe(true);
      expect(spot.hand.players.find((p) => p.isHero)?.holeCards).toEqual(spot.cards);
    }
  });

  it("grade an answer exactly as the analysis grades the same hand, turn solve on", () => {
    const spot = generateTurnSpot(CHARTS, { pot: "3bp", seat: "ip", role: "caller", facing: "check" }, 22);
    if (!spot) throw new Error("no turn spot");
    const answer = turnAnswer(spot, 0);
    const graded = gradeAnswer(answer.hand, answer.actionIndex, CHARTS, { turn: true });
    const full = analyzeHand(structuredClone(answer.hand), { charts: CHARTS }).decisions.find((d) => d.actionIndex === answer.actionIndex);
    expect(graded?.source).toBe("solver");
    expect(graded?.street).toBe("turn");
    expect(graded?.grade).toBe(full?.grade);
    expect(graded?.evLoss).toBe(full?.evLoss);
    expect(graded?.options).toEqual(full?.options);
  });
});

/* --------------------------------------------------------------- drills - */

describe("drill answers", () => {
  const preflop: DrillDecision = {
    options: [
      { action: "fold", sizeBb: 1, freq: 0, ev: -1 },
      { action: "call", sizeBb: 2.5, freq: 0.7, ev: -0.2 },
      { action: "raise", sizeBb: 10, freq: 0.3, ev: -0.21 },
    ],
    chosen: 0,
    grade: "mistake",
    evLoss: 0.8,
    evLossPot: 0.1455,
    freqDiff: 0.7,
    score: 0,
    potBb: 5.5,
    source: "chart",
    approximations: [],
  };

  it("keep the stored grade for the move actually made", () => {
    expect(gradeDrill(preflop, 0)).toEqual({ grade: "mistake", evLoss: 0.8, evLossPot: 0.1455, freqDiff: 0.7, score: 0 });
  });

  it("grade any other answer with grade() against the stored options", () => {
    expect(gradeDrill(preflop, 1)).toEqual(grade({ options: preflop.options, chosen: 1, pot: 5.5 }));
    expect(gradeDrill(preflop, 1).grade).toBe("perfect");
    expect(gradeDrill(preflop, 2).grade).toBe("good");
  });

  it("carry the analysis' caps: off-tree sizes at Inaccurate, solver grades at Mistake", () => {
    const river: DrillDecision = {
      ...preflop,
      options: [
        { action: "check", freq: 1, ev: 10 },
        { action: "bet", freq: 0, ev: 0, sizePot: 0.75 },
      ],
      chosen: 0,
      grade: "perfect",
      potBb: 20,
      source: "solver",
    };
    expect(grade({ options: river.options, chosen: 1, pot: 20 }).grade).toBe("blunder");
    expect(gradeDrill(river, 1).grade).toBe("mistake");
    expect(gradeDrill({ ...river, source: "chart", approximations: ["off-tree-size"] }, 1).grade).toBe("inaccurate");
  });

  it("are shown as if the answer had been played", () => {
    const spot = dealPreflop(CHARTS, { family: "vs-open", seat: "BB" }, 3);
    if (!spot) throw new Error("no spot");
    const { hand, actionIndex } = preflopAnswer(spot, 0);
    const decision = gradeAnswer(hand, actionIndex, CHARTS);
    if (!decision || decision.chosen === null) throw new Error("not graded");
    const other = decision.chosen === 0 ? 1 : 0;
    const result = gradeDrill({ ...decision, chosen: decision.chosen, grade: decision.grade ?? "perfect", evLoss: decision.evLoss ?? 0, evLossPot: decision.evLossPot ?? 0, freqDiff: decision.freqDiff ?? 0, score: decision.score ?? 0, potBb: decision.facts.potBb }, other);
    const shown = asAnswered(decision, other, result);
    expect(shown.chosen).toBe(other);
    expect(shown.action).toBe(decision.options[other].action);
    expect(shown.grade).toBe(result.grade);
    expect(shown.flags).toEqual([]);
    expect(asAnswered(decision, decision.chosen, gradeDrill({ ...decision, chosen: decision.chosen, grade: decision.grade ?? "perfect", evLoss: decision.evLoss ?? 0, evLossPot: decision.evLossPot ?? 0, freqDiff: decision.freqDiff ?? 0, score: decision.score ?? 0, potBb: decision.facts.potBb }, decision.chosen))).toEqual(decision);
  });
});

/* -------------------------------------------------------------- session - */

describe("the session score", () => {
  it("counts classes, streaks of moves the reference plays, EV lost and the mean score", () => {
    let stats = emptySession();
    expect(sessionScore(stats)).toBeNull();
    const answers = [
      { grade: "perfect", evLoss: 0, evLossPot: 0, score: 100 },
      { grade: "good", evLoss: 0.1, evLossPot: 0.01, score: 90 },
      { grade: "mistake", evLoss: 1.5, evLossPot: 0.06, score: 40 },
      { grade: "perfect", evLoss: 0, evLossPot: 0, score: 100 },
    ] as const;
    for (const a of answers) stats = addAnswer(stats, a);
    expect(stats.answers).toBe(4);
    expect(stats.counts).toEqual({ perfect: 2, good: 1, inaccurate: 0, mistake: 1, blunder: 0 });
    expect(stats.streak).toBe(1);
    expect(stats.bestStreak).toBe(2);
    expect(stats.evLoss).toBeCloseTo(1.6, 12);
    expect(sessionScore(stats)).toBeCloseTo(82.5, 12);
    expect(sessionAccuracy(stats)).toBeCloseTo(0.75, 12);
  });
});
