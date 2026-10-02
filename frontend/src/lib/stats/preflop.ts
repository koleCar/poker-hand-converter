/**
 * Preflop counters.
 *
 * Rule 5 of the module governs everything here: **a preflop opportunity is 0 or
 * 1 per hand, counted at the seat's *first* qualifying decision.** Action can
 * come back around to a seat three or four times in a raised pot, and a stat
 * that counted each pass would make one four-bet war look like a whole session.
 *
 * "Raise level" is the spine. It counts only voluntary `raise` actions on the
 * street, so the big blind is level 0 and the first voluntary raise is the open.
 * **A straddle is a blind, not a raise** — PT4's call, against HM3's. Treating
 * forced money as aggression would make every straddled pot's open raise look
 * like a 3-bet, every 3-bet like a 4-bet, and the error propagates into
 * fold-to-3bet, squeeze and steal-defence all at once. `has_straddle` is on the
 * row so straddled hands can be excluded wholesale instead.
 */

import type { StatsContext, Decision } from "./context";
import { seatStreet } from "./context";
import type { SeatCounters } from "./types";

/** Positions from which an unopened raise is a steal attempt. */
const STEAL_POSITIONS = new Set(["CO", "BTN", "SB"]);

/** Facing a bet, there are exactly three replies. Used by every leg set here. */
function leg(
  counters: SeatCounters,
  decision: Decision,
  foldKey: keyof SeatCounters,
  callKey: keyof SeatCounters,
  raiseKey: keyof SeatCounters,
): void {
  if (decision.type === "fold") {
    counters[foldKey] += 1;
  } else if (decision.type === "call") {
    counters[callKey] += 1;
  } else if (decision.type === "raise" || decision.type === "bet") {
    counters[raiseKey] += 1;
  }
}

/**
 * Whether a preflop decision is a steal attempt.
 *
 * Unopened pot, a raise, from the cutoff, button or small blind, at a table
 * with three or more players and no straddle.
 *
 * **Heads-up is excluded on purpose.** `positionRing(2)` is `["SB","BB"]` —
 * there is no button seat at all — and every small-blind raise heads-up is a
 * steal by definition, so the stat measures nothing. **A straddle excludes it
 * too**: with a straddler acting after the blinds, "folded to the cutoff" is
 * not a spot where the remaining players are only the blinds, so the whole
 * premise of the stat is gone. **So does a button blind** (GG's short deck):
 * there is no small and no big blind to steal from, only antes and one blind
 * on the seat that acts last, so "folded to the cutoff" is a different spot
 * with a different price, and pooling it with the Hold'em steal would make
 * neither number mean anything.
 */
function stealPossible(context: StatsContext): boolean {
  return (
    !context.isBombPot &&
    !context.hasStraddle &&
    !context.hasButtonBlind &&
    context.dealtInSeats.length >= 3
  );
}

function isStealAttempt(context: StatsContext, decision: Decision): boolean {
  if (!stealPossible(context)) {
    return false;
  }
  if (decision.street !== "preflop" || decision.type !== "raise") {
    return false;
  }
  if (decision.raisesBefore !== 0 || decision.enteredBefore.length > 0) {
    return false;
  }
  const position = context.position.get(decision.seat);
  return position !== null && position !== undefined && STEAL_POSITIONS.has(position);
}

/** The steal attempt of the hand, if there was one. At most one can exist. */
export function stealAttempt(context: StatsContext): Decision | null {
  for (const decision of context.byStreet.get("preflop") ?? []) {
    if (isStealAttempt(context, decision)) {
      return decision;
    }
  }
  return null;
}

/**
 * Fills in every preflop counter for one seat.
 *
 * Returns without touching anything when the hand is a **bomb pot**: everybody
 * antes, no blind is posted and the deal goes straight to the flop, so there is
 * no preflop betting round for an opportunity to exist in. Counting a bomb pot
 * as a folded-preflop hand would drag VPIP down by the bomb frequency, which is
 * a house setting, not a property of the player.
 */
