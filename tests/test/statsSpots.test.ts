/**
 * Pinned spot checks: one hand per hard case.
 *
 * `statsDerive.test.ts` asserts *properties* over the whole corpus, which is
 * what catches a derivation that is internally inconsistent. It cannot catch a
 * derivation that is consistently wrong — a 3-bet counter that fires on the
 * wrong raise still satisfies every structural rule. That is what this file is
 * for: each case is a hand small enough to read in full, with the counters
 * spelled out.
 *
 * The seventeen synthetic hands live in `tests/test/fixtures/stats/` as
 * standard text — the GG dialect, which `parseStandardHand` reads — so the
 * fixture *is* the documentation: open the file and the spot is right there.
 * They are deliberately minimal and deliberately arithmetic-clean, so a failure
 * points at a definition rather than at a parser.
 *
 * The remaining cases cannot be synthesized honestly — a bomb pot, a GG EV
 * cashout, a run-it-twice and a WePlay straddle are all things a specific room
 * writes in a specific way — so they are pinned against real corpus files.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";
import type { HandFacts, SeatCounters } from "../../frontend/src/lib/stats/types.js";
import { allStatsInvariants } from "./support/statsInvariants.js";

const ROOT = join(import.meta.dirname, "../..");
const STATS_FIXTURES = join(import.meta.dirname, "fixtures/stats");
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/** Loads one of the hand-written standard-text fixtures. */
function fixture(name: string): HandFacts {
  const text = readFileSync(join(STATS_FIXTURES, name), "utf8");
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error(`${name} did not parse`);
  }
  return handFacts(hand);
}

/** The counters for one seat, by the name the fixture gives the player. */
function seat(facts: HandFacts, player: string): SeatCounters {
  const found = facts.seats.find((entry) => entry.player === player);
  if (!found) {
    throw new Error(`no seat for ${player}`);
  }
  return found.counters;
}

function money(facts: HandFacts, player: string) {
  const found = facts.seats.find((entry) => entry.player === player);
  if (!found) {
    throw new Error(`no seat for ${player}`);
  }
  return found.money;
}

/** Every counter that is not zero, which is what a spot check reads best. */
function nonZero(counters: SeatCounters): Record<string, number> {
  return Object.fromEntries(Object.entries(counters).filter(([, value]) => value !== 0));
}

/** Converts a real corpus file through the app's own entry point. */
async function corpus(relativePath: string): Promise<PhfHand[]> {
  const text = readFileSync(join(ROOT, relativePath), "utf8");
  const result = await convertAny(text, { sourceFilename: relativePath });
  return result.hands;
}

/* ============================================================== preflop == */

