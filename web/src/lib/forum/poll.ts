/**
 * The pure half of polls: which of the hero's actions a poll can stop at, and
 * which answers make sense there. Shared by the composer (to offer them) and
 * the tests; the server re-checks both in `create_poll_post`.
 */

import type { PhfAction, PhfHand } from "../phf/types";
import type { PollChoice } from "./types";

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);

export interface PollSpot {
  action: PhfAction;
  /** What the hero faced: a bet to call, or an open action. */
  facingBet: boolean;
  /** The answers that fit the spot, always including what the hero did. */
  options: PollChoice[];
  /** What the hero actually did, in poll terms. */
  did: PollChoice;
}

/**
 * Every hero decision in the hand, in order. A decision is facing a bet when
 * somebody's street total is above the hero's own at that moment.
 */
export function pollSpots(hand: PhfHand): PollSpot[] {
  const hero = hand.players.find((player) => player.isHero);
  if (!hero) {
    return [];
  }
  const spots: PollSpot[] = [];
  const totals = new Map<number, number>();
  let street = "";
  for (const action of hand.actions) {
    if (action.street !== street) {
      street = action.street;
      totals.clear();
    }
    if (action.seat === hero.seat && DECISIONS.has(action.type)) {
      const mine = totals.get(hero.seat) ?? 0;
      const facingBet = [...totals.values()].some((total) => total > mine);
      const did: PollChoice = action.allIn && action.type !== "fold" && action.type !== "check" ? "allin" : (action.type as PollChoice);
      const base: PollChoice[] = facingBet ? ["fold", "call", "raise"] : ["check", "bet"];
      const options = base.includes(did) ? base : [...base, did];
      spots.push({ action, facingBet, options, did });
    }
    if (action.seat !== null && action.amount > 0) {
      totals.set(action.seat, action.streetTotal);
    }
  }
  return spots;
}

/** "Flop, facing a bet: you called" — the label a composer shows for a spot. */
export const CHOICE_LABEL: Record<PollChoice, string> = {
  fold: "Fold",
  check: "Check",
  call: "Call",
  bet: "Bet",
  raise: "Raise",
  allin: "All-in",
};