export function preflopCounters(
  context: StatsContext,
  seat: number,
  counters: SeatCounters,
): void {
  if (context.isBombPot) {
    return;
  }

  const decisions = seatStreet(context, seat, "preflop");

  /*
   * A walk. The big blind never acted, so there was no decision and PT4 gives
   * the seat no VPIP opportunity at all. HM3 instead counts it as a hand the
   * player did not put money in, which pulls big-blind VPIP down by roughly the
   * walk rate and makes a nit and a tight player in a loose game look alike.
   * The hand still counts for bb/100 — the blind is real money.
   *
   * The guard is explicit rather than left to `decisions.length === 0` so that a
   * room which prints a redundant "checks" for the walked big blind does not
   * quietly switch us to HM3's definition.
   */
  if (context.isWalk && seat === context.bigBlindSeat) {
    return;
  }
  if (decisions.length === 0) {
    return;
  }

  const first = decisions[0];

  counters.vpip_opp = 1;
  counters.pfr_opp = 1;
  for (const decision of decisions) {
    if (decision.type === "call" || decision.type === "bet" || decision.type === "raise") {
      counters.vpip = 1;
    }
    if (decision.type === "raise") {
      counters.pfr = 1;
    }
  }

  /* ------------------------------------------------- the unopened spectrum - */

  const unopened = first.raisesBefore === 0 && first.enteredBefore.length === 0;
  const limpersIn = first.raisesBefore === 0 && first.enteredBefore.length > 0;

  if (unopened) {
    // Raise first in. PT4 requires folded-to; a raise over limpers is an
    // isolation raise and is counted below instead. Conflating the two inflates
    // apparent open-raise frequency by the isolation rate, which at a loose
    // table is most of the number.
    counters.rfi_opp = 1;
    if (first.type === "raise") {
      counters.rfi = 1;
    }
  }
  if (limpersIn) {
    counters.iso_opp = 1;
    if (first.type === "raise") {
      counters.iso = 1;
    }
  }
  if (first.raisesBefore === 0 && first.type !== "check") {
    // You cannot limp from a seat that can check: the big blind in an unraised,
    // unstraddled pot is already in for the full amount.
    counters.limp_opp = 1;
    if (first.type === "call") {
      counters.limp = 1;
    }
  }

  /* -------------------------------------------------------- steal attempts - */

  if (unopened && stealPossible(context)) {
    const position = context.position.get(seat);
    if (position && STEAL_POSITIONS.has(position)) {
      counters.steal_opp = 1;
      if (first.type === "raise") {
        counters.steal = 1;
      }
    }
  }

  const steal = stealAttempt(context);
  if (steal && steal.seat !== seat && context.blindSeats.has(seat)) {
    // Defending a steal: the first decision after the attempt, with nobody
    // having re-raised in between — a 3-bet in front of you makes the spot a
    // fold-to-3bet, not a fold-to-steal.
    const facing = decisions.find(
      (decision) => decision.order > steal.order && decision.raisesBefore === 1,
    );
    if (facing && facing === decisions[0]) {
      counters.fold_to_steal_opp = 1;
      leg(counters, facing, "fold_to_steal", "call_steal", "three_bet_vs_steal");
    }
  }

  /* ----------------------------------------------------------- raise levels - */

  if (!context.blindSeats.has(seat) && first.raisesBefore >= 1) {
    // Cold call: no money in voluntarily, not in a blind or straddle seat. A
    // blind that calls a raise is defending, which is a different decision with
    // a different price and belongs in its own stat.
    counters.cold_call_opp = 1;
    if (first.type === "call") {
      counters.cold_call = 1;
    }
  }

  const atLevel = (level: number): Decision | null =>
    decisions.find((decision) => decision.raisesBefore === level) ?? null;

  const facingOpen = atLevel(1);
  if (facingOpen) {
    counters.three_bet_opp = 1;
    if (facingOpen.type === "raise") {
      counters.three_bet = 1;
    }
    if (facingOpen.callersSinceAggression >= 1) {
      // A squeeze is a raise over an open *and* at least one cold caller: the
      // dead money in the middle is the whole reason the play exists.
      counters.squeeze_opp = 1;
      if (facingOpen.type === "raise") {
        counters.squeeze = 1;
      }
    }
  }

  const facingThreeBet = atLevel(2);
  if (facingThreeBet) {
    counters.four_bet_opp = 1;
    if (facingThreeBet.type === "raise") {
      counters.four_bet = 1;
    }
  }

  const facingFourBet = atLevel(3);
  if (facingFourBet) {
    counters.five_bet_opp = 1;
    if (facingFourBet.type === "raise") {
      counters.five_bet = 1;
    }
  }

  /* ------------------------------------------- responses to a re-raise of me - */

  const opened = decisions.some(
    (decision) => decision.type === "raise" && decision.raisesBefore === 0,
  );
  if (opened && facingThreeBet) {
    // This seat's own raise was the open, and it is now facing a 3-bet with a
    // decision to make. If the open was all-in there is no decision and no
    // opportunity — rule 4.
    counters.fold_to_three_bet_opp = 1;
    leg(
      counters,
      facingThreeBet,
      "fold_to_three_bet",
      "call_three_bet",
      "raise_vs_three_bet",
    );
  }

  const threeBet = decisions.some(
    (decision) => decision.type === "raise" && decision.raisesBefore === 1,
  );
  if (threeBet && facingFourBet) {
    counters.fold_to_four_bet_opp = 1;
    leg(counters, facingFourBet, "fold_to_four_bet", "call_four_bet", "raise_vs_four_bet");
  }
}