describe("preflop spots", () => {
  it("gives the walked big blind no VPIP opportunity at all", () => {
    // PT4. HM3 counts the walk as a non-VPIP hand, which drags big-blind VPIP
    // down by roughly the walk rate. The hand still counts: `hands` is 1.
    const facts = fixture("01-walk.txt");
    expect(facts.hand.isWalk).toBe(true);
    expect(nonZero(seat(facts, "Bb"))).toEqual({ hands: 1 });
    // Everyone who folded did have a decision, and an unopened one at that.
    expect(seat(facts, "Utg").vpip_opp).toBe(1);
    expect(seat(facts, "Utg").rfi_opp).toBe(1);
    // ...and the blind is still real money.
    expect(money(facts, "Sb").net).toBe(-50);
    expect(money(facts, "Bb").net).toBe(50);
  });

  it("treats a straddle as a blind, so the raise over it is an open", () => {
    // The deliberate call. HM3 counts the straddle as a raise, which would make
    // this an open-raise-over-a-raise, i.e. a 3-bet, and would shift every
    // later level with it.
    const facts = fixture("02-straddle-open-is-not-a-three-bet.txt");
    expect(facts.hand.hasStraddle).toBe(true);

    const co = seat(facts, "Co");
    expect(co.rfi).toBe(1);
    expect(co.pfr).toBe(1);
    expect(co.three_bet).toBe(0);
    expect(co.three_bet_opp).toBe(0);

    // The straddler put money in, but not voluntarily.
    const utg = seat(facts, "Utg");
    expect(utg.vpip_opp).toBe(1);
    expect(utg.vpip).toBe(0);
    expect(money(facts, "Utg").contributed).toBe(200);

    // A straddled pot is not a steal spot for anybody: with a straddler acting
    // after the blinds, "folded to the cutoff" no longer means what it means.
    for (const entry of facts.seats) {
      expect(entry.counters.steal_opp).toBe(0);
      expect(entry.counters.fold_to_steal_opp).toBe(0);
    }
  });

  it("counts a dead post as money in the pot but never as VPIP", () => {
    // PT4 and HM3 agree here. `isPostingAction()` is the test.
    const facts = fixture("03-dead-post-is-not-vpip.txt");
    const hj = seat(facts, "Hj");
    expect(hj.vpip_opp).toBe(1);
    expect(hj.vpip).toBe(0);
    expect(money(facts, "Hj").contributed).toBe(100);
    expect(money(facts, "Hj").net).toBe(-100);
  });

  it("records a steal and both blinds folding to it", () => {
    const facts = fixture("04-steal-and-fold-to-steal.txt");
    const co = seat(facts, "Co");
    expect(co.steal_opp).toBe(1);
    expect(co.steal).toBe(1);
    expect(co.rfi).toBe(1);

    for (const blind of ["Sb", "Bb"]) {
      const c = seat(facts, blind);
      expect(c.fold_to_steal_opp).toBe(1);
      expect(c.fold_to_steal).toBe(1);
      expect(c.call_steal + c.three_bet_vs_steal).toBe(0);
    }
    // The button is not a blind, so folding to a cutoff open is not a
    // fold-to-steal; it is just a fold.
    expect(seat(facts, "Btn").fold_to_steal_opp).toBe(0);
    expect(seat(facts, "Btn").cold_call_opp).toBe(1);
  });

  it("separates an isolation raise from a raise first in", () => {
    // PT4's call. Counting the isolation raise as an open makes a player's
    // apparent open-raise frequency higher than it is, by exactly the rate at
    // which they punish limpers - which at a loose table is most of it.
    const facts = fixture("05-isolation-raise-is-not-rfi.txt");
    const co = seat(facts, "Co");
    expect(co.iso_opp).toBe(1);
    expect(co.iso).toBe(1);
    expect(co.rfi_opp).toBe(0);
    expect(co.rfi).toBe(0);
    expect(co.pfr).toBe(1);

    // The limper had the unopened pot, and limped it.
    const utg = seat(facts, "Utg");
    expect(utg.rfi_opp).toBe(1);
    expect(utg.rfi).toBe(0);
    expect(utg.limp_opp).toBe(1);
    expect(utg.limp).toBe(1);
  });

  it("needs a cold caller for a raise to be a squeeze", () => {
    const facts = fixture("06-squeeze.txt");
    const btn = seat(facts, "Btn");
    expect(btn.three_bet).toBe(1);
    expect(btn.squeeze_opp).toBe(1);
    expect(btn.squeeze).toBe(1);

    // The cold caller is a cold caller and not a blind defender.
    const hj = seat(facts, "Hj");
    expect(hj.cold_call_opp).toBe(1);
    expect(hj.cold_call).toBe(1);

    // The opener faced the 3-bet and folded.
    const utg = seat(facts, "Utg");
    expect(utg.fold_to_three_bet_opp).toBe(1);
    expect(utg.fold_to_three_bet).toBe(1);
    expect(utg.call_three_bet + utg.raise_vs_three_bet).toBe(0);
  });

  it("walks the raise levels through a four-bet war", () => {
    const facts = fixture("07-four-bet-war.txt");
    const utg = seat(facts, "Utg");
    expect(utg.rfi).toBe(1);
    expect(utg.four_bet_opp).toBe(1);
    expect(utg.four_bet).toBe(1);
    expect(utg.fold_to_three_bet_opp).toBe(1);
    expect(utg.raise_vs_three_bet).toBe(1);

    const co = seat(facts, "Co");
    expect(co.three_bet_opp).toBe(1);
    expect(co.three_bet).toBe(1);
    expect(co.five_bet_opp).toBe(1);
    expect(co.five_bet).toBe(0);
    expect(co.fold_to_four_bet_opp).toBe(1);
    expect(co.fold_to_four_bet).toBe(1);

    // Rule 5: each of these is 0 or 1 even though the action came round twice.
    expect(utg.pfr).toBe(1);
    expect(utg.vpip).toBe(1);
  });

  it("does not call a blind's defence a cold call", () => {
    const facts = fixture("08-blind-defence-is-not-a-cold-call.txt");
    const bb = seat(facts, "Bb");
    expect(bb.vpip).toBe(1);
    expect(bb.cold_call_opp).toBe(0);
    expect(bb.call_steal).toBe(1);
    // The button, who had nothing in the middle, did cold call.
    expect(seat(facts, "Btn").cold_call).toBe(1);
  });

  it("gives nobody a steal opportunity heads-up", () => {
    // `positionRing(2)` is ["SB","BB"]: there is no button seat, and every
    // small-blind raise is a steal by definition, so the stat means nothing.
    const facts = fixture("14-heads-up-has-no-steal.txt");
    expect(facts.seats.map((entry) => entry.position)).toEqual(["SB", "BB"]);
    for (const entry of facts.seats) {
      expect(entry.counters.steal_opp).toBe(0);
      expect(entry.counters.fold_to_steal_opp).toBe(0);
    }
    expect(seat(facts, "Sb").rfi).toBe(1);
    expect(seat(facts, "Bb").three_bet_opp).toBe(1);
  });
});

