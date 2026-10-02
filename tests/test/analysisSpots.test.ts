/**
 * Hand analysis, pinned: one hand per fact or check, small enough to read.
 *
 * `analysisCorpus.test.ts` asserts properties over every real hand; this file
 * asserts *numbers* — the pot, the price, the hand class, each flag — on hands
 * written out in standard text, the way `statsSpots.test.ts` pins the stats
 * engine. Every amount in an expectation is worked out in the comment above it.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeHand,
  blockers,
  boardTexture,
  draws,
  grade,
  madeHand,
  toIndices,
  worstGrade,
  type DecisionAnalysis,
  type HandAnalysis,
} from "../../frontend/src/lib/analysis/index.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text.trim(), CTX);
  if (!hand) throw new Error("fixture did not parse");
  return hand;
}

function decision(analysis: HandAnalysis, street: string, action: string): DecisionAnalysis {
  const found = analysis.decisions.find((d) => d.street === street && d.action === action);
  if (!found) throw new Error(`no ${street} ${action}`);
  return found;
}

const cards = (codes: string) => toIndices(codes.split(" "));

/* -------------------------------------------------------------- hands - */

/**
 * BB defends KQ against a button open and calls two streets.
 *
 *   preflop  0.5 + 2.5 + 2.5            = 5.5
 *   flop     Btn bets 2: pot 7.5, to call 2 -> needs 2/9.5 = 21.1%
 *            then 9.5
 *   river    Btn bets 6: pot 15.5, to call 6 -> needs 6/21.5 = 27.9%,
 *            MDF 1 - 6/15.5 = 61.3%, the bet is 6/9.5 = 63.2% of the pot,
 *            SPR as the street began 95.5 / 9.5
 */
const DEFEND = `
Poker Hand #AN1: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Bb [Kh Qh]
Btn: raises $1.5 to $2.5
Sb: folds
Bb: calls $1.5
*** FLOP *** [Kd 7c 2s]
Bb: checks
Btn: bets $2
Bb: calls $2
*** TURN *** [Kd 7c 2s] [9h]
Bb: checks
Btn: checks
*** RIVER *** [Kd 7c 2s 9h] [3d]
Bb: checks
Btn: bets $6
Bb: calls $6
*** SHOWDOWN ***
Btn: shows [Ah Kc] (a pair of Kings)
Bb: shows [Kh Qh] (a pair of Kings)
Btn collected $21.5 from pot
*** SUMMARY ***
Total pot $21.5 ${FEES}
Board [Kd 7c 2s 9h 3d]
Seat 1: Btn (button) showed [Ah Kc] and won ($21.5) with a pair of Kings
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Kh Qh] and lost with a pair of Kings
`;

/** The big blind folds a limped pot it could have checked. */
const FREE_FOLD = `
Poker Hand #AN2: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Bb [7c 2d]
Btn: calls $1
Sb: calls $0.5
Bb: folds
*** FLOP *** [Kd 7h 2s]
Sb: checks
Btn: bets $2
Sb: folds
Uncalled bet ($2) returned to Btn
Btn collected $3 from pot
*** SUMMARY ***
Total pot $3 ${FEES}
Board [Kd 7h 2s]
Seat 1: Btn (button) collected ($3)
Seat 2: Sb (small blind) folded on the Flop
Seat 3: Bb (big blind) folded before Flop
`;

/**
 * The hero holds the ace-high flush on Qh 7h 2c 3s 4h. No straight flush is
 * possible (the board's hearts are Q, 7, 4), the board is unpaired: it is the
 * nuts, and it folds to a river bet.
 */
const FOLD_NUTS = `
Poker Hand #AN3: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Bb [Ah Kh]
Btn: raises $1.5 to $2.5
Sb: folds
Bb: calls $1.5
*** FLOP *** [Qh 7h 2c]
Bb: checks
Btn: checks
*** TURN *** [Qh 7h 2c] [3s]
Bb: checks
Btn: checks
*** RIVER *** [Qh 7h 2c 3s] [4h]
Bb: checks
Btn: bets $4
Bb: folds
Uncalled bet ($4) returned to Btn
Btn collected $5.5 from pot
*** SUMMARY ***
Total pot $5.5 ${FEES}
Board [Qh 7h 2c 3s 4h]
Seat 1: Btn (button) collected ($5.5)
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) folded on the River
`;

