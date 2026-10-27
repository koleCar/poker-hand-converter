/**
 * Postflop counters: streets seen, continuation bets, donk bets, check-raises
 * and the raw action counts the aggression factor is built from.
 *
 * The distinction this file exists to enforce is rule 4:
 *
 * > **An opportunity is a decision point that actually existed**, never "the
 * > street was reached".
 *
 * `flop_seen` is the second of those — it is a *denominator for showdown stats*
 * and it counts a player who was all-in before the flop, because they were
 * genuinely still in the hand when the board came. `cbet_flop_opp` is the first,
 * and it does not: a player with no chips has no decision to make. The two are
 * one line apart in this file and are the most common place a stats engine goes
 * quietly wrong, because both readings produce plausible-looking numbers and
 * only one of them answers a question about the player.
 *
 * The continuation-bet chain is the other deliberate call. A turn cbet requires
 * the **flop cbet to have been called** (PT4). HM3 counts any turn bet by the
 * preflop raiser, which merges "I barrelled" with "my cbet got raised, I called,
 * and then I led the turn" — two different decisions with opposite meanings.
 */

import type { Decision, PostflopStreet, StatsContext } from "./context";
import { POSTFLOP_STREETS, firstDecision, liveOnStreet, seatStreet } from "./context";
import type { SeatCounters } from "./types";

type StreetKeys = {
  seen: keyof SeatCounters;
  cbetOpp: keyof SeatCounters;
  cbet: keyof SeatCounters;
  foldToCbetOpp: keyof SeatCounters;
  foldToCbet: keyof SeatCounters;
  callCbet: keyof SeatCounters;
  raiseCbet: keyof SeatCounters;
  donkOpp: keyof SeatCounters;
  donk: keyof SeatCounters;
  checkRaiseOpp: keyof SeatCounters;
  checkRaise: keyof SeatCounters;
  bet: keyof SeatCounters;
  raise: keyof SeatCounters;
  call: keyof SeatCounters;
  check: keyof SeatCounters;
  fold: keyof SeatCounters;
};

/** The counter names for each street, so the walk below is written once. */
const KEYS: Record<PostflopStreet, StreetKeys> = {
  flop: {
    seen: "flop_seen",
    cbetOpp: "cbet_flop_opp",
    cbet: "cbet_flop",
    foldToCbetOpp: "fold_to_cbet_flop_opp",
    foldToCbet: "fold_to_cbet_flop",
    callCbet: "call_cbet_flop",
    raiseCbet: "raise_cbet_flop",
    donkOpp: "donk_flop_opp",
    donk: "donk_flop",
    checkRaiseOpp: "check_raise_flop_opp",
    checkRaise: "check_raise_flop",
    bet: "bet_flop",
    raise: "raise_flop",
    call: "call_flop",
    check: "check_flop",
    fold: "fold_flop",
  },
  turn: {
    seen: "turn_seen",
    cbetOpp: "cbet_turn_opp",
    cbet: "cbet_turn",
    foldToCbetOpp: "fold_to_cbet_turn_opp",
    foldToCbet: "fold_to_cbet_turn",
    callCbet: "call_cbet_turn",
    raiseCbet: "raise_cbet_turn",
    donkOpp: "donk_turn_opp",
    donk: "donk_turn",
    checkRaiseOpp: "check_raise_turn_opp",
    checkRaise: "check_raise_turn",
    bet: "bet_turn",
    raise: "raise_turn",
    call: "call_turn",
    check: "check_turn",
    fold: "fold_turn",
  },
  river: {
    seen: "river_seen",
    cbetOpp: "cbet_river_opp",
    cbet: "cbet_river",
    foldToCbetOpp: "fold_to_cbet_river_opp",
    foldToCbet: "fold_to_cbet_river",
    callCbet: "call_cbet_river",
    raiseCbet: "raise_cbet_river",
    donkOpp: "donk_river_opp",
    donk: "donk_river",
    checkRaiseOpp: "check_raise_river_opp",
    checkRaise: "check_raise_river",
    bet: "bet_river",
    raise: "raise_river",
    call: "call_river",
    check: "check_river",
    fold: "fold_river",
  },
};

/** One entry of the continuation-bet chain, resolved once per hand. */
interface CbetLink {
  /** The preflop raiser had a real decision here with no bet in front of it. */
  opportunity: boolean;
  /** ...and they bet. */
  made: Decision | null;
  /** The bet was called by at least one opponent and not raised. */
  called: boolean;
}

/**
 * Resolves the continuation-bet chain for the hand.
 *
 * Only the preflop raiser can have a link, and each street's link depends on
 * the one before it, which is why this is computed per hand rather than per
 * seat. A limped pot has no preflop raiser and therefore no chain at all —
 * nobody has a cbet opportunity in a pot nobody raised.
 */