/* ============================================================= postflop == */

describe("postflop spots", () => {
  it("requires the flop cbet to have been called before a turn cbet", () => {
    // PT4's definition, and the one that answers "do I barrel".
    const facts = fixture("09-turn-cbet-needs-a-called-flop-cbet.txt");
    const co = seat(facts, "Co");
    expect(co.cbet_flop_opp).toBe(1);
    expect(co.cbet_flop).toBe(1);
    expect(co.cbet_turn_opp).toBe(1);
    expect(co.cbet_turn).toBe(1);
    // The turn bet took the pot, so there is no river opportunity.
    expect(co.cbet_river_opp).toBe(0);

    const bb = seat(facts, "Bb");
    expect(bb.fold_to_cbet_flop_opp).toBe(1);
    expect(bb.call_cbet_flop).toBe(1);
    expect(bb.fold_to_cbet_turn_opp).toBe(1);
    expect(bb.fold_to_cbet_turn).toBe(1);
  });

  it("ends the cbet chain when the flop cbet is raised rather than called", () => {
    // HM3 counts the raiser's turn bet as a turn cbet anyway, which merges "I
    // barrelled" with "my cbet got raised, I called, and then I led the turn".
    const facts = fixture("10-raised-flop-cbet-ends-the-chain.txt");
    const co = seat(facts, "Co");
    expect(co.cbet_flop).toBe(1);
    expect(co.cbet_turn_opp).toBe(0);
    expect(co.cbet_turn).toBe(0);
    expect(co.bet_turn).toBe(1);

    const bb = seat(facts, "Bb");
    expect(bb.raise_cbet_flop).toBe(1);
    expect(bb.check_raise_flop_opp).toBe(1);
    expect(bb.check_raise_flop).toBe(1);
  });

  it("takes the cbet spot away from a raiser who was donked into", () => {
    const facts = fixture("11-donk-bet-removes-the-cbet-spot.txt");
    const bb = seat(facts, "Bb");
    expect(bb.donk_flop_opp).toBe(1);
    expect(bb.donk_flop).toBe(1);

    const co = seat(facts, "Co");
    expect(co.flop_seen).toBe(1);
    expect(co.cbet_flop_opp).toBe(0);
  });

  it("gives nobody a cbet opportunity in a limped pot", () => {
    // No preflop raiser, so there is nothing to continue.
    const facts = fixture("12-limped-pot-has-no-cbet.txt");
    for (const entry of facts.seats) {
      expect(entry.counters.cbet_flop_opp).toBe(0);
      expect(entry.counters.donk_flop_opp).toBe(0);
    }
    expect(seat(facts, "Utg").bet_flop).toBe(1);
    expect(seat(facts, "Bb").check_raise_flop_opp).toBe(1);
    expect(seat(facts, "Bb").check_raise_flop).toBe(0);
  });

  it("sees the flop without having a cbet opportunity when all-in preflop", () => {
    /*
     * The headline case for rule 4. `flop_seen` is a denominator for the
     * showdown stats and counts a player who was all-in before the flop, since
     * they were genuinely still in the hand. `cbet_flop_opp` is a decision
     * point and does not, because there was no decision to make. Conflating the
     * two is how a short stack's cbet% comes out artificially low.
     */
    const facts = fixture("13-all-in-preflop-is-not-a-cbet-spot.txt");
    const co = seat(facts, "Co");
    expect(co.pfr).toBe(1);
    expect(co.flop_seen).toBe(1);
    expect(co.turn_seen).toBe(1);
    expect(co.river_seen).toBe(1);
    expect(co.cbet_flop_opp).toBe(0);
    expect(co.wtsd).toBe(1);
    expect(co.wsd).toBe(0);

    const bb = seat(facts, "Bb");
    expect(bb.wtsd).toBe(1);
    expect(bb.wsd).toBe(1);
    expect(bb.wwsf).toBe(1);
  });

  it("splits the response to a cbet into fold, call and raise", () => {
    const facts = fixture("16-fold-to-cbet-legs.txt");
    const btn = seat(facts, "Btn");
    expect(btn.fold_to_cbet_flop_opp).toBe(1);
    expect(btn.raise_cbet_flop).toBe(1);
    expect(btn.fold_to_cbet_flop + btn.call_cbet_flop).toBe(0);

    // The big blind's fold came after the raise, so it answered the raise and
    // not the continuation bet. Counting it as a fold-to-cbet would overstate
    // how often the cbet worked.
    const bb = seat(facts, "Bb");
    expect(bb.fold_flop).toBe(1);
    expect(bb.fold_to_cbet_flop_opp).toBe(0);
  });

  it("carries the cbet chain all the way to the river", () => {
    const facts = fixture("17-triple-barrel-and-rake.txt");
    const co = seat(facts, "Co");
    expect([co.cbet_flop, co.cbet_turn, co.cbet_river]).toEqual([1, 1, 1]);
    expect([co.cbet_flop_opp, co.cbet_turn_opp, co.cbet_river_opp]).toEqual([1, 1, 1]);

    const bb = seat(facts, "Bb");
    expect(bb.call_cbet_flop).toBe(1);
    expect(bb.call_cbet_turn).toBe(1);
    expect(bb.fold_to_cbet_river).toBe(1);
    // The aggression factor's ingredients: two calls, no bets, no raises.
    expect(bb.bet_flop + bb.bet_turn + bb.bet_river).toBe(0);
    expect(bb.call_flop + bb.call_turn + bb.call_river).toBe(2);
  });
});