/** Same board; this time the hero is on the button with the nut flush and checks the river back. */
const CHECK_BACK_NUTS = `
Poker Hand #AN4: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Kh]
Btn: raises $1.5 to $2.5
Sb: folds
Bb: calls $1.5
*** FLOP *** [Qh 7h 2c]
Bb: checks
Btn: checks
*** TURN *** [Qh 7h 2c] [3s]
Bb: checks
Btn: checks
*** RIVER *** [Qh 7h 2c 3s] [4h]
Bb: checks
Btn: checks
*** SHOWDOWN ***
Bb: shows [Js Jd] (a pair of Jacks)
Btn: shows [Ah Kh] (a flush, Ace high)
Btn collected $5.5 from pot
*** SUMMARY ***
Total pot $5.5 ${FEES}
Board [Qh 7h 2c 3s 4h]
Seat 1: Btn (button) showed [Ah Kh] and won ($5.5) with a flush, Ace high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Js Jd] and lost with a pair of Jacks
`;

/**
 * A $20 stack raises to $18: if called the pot is 0.5 + 1 (blinds) + 18 + 17 =
 * $36.5 and $2 is left behind, under a quarter of it.
 */
const THIN_BEHIND = `
Poker Hand #AN5: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($20 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ac Jd]
Btn: raises $17 to $18
Sb: folds
Bb: folds
Uncalled bet ($17) returned to Btn
Btn collected $2.5 from pot
*** SUMMARY ***
Total pot $2.5 ${FEES}
Seat 1: Btn (button) collected ($2.5)
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) folded before Flop
`;

/**
 * $40 deep, the hero has $18 in by the turn (45%) and folds to a $2 bet into
 * $37: the call needed 2 / 41 = 4.9%.
 */
const COMMITTED = `
Poker Hand #AN6: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($40 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [9c 9d]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Kd 7c 2s]
Bb: bets $15
Btn: calls $15
*** TURN *** [Kd 7c 2s] [Qh]
Bb: bets $2
Btn: folds
Uncalled bet ($2) returned to Bb
Bb collected $36.5 from pot
*** SUMMARY ***
Total pot $36.5 ${FEES}
Board [Kd 7c 2s Qh]
Seat 1: Btn (button) folded on the Turn
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) collected ($36.5)
`;

/** Three players see the flop: the hero's flop decision is skipped, the preflop one is not. */
const MULTIWAY = `
Poker Hand #AN7: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'An' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Jh Th]
Btn: raises $1.5 to $2.5
Sb: calls $2
Bb: calls $1.5
*** FLOP *** [9h 8c 2d]
Sb: checks
Bb: checks
Btn: bets $4
Sb: folds
Bb: folds
Uncalled bet ($4) returned to Btn
Btn collected $7.5 from pot
*** SUMMARY ***
Total pot $7.5 ${FEES}
Board [9h 8c 2d]
Seat 1: Btn (button) collected ($7.5)
Seat 2: Sb (small blind) folded on the Flop
Seat 3: Bb (big blind) folded on the Flop
`;

/* -------------------------------------------------------------- tests - */