export function cbetChain(context: StatsContext): Record<PostflopStreet, CbetLink> {
  const empty: CbetLink = { opportunity: false, made: null, called: false };
  const chain: Record<PostflopStreet, CbetLink> = {
    flop: { ...empty },
    turn: { ...empty },
    river: { ...empty },
  };

  const aggressor = context.preflopAggressor;
  if (aggressor === null || context.isBombPot) {
    return chain;
  }

  let allowed = true;
  for (const street of POSTFLOP_STREETS) {
    if (!allowed) {
      break;
    }
    const decision = firstDecision(context, aggressor, street);
    if (!decision) {
      // No decision on this street: the raiser was all-in, or folded earlier, or
      // the street was never dealt. Rule 4 — no decision, no opportunity.
      break;
    }
    if (decision.aggressionBefore > 0) {
      // Somebody led into the raiser. That is a donk-bet spot for them and a
      // fold-to-donk spot for the raiser, not a continuation bet.
      break;
    }
    chain[street].opportunity = true;
    if (decision.type !== "bet") {
      break;
    }
    chain[street].made = decision;

    // Was it called? The next street's opportunity depends on it (PT4). A raise
    // ends the chain: whatever the raiser did next, it was not a barrel.
    let called = false;
    for (const later of context.byStreet.get(street) ?? []) {
      if (later.order <= decision.order) {
        continue;
      }
      if (later.type === "raise") {
        called = false;
        break;
      }
      if (later.type === "call") {
        called = true;
      }
    }
    chain[street].called = called;
    allowed = called;
  }

  return chain;
}

/** Fills in every postflop counter for one seat. */
export function postflopCounters(
  context: StatsContext,
  seat: number,
  counters: SeatCounters,
  chain: Record<PostflopStreet, CbetLink>,
): void {
  const aggressor = context.preflopAggressor;

  for (const street of POSTFLOP_STREETS) {
    const keys = KEYS[street];
    if (!liveOnStreet(context, seat, street)) {
      continue;
    }

    /*
     * Saw the street. Not an opportunity in the sense of rule 4: a player who
     * was all-in before the flop saw every card, and WWSF / WTSD are quoted
     * over exactly that population.
     */
    counters[keys.seen] = 1;

    const mine = seatStreet(context, seat, street);
    for (const decision of mine) {
      if (decision.type === "bet") counters[keys.bet] += 1;
      if (decision.type === "raise") counters[keys.raise] += 1;
      if (decision.type === "call") counters[keys.call] += 1;
      if (decision.type === "check") counters[keys.check] += 1;
      if (decision.type === "fold") counters[keys.fold] += 1;
    }

    const first = mine[0] ?? null;

    /* --------------------------------------------------- continuation bets - */

    if (seat === aggressor) {
      const link = chain[street];
      if (link.opportunity) {
        counters[keys.cbetOpp] = 1;
        if (link.made) {
          counters[keys.cbet] = 1;
        }
      }
    } else {
      const cbet = chain[street].made;
      if (cbet) {
        // Facing the continuation bet: the seat's first decision on the street
        // after it, with nobody having raised in between. A raise in front
        // changes the price and the question, so that spot is not counted here.
        // Having *checked* before the cbet does not disqualify the spot — check,
        // get bet at, fold is the commonest fold-to-cbet there is.
        const facing = mine.find(
          (decision) => decision.order > cbet.order && decision.raisesBefore === 0,
        );
        if (facing) {
          counters[keys.foldToCbetOpp] = 1;
          if (facing.type === "fold") counters[keys.foldToCbet] += 1;
          else if (facing.type === "call") counters[keys.callCbet] += 1;
          else if (facing.type === "raise" || facing.type === "bet") counters[keys.raiseCbet] += 1;
        }
      }
    }

    /* --------------------------------------------------------- donk bets - */

    /*
     * The aggressor of the street before. A street that checked through leaves
     * nobody to donk into, so there is no opportunity on the next street — a
     * bet there is just a bet.
     */
    const previous: number | null =
      street === "flop"
        ? aggressor
        : (context.streetAggressor.get(street === "turn" ? "flop" : "turn") ?? null);
    if (
      first &&
      previous !== null &&
      previous !== seat &&
      liveOnStreet(context, previous, street) &&
      first.aggressionBefore === 0 &&
      // The aggressor has not acted yet: betting *after* they check is a bet
      // into a missed continuation bet, which is the opposite read.
      !(context.byStreet.get(street) ?? []).some(
        (decision) => decision.seat === previous && decision.order < first.order,
      )
    ) {
      counters[keys.donkOpp] = 1;
      if (first.type === "bet") {
        counters[keys.donk] = 1;
      }
    }

    /* ------------------------------------------------------- check-raises - */

    const returned = mine.find(
      (decision) => decision.checkedBefore && decision.aggressionBefore > 0,
    );
    if (returned) {
      // The seat checked and then got the action back against a bet. Without
      // that second decision there is no check-raise opportunity, only a check.
      counters[keys.checkRaiseOpp] = 1;
      if (returned.type === "raise") {
        counters[keys.checkRaise] = 1;
      }
    }
  }
}