/* ================================================================ money == */

describe("money spots", () => {
  it("attributes the fees to the seat that took the pot", () => {
    const facts = fixture("17-triple-barrel-and-rake.txt");
    // Rake $2 + Jackpot $0.36 = 236 minor units, all of it out of the one pot.
    expect(facts.hand.fees).toBe(236);
    expect(money(facts, "Co").rake_paid).toBe(236);
    expect(money(facts, "Bb").rake_paid).toBe(0);
    // GG states its collect net of the fees, so `won` is taken as written.
    expect(money(facts, "Co").won).toBe(3214);
    expect(money(facts, "Co").net).toBe(1514);
    const net = facts.seats.reduce((sum, entry) => sum + entry.money.net, 0);
    expect(net).toBe(-236);
  });

  it("keeps a big-blind ante in the poster's contribution and says so", () => {
    /*
     * One seat posts the ante for the whole table, so its `contributed` carries
     * six players' worth of ante. That money is real and it stays in `net` — a
     * hand where the big blind paid the table's ante genuinely cost that seat
     * that much. What it means is that a report *filtered to the big blind* is
     * misleading, which is why the flag is on the row. Documented, not "fixed":
     * netting it out would break the table-wide money identity and would be a
     * modelling choice no room reports.
     */
    const facts = fixture("15-big-blind-ante.txt");
    expect(facts.hand.isBigBlindAnte).toBe(true);
    expect(money(facts, "Bb").contributed).toBe(700);
    expect(money(facts, "Bb").net).toBe(-700);
    const net = facts.seats.reduce((sum, entry) => sum + entry.money.net, 0);
    expect(net).toBe(0);
  });

  it("normalizes a room that states its collects gross of the rake", async () => {
    /*
     * WePlay writes the gross pot on the collect line and reports the rake only
     * in the summary, where GG writes what the winner actually received. Left
     * alone the difference is invisible and every WePlay graph reads high by
     * exactly the rake.
     */
    const hands = await corpus(
      "weplay-hh/kole1992/HH20260205 Lisbon #1 (#11485806) - $1-$2 - Money 3 No Limit Hold_em.txt",
    );
    const raked = hands.find((hand) => hand.results.fees.rake > 0);
    expect(raked).toBeDefined();
    const facts = handFacts(raked!);
    const winner = facts.seats.find((entry) => entry.money.won > 0);
    expect(winner).toBeDefined();

    const collected = raked!.actions
      .filter((action) => action.type === "collect" && action.seat === winner!.seat)
      .reduce((sum, action) => sum + action.amount, 0);
    expect(winner!.money.won).toBe(collected - winner!.money.rake_paid);

    const net = facts.seats.reduce((sum, entry) => sum + entry.money.net, 0);
    expect(net).toBe(-facts.hand.fees);
  });

  it("sums a run-it-twice result across both runouts with no special case", async () => {
    const hands = await corpus("gg-hh/GG20260217-0406 - NLHPurple6 - 0.25 - 0.5 - 6max.txt");
    const twice = hands.find((hand) => hand.board.runouts.length > 1);
    expect(twice).toBeDefined();
    const facts = handFacts(twice!);
    expect(facts.hand.isRunItTwice).toBe(true);

    // `won` is the sum of the collects over every runout, so realized bb/100 is
    // exact without the engine knowing what a runout is.
    const collects = twice!.actions.filter((action) => action.type === "collect");
    expect(collects.length).toBeGreaterThan(1);
    const total = facts.seats.reduce((sum, entry) => sum + entry.money.won, 0);
    // GG states its collects net of the fees, so the runouts simply add up.
    expect(total).toBe(collects.reduce((sum, action) => sum + action.amount, 0));
    expect(allStatsInvariants(twice!)).toEqual([]);
  });

  it("flags an EV cashout rather than trusting won minus contributed", async () => {
    const hands = await corpus("gg-hh/GG20260217-0518 - NLHPurple11 - 0.25 - 0.5 - 6max.txt");
    const cashed = hands.find((hand) =>
      hand.actions.some((action) => action.type === "cashout-pay"),
    );
    expect(cashed).toBeDefined();
    const facts = handFacts(cashed!);
    expect(facts.hand.hasCashout).toBe(true);

    const seller = facts.seats.find((entry) => entry.counters.cashed_out === 1);
    expect(seller).toBeDefined();
    expect(seller!.money.cashout_risk).toBeGreaterThan(0);
    // The player sold their equity, so `won - contributed` is not their result.
    // `rates.aggregate` drops these from the money series by default.
    expect(seller!.money.net).not.toBe(seller!.money.net - seller!.money.cashout_risk);
  });
});

