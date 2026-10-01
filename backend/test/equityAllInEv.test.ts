/**
 * All-in EV on hand-written hands.
 *
 * Each fixture is standard text parsed by `parseStandardHand`, the same way
 * `statsSpots.test.ts` builds its hands, so the action stream is exactly what a
 * real import produces. The numbers asserted are worked out in the comments;
 * where an equity is needed it is taken from `equity()`, which has its own
 * suite, so these tests are about the walk, the pots and the rounding.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeAllIn,
  allInEv,
  equity,
  evNetBySeat,
  EV_VERSION,
} from "../../frontend/src/lib/equity/index.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";
import { STATS_VERSION } from "../../frontend/src/lib/stats/types.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text.trim(), CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

/** `net` per seat, from the stats engine. */
function netBySeat(hand: PhfHand): Map<number, number> {
  return new Map(handFacts(hand).seats.map((seat) => [seat.seat, seat.money.net]));
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

/* ------------------------------------------------------------ fixtures - */

/** Heads-up preflop: aces against kings, all in for $100 each, kings hit. */
const PREFLOP = `
Poker Hand #EV1: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Sb [Ah Ad]
Btn: folds
Sb: raises $99 to $100 and is all-in
Bb: calls $99 and is all-in
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [Kc]
*** RIVER *** [2c 7d 9h Kc] [3s]
*** SHOWDOWN ***
Sb: shows [Ah Ad] (a pair of Aces)
Bb: shows [Kh Kd] (three of a kind, Kings)
Bb collected $200 from pot
*** SUMMARY ***
Total pot $200 ${FEES}
Board [2c 7d 9h Kc 3s]
Seat 1: Btn (button) folded before Flop (didn't bet)
Seat 2: Sb (small blind) showed [Ah Ad] and lost with a pair of Aces
Seat 3: Bb (big blind) showed [Kh Kd] and won ($200) with three of a kind, Kings
`;

/** Turn all-in, flush draw against a set, $3 rake, the draw gets there. */
const TURN = `
Poker Hand #EV2: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($50 in chips)
Seat 2: Sb ($50 in chips)
Seat 3: Bb ($50 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Kh]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Qh 7h 2c]
Bb: checks
Btn: bets $5
Bb: calls $5
*** TURN *** [Qh 7h 2c] [3s]
Bb: bets $42 and is all-in
Btn: calls $42 and is all-in
*** RIVER *** [Qh 7h 2c 3s] [4h]
*** SHOWDOWN ***
Bb: shows [Qs Qd] (three of a kind, Queens)
Btn: shows [Ah Kh] (a flush, Ace high)
Btn collected $97.5 from pot
*** SUMMARY ***
Total pot $100.5 | Rake $3 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Qh 7h 2c 3s 4h]
Seat 1: Btn (button) showed [Ah Kh] and won ($97.5) with a flush, Ace high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Qs Qd] and lost with three of a kind, Queens
`;

/**
 * Three stacks all in preflop, plus a seat that raised and then folded.
 *
 *     Btn  $20   all in        AA
 *     Sb   $50   all in        KK
 *     Bb   $50   called, $50 behind   QQ
 *     Utg  $3    raised, then folded
 *
 * Main pot: $20 x 3 + Utg's $3 = $63, contested by all three.
 * Side pot: $30 x 2 = $60, Sb and Bb only.
 */
const SIDE_POT = `
Poker Hand #EV3: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($20 in chips)
Seat 2: Sb ($50 in chips)
Seat 3: Bb ($100 in chips)
Seat 4: Utg ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Ad]
Utg: raises $2 to $3
Btn: raises $17 to $20 and is all-in
Sb: raises $30 to $50 and is all-in
Bb: calls $49
Utg: folds
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [4s]
*** RIVER *** [2c 7d 9h 4s] [3c]
*** SHOWDOWN ***
Btn: shows [Ah Ad] (a pair of Aces)
Sb: shows [Kh Kd] (a pair of Kings)
Bb: shows [Qs Qc] (a pair of Queens)
Sb collected $60 from side pot
Btn collected $63 from main pot
*** SUMMARY ***
Total pot $123 Main pot $63. Side pot $60. ${FEES}
Board [2c 7d 9h 4s 3c]
Seat 1: Btn (button) showed [Ah Ad] and won ($63) with a pair of Aces
Seat 2: Sb (small blind) showed [Kh Kd] and won ($60) with a pair of Kings
Seat 3: Bb (big blind) showed [Qs Qc] and lost with a pair of Queens
Seat 4: Utg folded before Flop
`;

/** The preflop hand, but the loser never shows. */
const MUCKED = `
Poker Hand #EV4: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Sb [Ah Ad]
Btn: folds
Sb: raises $99 to $100 and is all-in
Bb: calls $99 and is all-in
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [Qc]
*** RIVER *** [2c 7d 9h Qc] [3s]
*** SHOWDOWN ***
Sb: shows [Ah Ad] (a pair of Aces)
Bb: mucks hand
Sb collected $200 from pot
*** SUMMARY ***
Total pot $200 ${FEES}
Board [2c 7d 9h Qc 3s]
Seat 1: Btn (button) folded before Flop (didn't bet)
Seat 2: Sb (small blind) showed [Ah Ad] and won ($200) with a pair of Aces
Seat 3: Bb (big blind) mucked
`;

/** All in on the river: nothing left to come. */
const RIVER = `
Poker Hand #EV5: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($10 in chips)
Seat 2: Sb ($10 in chips)
Seat 3: Bb ($10 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Kh]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Qh 7h 2c]
Bb: checks
Btn: checks
*** TURN *** [Qh 7h 2c] [3s]
Bb: checks
Btn: checks
*** RIVER *** [Qh 7h 2c 3s] [4h]
Bb: bets $7 and is all-in
Btn: calls $7 and is all-in
*** SHOWDOWN ***
Bb: shows [Qs Qd] (three of a kind, Queens)
Btn: shows [Ah Kh] (a flush, Ace high)
Btn collected $20.5 from pot
*** SUMMARY ***
Total pot $20.5 ${FEES}
Board [Qh 7h 2c 3s 4h]
Seat 1: Btn (button) showed [Ah Kh] and won ($20.5) with a flush, Ace high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Qs Qd] and lost with three of a kind, Queens
`;

/** No all-in at all: a bet on the river takes it down. */
const NO_ALL_IN = `
Poker Hand #EV6: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($100 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Qd]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [2c 7d 9h]
Bb: checks
Btn: bets $4
Bb: folds
Uncalled bet ($4) returned to Btn
Btn collected $6.5 from pot
*** SUMMARY ***
Total pot $6.5 ${FEES}
Board [2c 7d 9h]
Seat 1: Btn (button) collected ($6.5)
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) folded on the Flop
`;

/**
 * An overbet: Sb shoves $100 into a $60 stack. The extra $40 comes back
 * uncalled, so each seat has $60 at risk, not $100.
 */
const OVERBET = `
Poker Hand #EV7: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($100 in chips)
Seat 2: Sb ($100 in chips)
Seat 3: Bb ($60 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Sb [As Ks]
Btn: folds
Sb: raises $99 to $100 and is all-in
Bb: calls $59 and is all-in
Uncalled bet ($40) returned to Sb
*** FLOP *** [2c 7d 9h]
*** TURN *** [2c 7d 9h] [4s]
*** RIVER *** [2c 7d 9h 4s] [3c]
*** SHOWDOWN ***
Sb: shows [As Ks] (high card Ace)
Bb: shows [Qh Qd] (a pair of Queens)
Bb collected $120 from pot
*** SUMMARY ***
Total pot $120 ${FEES}
Board [2c 7d 9h 4s 3c]
Seat 1: Btn (button) folded before Flop (didn't bet)
Seat 2: Sb (small blind) showed [As Ks] and lost with high card Ace
Seat 3: Bb (big blind) showed [Qh Qd] and won ($120) with a pair of Queens
`;

/** Turn all-in where the kings are drawing dead to quad aces, with rake. */
const DRAWING_DEAD = `
Poker Hand #EV8: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($50 in chips)
Seat 2: Sb ($50 in chips)
Seat 3: Bb ($50 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [Ah Ad]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [As Ac 7s]
Bb: checks
Btn: checks
*** TURN *** [As Ac 7s] [2c]
Bb: bets $47 and is all-in
Btn: calls $47 and is all-in
*** RIVER *** [As Ac 7s 2c] [9d]
*** SHOWDOWN ***
Bb: shows [Kh Kd] (two pair, Aces and Kings)
Btn: shows [Ah Ad] (four of a kind, Aces)
Btn collected $97.5 from pot
*** SUMMARY ***
Total pot $100.5 | Rake $3 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [As Ac 7s 2c 9d]
Seat 1: Btn (button) showed [Ah Ad] and won ($97.5) with four of a kind, Aces
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Kh Kd] and lost with two pair, Aces and Kings
`;

/** A PLO flop all-in. */
const OMAHA = `
Poker Hand #EV9: Omaha Pot Limit ($0.5/$1) - 2026/01/01 12:00:00
Table 'Ev' 6-max Seat #1 is the button
Seat 1: Btn ($20 in chips)
Seat 2: Sb ($20 in chips)
Seat 3: Bb ($20 in chips)
Sb: posts small blind $0.5
Bb: posts big blind $1
*** HOLE CARDS ***
Dealt to Btn [As Ks Qh Jh]
Btn: raises $2 to $3
Sb: folds
Bb: calls $2
*** FLOP *** [Th 9h 2c]
Bb: bets $6
Btn: raises $11 to $17 and is all-in
Bb: calls $11 and is all-in
*** TURN *** [Th 9h 2c] [3d]
*** RIVER *** [Th 9h 2c 3d] [4s]
*** SHOWDOWN ***
Bb: shows [Ad Ac 7c 8d] (a pair of Aces)
Btn: shows [As Ks Qh Jh] (a straight, King high)
Btn collected $40.5 from pot
*** SUMMARY ***
Total pot $40.5 ${FEES}
Board [Th 9h 2c 3d 4s]
Seat 1: Btn (button) showed [As Ks Qh Jh] and won ($40.5) with a straight, King high
Seat 2: Sb (small blind) folded before Flop
Seat 3: Bb (big blind) showed [Ad Ac 7c 8d] and lost with a pair of Aces
`;

/* --------------------------------------------------------------- tests - */

describe("allInEv: when it applies", () => {
  it("splits a heads-up preflop all-in by equity", () => {
    const hand = parse(PREFLOP);
    const ev = allInEv(hand);
    expect(ev).not.toBeNull();
    if (!ev) return;

    expect(ev.evVersion).toBe("ev/1");
    expect(EV_VERSION).not.toBe(STATS_VERSION);
    expect(ev.street).toBe("preflop");
    expect(ev.board).toEqual([]);
    expect(ev.method).toBe("exhaustive");
    expect(ev.pots).toHaveLength(1);
    expect(ev.pots[0].amount).toBe(20000);
    expect(ev.pots[0].eligibleSeats).toEqual([2, 3]);

    // AhAd vs KhKd is 82.637% / 17.363%: 16527.32 and 3472.68 of the 20000.
    // Largest remainder gives the odd unit to the bigger fraction.
    const [aces, kings] = equity({
      game: "holdem",
      hands: [
        ["Ah", "Ad"],
        ["Kh", "Kd"],
      ],
    }).equity;
    expect(aces * 20000).toBeCloseTo(16527.32, 2);
    expect(kings * 20000).toBeCloseTo(3472.68, 2);
    expect(ev.pots[0].shares).toEqual([16527, 3473]);

    const evNet = evNetBySeat(hand);
    expect(evNet).toEqual(
      new Map([
        [1, 0],
        [2, 6527],
        [3, -6527],
      ]),
    );
    // What actually happened, for contrast: the kings won it all.
    const net = netBySeat(hand);
    expect(net.get(2)).toBe(-10000);
    expect(net.get(3)).toBe(10000);
  });

  it("takes a turn all-in from the turn, and splits the pot after rake", () => {
    const hand = parse(TURN);
    const ev = allInEv(hand);
    if (!ev) throw new Error("expected EV");

    expect(ev.street).toBe("turn");
    expect(ev.board).toEqual(["Qh", "7h", "2c", "3s"]);
    expect(ev.boards).toBe(44);
    // $100.50 went in, $3 rake came out, $97.50 was awarded.
    expect(ev.pots[0].gross).toBe(10050);
    expect(ev.pots[0].amount).toBe(9750);
    // The flush draw has 7 outs of 44 (the 2h and 3h fill the queens up):
    // 9750 x 7/44 = 1551.14, the set gets the other 8198.86.
    expect(ev.pots[0].equity).toEqual([7 / 44, 37 / 44]);
    expect(ev.pots[0].shares).toEqual([1551, 8199]);

    const evNet = evNetBySeat(hand);
    expect(evNet?.get(1)).toBe(1551 - 5000);
    expect(evNet?.get(3)).toBe(8199 - 5000);
    // The folded small blind's chips are simply lost, as in `net`.
    expect(evNet?.get(2)).toBe(-50);
    // Both divisions of the money add up to minus the rake.
    expect(sum(evNet?.values() ?? [])).toBe(-300);
    expect(sum(netBySeat(hand).values())).toBe(-300);
  });

  it("builds a side pot and keeps the folded raiser's chips out of everyone's eligibility", () => {
    const hand = parse(SIDE_POT);
    const ev = allInEv(hand);
    if (!ev) throw new Error("expected EV");

    expect(ev.street).toBe("preflop");
    expect(ev.pots.map((pot) => pot.amount)).toEqual([6300, 6000]);
    expect(ev.pots.map((pot) => pot.eligibleSeats)).toEqual([
      [1, 2, 3],
      [2, 3],
    ]);

    // Main pot against all three hands; side pot against KK and QQ alone,
    // with the aces dealt out of the deck but not contesting it.
    const hands = [
      ["Ah", "Ad"],
      ["Kh", "Kd"],
      ["Qs", "Qc"],
    ];
    const reference = equity({
      game: "holdem",
      hands,
      pots: [
        [0, 1, 2],
        [1, 2],
      ],
    });
    expect(ev.pots[0].equity).toEqual(reference.pots[0]);
    expect(ev.pots[1].equity).toEqual([reference.pots[1][1], reference.pots[1][2]]);
    const sideKings = equity({ game: "holdem", hands: [hands[1], hands[2]], dead: hands[0] })
      .equity[0];
    expect(ev.pots[1].equity[0]).toBe(sideKings);

    const bySeat = new Map(ev.seats.map((seat) => [seat.seat, seat]));
    expect(bySeat.get(1)?.contributed).toBe(2000);
    expect(bySeat.get(2)?.contributed).toBe(5000);
    expect(bySeat.get(3)?.contributed).toBe(5000);
    // Utg put $3 in and folded: in the main pot, eligible for nothing.
    expect(bySeat.get(4)).toMatchObject({ live: false, contributed: 300, evWon: 0, evNet: -300 });
    // The short stack can only ever win the main pot.
    expect(bySeat.get(1)?.evWon).toBe(ev.pots[0].shares[0]);
    expect(bySeat.get(1)?.evWon).toBeLessThanOrEqual(6300);

    expect(sum(ev.seats.map((seat) => seat.evNet))).toBe(0);
    expect(sum(ev.pots.flatMap((pot) => pot.shares))).toBe(12300);
  });

  it("charges only the called part of an overbet", () => {
    const hand = parse(OVERBET);
    const ev = allInEv(hand);
    if (!ev) throw new Error("expected EV");
    expect(ev.pots).toHaveLength(1);
    expect(ev.pots[0].amount).toBe(12000);
    const sb = ev.seats.find((seat) => seat.seat === 2);
    expect(sb?.contributed).toBe(6000);
    expect(sum(ev.seats.map((seat) => seat.evNet))).toBe(0);
  });

  it("equals net exactly when one side is drawing dead", () => {
    const hand = parse(DRAWING_DEAD);
    const ev = allInEv(hand);
    if (!ev) throw new Error("expected EV");
    expect(ev.pots[0].equity).toEqual([1, 0]);
    expect(evNetBySeat(hand)).toEqual(netBySeat(hand));
  });

  it("is unchanged by running it twice", () => {
    // Equity is taken at the all-in, before any board exists, so a second
    // runout - which changes who collected what, and so `net` - changes
    // nothing here.
    const once = parse(PREFLOP);
    const twice = structuredClone(once);
    twice.board.runouts.push({
      index: 1,
      flop: ["3c", "8d", "Th"],
      turn: "4c",
      river: "5s",
      markerLabels: {},
      summaryCards: null,
    });
    const collect = twice.actions.find((action) => action.type === "collect");
    if (!collect) throw new Error("no collect");
    collect.amount = 10000;
    twice.actions.push({
      ...collect,
      index: collect.index + 1,
      seat: 2,
      player: "Sb",
      runoutIndex: 1,
    });

    expect(netBySeat(twice)).not.toEqual(netBySeat(once));
    expect(evNetBySeat(twice)).toEqual(evNetBySeat(once));
  });

  it("evaluates Omaha with Omaha rules", () => {
    const hand = parse(OMAHA);
    expect(hand.game.variant).toBe("omaha");
    const ev = allInEv(hand);
    if (!ev) throw new Error("expected EV");
    expect(ev.street).toBe("flop");
    expect(ev.boards).toBe(820); // C(41,2)
    const reference = equity({
      game: "omaha",
      hands: [
        ["As", "Ks", "Qh", "Jh"],
        ["Ad", "Ac", "7c", "8d"],
      ],
      board: ["Th", "9h", "2c"],
    });
    expect(ev.pots[0].equity).toEqual(reference.equity);
    expect(sum(ev.seats.map((seat) => seat.evNet))).toBe(0);
  });
});

describe("allInEv: when it does not apply", () => {
  it("returns null with a reason when a live player's cards are unknown", () => {
    const hand = parse(MUCKED);
    expect(allInEv(hand)).toBeNull();
    expect(evNetBySeat(hand)).toBeNull();
    const outcome = analyzeAllIn(hand);
    expect(outcome).toMatchObject({ applicable: false, reason: "unknown-hole-cards" });
  });

  it("returns null when nobody was all in", () => {
    expect(analyzeAllIn(parse(NO_ALL_IN))).toMatchObject({
      applicable: false,
      reason: "no-all-in",
    });
  });

  it("returns null for a river all-in, where there is no variance to remove", () => {
    expect(analyzeAllIn(parse(RIVER))).toMatchObject({
      applicable: false,
      reason: "no-street-to-come",
    });
  });

  it("returns null for hi/lo and for games without a community board", () => {
    const hiLo = parse(PREFLOP);
    hiLo.game.hiLo = true;
    expect(analyzeAllIn(hiLo)).toMatchObject({ applicable: false, reason: "hi-lo" });

    const stud = parse(PREFLOP);
    stud.game.variant = "stud";
    expect(analyzeAllIn(stud)).toMatchObject({ applicable: false, reason: "unsupported-variant" });
  });

  it("returns null when two boards were dealt before a flop all-in", () => {
    const hand = parse(OMAHA);
    hand.board.runouts.push({
      index: 1,
      flop: ["Ts", "8s", "5d"],
      turn: "6d",
      river: "Kd",
      markerLabels: {},
      summaryCards: null,
    });
    expect(analyzeAllIn(hand)).toMatchObject({ applicable: false, reason: "double-board" });
  });
});