describe("pot geometry", () => {
  const analysis = analyzeHand(parse(DEFEND));

  it("reads the hero seat and every decision, in the stats engine's order", () => {
    expect(analysis.status).toBe("full");
    expect(analysis.heroSeat).toBe(3);
    expect(analysis.decisions.map((d) => `${d.street}:${d.action}`)).toEqual([
      "preflop:call",
      "flop:check",
      "flop:call",
      "turn:check",
      "river:check",
      "river:call",
    ]);
    expect(analysis.potType).toBe("single-raised");
  });

  it("prices the flop call: 2 into 7.5 needs 21.1%", () => {
    const facts = decision(analysis, "flop", "call").facts;
    expect(facts.potBb).toBe(7.5);
    expect(facts.toCallBb).toBe(2);
    expect(facts.potOdds).toBeCloseTo(2 / 9.5, 3);
    expect(facts.scenario).toBe("caller-oop-vs-bet");
  });

  it("prices the river call, and the bet it faces", () => {
    const facts = decision(analysis, "river", "call").facts;
    expect(facts.potBb).toBe(15.5);
    expect(facts.potOdds).toBeCloseTo(6 / 21.5, 3);
    expect(facts.mdf).toBeCloseTo(1 - 6 / 15.5, 3);
    expect(facts.facingPot).toBeCloseTo(6 / 9.5, 3);
    // SPR as the river began: the hero has 95.5 behind (1 + 1.5 + 2 in), the
    // button 95.5 too, over a 9.5 pot.
    expect(facts.spr).toBeCloseTo(95.5 / 9.5, 2);
  });

  it("names the hand, the kicker and the board", () => {
    const facts = decision(analysis, "flop", "call").facts;
    expect(facts.made).toEqual({ class: "top-pair", kicker: "good", nuts: false });
    expect(facts.texture).toMatchObject({ suits: "rainbow", connectedness: "disconnected", dynamism: "static", highCard: "broadway" });
    expect(facts.handClass).toBe("KQs");
  });

  it("takes an equity against the opener's placeholder range, and its stronger part on the river", () => {
    const river = decision(analysis, "river", "call");
    expect(river.facts.equity?.range).toBe("open:BTN");
    expect(river.facts.equity?.method).toBe("exhaustive");
    expect(river.facts.equity?.strong).not.toBeNull();
    expect(river.facts.equity!.strong!).toBeLessThanOrEqual(river.facts.equity!.value);
    expect(river.approximations).toContain("placeholder-range");
  });

  it("has no grade without a reference, and says the source is a heuristic", () => {
    expect(analysis.grade).toBeNull();
    expect(analysis.score).toBeNull();
    expect(analysis.decisions.every((d) => d.grade === null && d.source === "heuristic" && d.options.length === 0)).toBe(true);
    expect(analysis.approximations).toContain("heuristic");
  });

  it("is deterministic, sampled equities included", () => {
    expect(analyzeHand(parse(DEFEND))).toEqual(analysis);
  });

  it("does not price an unopened pot", () => {
    const open = decision(analyzeHand(parse(THIN_BEHIND)), "preflop", "raise").facts;
    expect(open.preflopScenario).toBe("unopened");
    expect(open.potOdds).toBeNull();
    expect(open.mdf).toBeNull();
  });
});

describe("heuristic flags", () => {
  it("flags a fold when checking was free", () => {
    const fold = decision(analyzeHand(parse(FREE_FOLD)), "preflop", "fold");
    expect(fold.flags.map((f) => [f.code, f.severity])).toEqual([["free-fold", "inaccurate"]]);
    expect(fold.worstFlag).toBe("inaccurate");
  });

  it("flags folding the nuts", () => {
    const analysis = analyzeHand(parse(FOLD_NUTS));
    const fold = decision(analysis, "river", "fold");
    expect(fold.facts.made).toMatchObject({ class: "flush", nuts: true });
    expect(fold.flags.map((f) => f.code)).toContain("fold-nuts");
    expect(analysis.worstFlag).toBe("inaccurate");
    expect(analysis.flagCount).toBeGreaterThanOrEqual(1);
  });

  it("notes checking back the nuts in position on the river — a note, never more", () => {
    const check = decision(analyzeHand(parse(CHECK_BACK_NUTS)), "river", "check");
    expect(check.flags).toEqual([{ code: "check-back-nuts", severity: "note", params: { hand: "flush" } }]);
  });

  it("notes a raise that leaves too little behind", () => {
    const raise = decision(analyzeHand(parse(THIN_BEHIND)), "preflop", "raise");
    expect(raise.flags).toEqual([{ code: "thin-stack-behind", severity: "note", params: { behind: 2, pot: 36.5 } }]);
    expect(raise.facts.behindBb).toBe(2);
  });

  it("notes a committed fold to a tiny price", () => {
    const fold = decision(analyzeHand(parse(COMMITTED)), "turn", "fold");
    expect(fold.facts.potOdds).toBeCloseTo(2 / 41, 3);
    expect(fold.flags).toEqual([{ code: "committed-fold", severity: "note", params: { needed: 5, invested: 45 } }]);
  });

  it("raises nothing on a hand played without incident", () => {
    expect(analyzeHand(parse(DEFEND)).flagCount).toBe(0);
  });
});