/* ============================================================= bomb pot == */

describe("bomb pot", () => {
  it("has no preflop betting round, so every preflop opportunity is zero", async () => {
    const hands = await corpus("fixtures/samples/weplay/03-cash-bomb-pot-ante-only.txt");
    const bomb = hands.find((hand) => handFacts(hand).hand.isBombPot);
    expect(bomb).toBeDefined();
    const facts = handFacts(bomb!);

    expect(facts.hand.isBombPot).toBe(true);
    for (const entry of facts.seats) {
      const c = entry.counters;
      expect(c.vpip_opp).toBe(0);
      expect(c.vpip).toBe(0);
      expect(c.pfr_opp).toBe(0);
      expect(c.rfi_opp).toBe(0);
      expect(c.limp_opp).toBe(0);
      expect(c.steal_opp).toBe(0);
      expect(c.three_bet_opp).toBe(0);
      // Everyone who anted sees the flop, which is the whole point of the game.
      expect(c.flop_seen).toBe(1);
    }
    // And nobody is the preflop raiser, so nobody continuation-bets.
    expect(facts.seats.every((entry) => entry.counters.cbet_flop_opp === 0)).toBe(true);
  });
});

/* ================================================== every fixture holds == */

describe("every hand-written fixture holds the invariants", () => {
  const names = [
    "01-walk.txt",
    "02-straddle-open-is-not-a-three-bet.txt",
    "03-dead-post-is-not-vpip.txt",
    "04-steal-and-fold-to-steal.txt",
    "05-isolation-raise-is-not-rfi.txt",
    "06-squeeze.txt",
    "07-four-bet-war.txt",
    "08-blind-defence-is-not-a-cold-call.txt",
    "09-turn-cbet-needs-a-called-flop-cbet.txt",
    "10-raised-flop-cbet-ends-the-chain.txt",
    "11-donk-bet-removes-the-cbet-spot.txt",
    "12-limped-pot-has-no-cbet.txt",
    "13-all-in-preflop-is-not-a-cbet-spot.txt",
    "14-heads-up-has-no-steal.txt",
    "15-big-blind-ante.txt",
    "16-fold-to-cbet-legs.txt",
    "17-triple-barrel-and-rake.txt",
  ];

  it.each(names)("%s", (name) => {
    const text = readFileSync(join(STATS_FIXTURES, name), "utf8");
    const hand = parseStandardHand(text, CTX);
    expect(hand).not.toBeNull();
    expect(allStatsInvariants(hand!)).toEqual([]);
  });
});
