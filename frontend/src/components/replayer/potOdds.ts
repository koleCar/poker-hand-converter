/**
 * The price of the spot on screen, from hero's chair.
 *
 * Two situations, read straight off the frames:
 *
 * - **facing** — somebody has put in more than hero this street and hero still
 *   has a decision: what the call costs, what it wins, and the equity it needs.
 * - **betting** — hero's bet or raise is the one standing: what it risked, the
 *   price it lays the best-placed caller, and how often a bluff has to work.
 *
 * Amounts are in display units like the frames themselves, so the caller
 * formats them with the replayer's amount formatter.
 */

import type { ReplayFrame, SeatFrameState } from "../../lib/replay";

export interface FacingOdds {
  kind: "facing";
  /** What hero has to put in — capped at hero's stack. */
  toCall: number;
  /** Everything in the middle hero can win by calling, bets included. */
  pot: number;
  /** `toCall / (pot + toCall)`. */
  equity: number;
}

export interface BettingOdds {
  kind: "betting";
  /** Hero's total in front this street. */
  bet: number;
  /** True when hero's bet went in over somebody else's. */
  raise: boolean;
  /** The pot hero bet into: swept chips plus everyone else's bets. */
  potBefore: number;
  /** Chips hero added with the action, for the bluff break-even. */
  risk: number;
  /** Equity the cheapest caller needs, or null when nobody can call. */
  callerEquity: number | null;
  /** Fold rate a pure bluff needs to break even: `risk / (potBefore + risk)`. */
  foldEquity: number;
}

export type PotOdds = FacingOdds | BettingOdds;

/** Rounding slack for bets that are floats in display units. */
const EPSILON = 1e-9;

function live(seat: SeatFrameState): boolean {
  return !seat.folded && seat.hasCards;
}

/**
 * Preflop, the big blind is a bet nobody chose: limping in, or calling it from
 * the small blind, is not "facing a bet" in the sense the box is for.
 */
function blindOnly(frame: ReplayFrame, amountBb: number): boolean {
  return frame.street === "preflop" && amountBb <= 1 + EPSILON;
}

function facing(frame: ReplayFrame, hero: SeatFrameState): FacingOdds | null {
  if (hero.allIn || hero.stack <= EPSILON || frame.actingSeat === hero.seatNo) {
    return null;
  }
  const top = frame.seats.reduce<SeatFrameState | null>(
    (best, seat) => (seat !== hero && live(seat) && seat.bet > (best?.bet ?? 0) ? seat : best),
    null,
  );
  if (!top || top.bet <= hero.bet + EPSILON || blindOnly(frame, top.betBb)) {
    return null;
  }
  const owed = top.bet - hero.bet;
  const toCall = Math.min(owed, hero.stack);
  // A short call only wins what it matches; the rest of the bet goes back.
  const pot = frame.potWithBets - (owed - toCall);
  return { kind: "facing", toCall, pot, equity: toCall / (pot + toCall) };
}

function betting(frames: ReplayFrame[], index: number, hero: SeatFrameState): BettingOdds | null {
  const frame = frames[index];
  const others = frame.seats.filter((seat) => seat !== hero && live(seat));
  const topOther = Math.max(0, ...others.map((seat) => seat.bet));
  if (hero.bet <= topOther + EPSILON || blindOnly(frame, hero.betBb)) {
    return null;
  }

  // Walk back to the frame hero's bet went in on, without leaving the street.
  let at = index;
  while (at > 0) {
    const before = frames[at - 1].seats.find((seat) => seat.seatNo === hero.seatNo);
    if (frames[at - 1].street !== frame.street || !before || before.bet !== hero.bet) {
      break;
    }
    at -= 1;
  }
  const previous = at > 0 && frames[at - 1].street === frame.street ? frames[at - 1] : null;
  const priorBet = previous?.seats.find((seat) => seat.seatNo === hero.seatNo)?.bet ?? 0;
  const risk = hero.bet - priorBet;
  if (risk <= EPSILON || frames[at].kind === "post") {
    return null;
  }

  // The best price on offer goes to whoever already has the most in.
  const callers = others
    .filter((seat) => !seat.allIn && seat.stack > EPSILON)
    .map((seat) => {
      const owed = hero.bet - seat.bet;
      const call = Math.min(owed, seat.stack);
      const pot = frame.potWithBets - (owed - call);
      return call / (pot + call);
    });

  const potBefore = frame.potWithBets - risk;
  return {
    kind: "betting",
    bet: hero.bet,
    raise: topOther > EPSILON,
    potBefore,
    risk,
    callerEquity: callers.length > 0 ? Math.min(...callers) : null,
    foldEquity: risk / frame.potWithBets,
  };
}

/** Hero's pot odds at `index`, or null when hero is neither facing nor making a bet. */
export function potOddsAt(frames: ReplayFrame[], index: number): PotOdds | null {
  const frame = frames[index];
  if (!frame || frame.kind === "showdown" || frame.kind === "award") {
    return null;
  }
  const hero = frame.seats.find((seat) => seat.isHero);
  if (!hero || !live(hero)) {
    return null;
  }
  return facing(frame, hero) ?? betting(frames, index, hero);
}