describe("what is not analysed", () => {
  it("skips a multiway postflop decision and says why", () => {
    const analysis = analyzeHand(parse(MULTIWAY));
    expect(analysis.status).toBe("partial");
    const bet = decision(analysis, "flop", "bet");
    expect(bet.status).toBe("not-analysed");
    expect(bet.reason).toBe("multiway");
    expect(bet.flags).toEqual([]);
    expect(decision(analysis, "preflop", "raise").status).toBe("analysed");
  });

  const mutate = (fn: (hand: PhfHand) => void) => {
    const hand = parse(DEFEND);
    fn(hand);
    return analyzeHand(hand);
  };

  it.each([
    ["variant", (hand: PhfHand) => void (hand.game.variant = "omaha")],
    ["hi-lo", (hand: PhfHand) => void (hand.game.hiLo = true)],
    ["limit", (hand: PhfHand) => void (hand.game.limit = "pl")],
    ["tournament", (hand: PhfHand) => void (hand.game.format = "tournament")],
    ["no-hero", (hand: PhfHand) => hand.players.forEach((player) => (player.isHero = false))],
    ["hero-cards-unknown", (hand: PhfHand) => hand.players.forEach((player) => (player.holeCards = []))],
  ] as const)("refuses %s by name", (reason, fn) => {
    const analysis = mutate(fn);
    expect(analysis.status).toBe("not-analysed");
    expect(analysis.reason).toBe(reason);
    expect(analysis.decisions).toEqual([]);
  });

  it("refuses a hand where the hero made no decision", () => {
    // The walk: everyone folds to the big blind, who is the hero.
    const walk = parse(FREE_FOLD.replace(/Btn: calls \$1\nSb: calls \$0\.5\nBb: folds\n[\s\S]*?\*\*\* SUMMARY/, "Btn: folds\nSb: folds\nUncalled bet ($0.5) returned to Bb\nBb collected $1 from pot\n*** SUMMARY").replace(/Total pot \$3/, "Total pot $1").replace(/Board \[Kd 7h 2s\]\n/, "").replace("Seat 1: Btn (button) collected ($3)", "Seat 1: Btn (button) folded before Flop (didn't bet)").replace("Seat 2: Sb (small blind) folded on the Flop", "Seat 2: Sb (small blind) folded before Flop").replace("Seat 3: Bb (big blind) folded before Flop", "Seat 3: Bb (big blind) collected ($1)"));
    const analysis = analyzeHand(walk);
    expect(analysis.reason).toBe("no-decisions");
    expect(analysis.potType).toBe("walk");
  });
});

describe("board and hand vocabulary", () => {
  it("reads texture", () => {
    expect(boardTexture(cards("As Kd 2c"))).toMatchObject({ suits: "rainbow", connectedness: "disconnected", dynamism: "static", paired: false });
    expect(boardTexture(cards("9h 8h 7c"))).toMatchObject({ suits: "two-tone", connectedness: "connected", dynamism: "dynamic", straightPossible: true });
    expect(boardTexture(cards("Ks 7s 2s"))).toMatchObject({ suits: "monotone", flushPossible: true });
    expect(boardTexture(cards("8d 8s 3c"))).toMatchObject({ paired: true, trips: false });
    expect(boardTexture(cards("8d 8s 8c"))).toMatchObject({ trips: true });
    expect(boardTexture(cards("2c 7d 9h 3s 4c"))?.volatility).toBeNull();
    expect(boardTexture(cards("2c 7d"))).toBeNull();
  });

  it("names made hands the way a player does", () => {
    const made = (hole: string, board: string) => madeHand(cards(hole), cards(board));
    expect(made("7h 7d", "7c Kd 2s")).toMatchObject({ class: "set" });
    expect(made("Ah 7d", "7c 7s 2s")).toMatchObject({ class: "trips" });
    expect(made("Qh Qd", "Jc 7d 2s")).toMatchObject({ class: "overpair" });
    expect(made("3h 3d", "Jc 7d 5s")).toMatchObject({ class: "underpair" });
    expect(made("9h 9d", "Jc 7d 2s")).toMatchObject({ class: "pocket-pair-below-top" });
    expect(made("Ah Jd", "Jc 7d 2s")).toMatchObject({ class: "top-pair", kicker: "top" });
    expect(made("Kh Jd", "Jc 7d 2s")).toMatchObject({ class: "top-pair", kicker: "good" });
    expect(made("Jh 4d", "Jc 7d 2s")).toMatchObject({ class: "top-pair", kicker: "weak" });
    expect(made("Ah 7h", "Jc 7d 2s")).toMatchObject({ class: "second-pair", kicker: "top" });
    expect(made("Jh 7h", "Jc 7d 2s")).toMatchObject({ class: "two-pair" });
    expect(made("Ah 3h", "Kc Qd 9s")).toMatchObject({ class: "ace-high" });
    expect(made("4h 3d", "Ac Kd Qs Jh Tc")).toMatchObject({ class: "board" });
    expect(made("Ah 5h", "Kh 9h 2h")).toMatchObject({ class: "flush" });
  });

  it("finds draws that use the hero's cards, and only those", () => {
    const of = (hole: string, board: string) => draws(cards(hole), cards(board));
    expect(of("Ah 5h", "Kh 9h 2c")).toContain("nut-flush-draw");
    expect(of("Qh 5h", "Kh 9h 2c")).toContain("flush-draw");
    expect(of("Jh Td", "9c 8s 2d")).toContain("oesd");
    expect(of("Jh 9d", "Qc 8s 2d")).toContain("gutshot");
    expect(of("Ah 5h", "Kh 9c 2d")).toContain("backdoor-flush");
    expect(of("Ah Kd", "7c 8s 2d")).toContain("overcards");
    // A straight draw the board alone already has is not the hero's.
    expect(of("2h 3d", "9c 8s 7d Tc")).not.toContain("oesd");
    // No draws on the river.
    expect(of("Ah 5h", "Kh 9h 2c 3d 4s")).toEqual([]);
  });

  it("names the blockers", () => {
    expect(blockers(cards("Ah 2c"), cards("Kh 9h 4h"))).toContain("nut-flush");
    expect(blockers(cards("Kh 2c"), cards("Ah 9h 4h"))).toContain("nut-flush");
    expect(blockers(cards("Qh 2c"), cards("Ah 9h 4h"))).toContain("second-nut-flush");
    expect(blockers(cards("Ad 2c"), cards("Ah 9h 4c"))).toContain("top-pair");
    expect(blockers(cards("Jd 2c"), cards("Qh Th 9c"))).toContain("nut-straight");
    expect(blockers(cards("Jd 2c"), cards("Qh Th 4c"))).not.toContain("nut-straight");
  });
});

describe("grading (§2), ready for a reference", () => {
  const options = (...pairs: Array<[number, number]>) =>
    pairs.map(([freq, ev], index) => ({ action: (["fold", "call", "raise"] as const)[index], freq, ev }));

  it("calls the mixed strategy's minority action Perfect within the band", () => {
    expect(grade({ options: options([0, 0], [0.52, 1], [0.48, 1]), chosen: 2, pot: 10 }).grade).toBe("perfect");
  });

  it("walks the thresholds in order", () => {
    // max EV 1.0; evLossPot = (1 - ev) / 10
    expect(grade({ options: options([0.9, 1], [0.1, 0.9], [0, 0]), chosen: 1, pot: 10 }).grade).toBe("good");
    expect(grade({ options: options([0.98, 1], [0.02, 0.85], [0, 0]), chosen: 1, pot: 10 }).grade).toBe("inaccurate");
    expect(grade({ options: options([0.98, 1], [0.02, 0.5], [0, 0]), chosen: 1, pot: 10 }).grade).toBe("mistake");
    expect(grade({ options: options([0.98, 1], [0.02, -1], [0, 0]), chosen: 1, pot: 10 }).grade).toBe("blunder");
  });

  it("forgives a rare action whose EV loss is negligible", () => {
    const result = grade({ options: options([0.99, 1], [0.01, 0.995], [0, 0]), chosen: 1, pot: 10 });
    expect(result.grade).toBe("perfect");
    expect(result.score).toBeCloseTo((100 * 0.01) / 0.99, 6);
  });

  it("caps an off-tree or heuristic grade at Inaccurate, and never calls a heuristic Perfect", () => {
    const blunder = { options: options([0.98, 1], [0.02, -1], [0, 0]), chosen: 1, pot: 10 };
    expect(grade({ ...blunder, capAtInaccurate: true }).grade).toBe("inaccurate");
    expect(grade({ options: options([0.5, 1], [0.5, 1], [0, 0]), chosen: 1, pot: 10, noPerfect: true }).grade).toBe("good");
  });

  it("scores EV loss in % of pot", () => {
    const result = grade({ options: options([0.98, 1], [0.02, 0.5], [0, 0]), chosen: 1, pot: 10 });
    expect(result.evLoss).toBeCloseTo(0.5, 9);
    expect(result.evLossPot).toBeCloseTo(0.05, 9);
    expect(result.score).toBeCloseTo(50, 9);
    expect(result.freqDiff).toBeCloseTo(0.96, 9);
  });

  it("refuses to grade against nothing", () => {
    expect(() => grade({ options: [], chosen: 0, pot: 1 })).toThrow(RangeError);
  });

  it("takes the worst grade of a hand, and none for an ungraded one", () => {
    expect(worstGrade(["good", null, "mistake", "perfect"])).toBe("mistake");
    expect(worstGrade([null, null])).toBeNull();
  });
});
