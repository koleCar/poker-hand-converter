/**
 * Money, per seat, in PHF minor units.
 *
 * The one identity this file exists to keep true, over all 413 corpus files:
 *
 * ```
 * Σ net  ===  houseIntoPot(hand) - totalFees(hand.results.fees)
 * ```
 *
 * Read it as: the players collectively win exactly what the house dropped in
 * and lose exactly what the house took out. Everything else is a transfer
 * between seats and cancels. It needs no known-good reference, it is one line
 * to assert, and it catches nearly every money bug — a lost uncalled return, a
 * double-counted side pot, a collect attributed to the wrong seat, a promotional
 * drop silently dropped.
 *
 * Three things sit deliberately outside `net`:
 *
 * - **Chips that never reached the pot** (`out_of_pot`) — MicroGaming's bad-beat
 *   drop leaves a stack and goes to the house. Real money, but adding it to
 *   `net` would break the identity above, so it gets its own column and the
 *   documented "off the table" figure is `net - out_of_pot`.
 * - **EV cashout** (`cashout_risk`). The player sold their equity, so
 *   `won - contributed` is not what happened to them. The hand is flagged and
 *   excluded from money series by default; see `rates.ts`.
 * - **The tournament buy-in.** It is real money in a different currency from the
 *   chips, and mixing the two is how a chip graph becomes nonsense.
 *
 * **Run it twice needs no special case.** `won` sums the collects across every
 * runout, so realized bb/100 is already exact — which is the whole point of PHF
 * design rule 3.
 */

import type { Amount, PhfHand } from "../phf/types";
import type { StatsContext } from "./context";
import { outOfPot } from "./context";
import type { SeatMoney } from "./types";
import { emptyMoney } from "./types";

/**
 * Rounds away from zero, symmetrically.
 *
 * `Math.round` breaks ties upward, so -0.5 becomes -0 and +0.5 becomes 1: a
 * loss and a win of the same size would round differently and a symmetric
 * sample would drift. bb/100 is quoted to two decimal places over hundreds of
 * thousands of hands, so the drift is visible.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** `amount` in thousandths of a big blind, or 0 when the blind is unknown. */
export function toBbMilli(amount: Amount, bigBlind: Amount): number {
  if (!bigBlind) {
    return 0;
  }
  return roundHalfAwayFromZero((amount * 1000) / bigBlind);
}

/**
 * Splits `total` across `weights` so the parts are proportional and sum to
 * `total` **exactly**.
 *
 * Largest remainder: floor every share, then hand the leftover units out to the
 * largest fractional parts, breaking ties by index so the result is
 * deterministic. Rounding each share independently would leave the rake short
 * or over by a cent per hand, which over a corpus is a visible number and an
 * unassertable one.
 */
export function largestRemainder(total: Amount, weights: Amount[]): Amount[] {
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (total === 0 || sum <= 0) {
    return weights.map(() => 0);
  }
  const exact = weights.map((weight) => (Math.max(0, weight) * total) / sum);
  const shares = exact.map((value) => Math.floor(value));
  let left = total - shares.reduce((acc, share) => acc + share, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; left > 0 && i < order.length; i += 1) {
    shares[order[i].index] += 1;
    left -= 1;
  }
  return shares;
}

/**
 * Everything each seat put in, net of uncalled returns.
 *
 * Mirrors `contributionsFromActions` in `phf/types.ts` but keys by seat rather
 * than by player name: two seats at the same table can carry the same display
 * name on an anonymised export, and a stats row is per seat.
 *
 * `collect` is what comes back out, so it is excluded; `cashout-pay` and
 * `cashout-choose` both carry `amount: 0` by construction and settle outside
 * the pot, so they never move this number.
 */
export function contributedBySeat(hand: PhfHand): Map<number, Amount> {
  const out = new Map<number, Amount>();
  for (const action of hand.actions) {
    if (action.seat === null || action.amount === 0) {
      continue;
    }
    if (action.type === "collect" || action.type === "cashout-pay") {
      continue;
    }
    out.set(action.seat, (out.get(action.seat) ?? 0) + action.amount);
  }
  return out;
}

/** Chips each seat collected, across every pot and every runout. */
export function collectedBySeat(hand: PhfHand): Map<number, Amount> {
  const out = new Map<number, Amount>();
  for (const action of hand.actions) {
    if (action.type !== "collect" || action.seat === null) {
      continue;
    }
    out.set(action.seat, (out.get(action.seat) ?? 0) + action.amount);
  }
  return out;
}

/**
 * Whether a hand's `collect` lines are stated **before** the fees came off.
 *
 * Rooms disagree, and the disagreement is worth exactly the rake:
 *
 * - GG and PokerStars write what the winner received — the collects already sum
 *   to `totalPot - fees`.
 * - WePlay and several legacy networks write the gross pot on the collect line
 *   and report the rake only on the `Total pot` line, so the collects sum to
 *   `totalPot`.
 *
 * `potFullyAwarded` in `psggInvariants.ts` accepts both shapes, which is right
 * for a parser — the text says what it says. It is not right for a win rate: a
 * winner whose `won` is gross is credited with money that went to the house, and
 * every WePlay graph would read high by the rake. So the shape is detected here,
 * once, and normalized away.
 *
 * Detection is by arithmetic, not by room: the collects either reconcile
 * against the net pot or against the gross one. When the fees are zero the two
 * are the same and the answer does not matter.
 */
function collectsAreGross(context: StatsContext, collected: Amount): boolean {
  const pot = context.hand.results.totalPot;
  if (context.fees <= 0 || pot <= 0) {
    return false;
  }
  const grossGap = Math.abs(collected - pot);
  const netGap = Math.abs(collected - (pot - context.fees));
  return grossGap < netGap;
}

/** Money for every dealt-in seat, keyed by seat. */
export function moneyBySeat(context: StatsContext): Map<number, SeatMoney> {
  const { hand } = context;
  const contributed = contributedBySeat(hand);
  const collected = collectedBySeat(hand);

  const seats = context.dealtInSeats;
  const awards = seats.map((seat) => collected.get(seat) ?? 0);
  const totalAwarded = awards.reduce((sum, award) => sum + award, 0);
  // The fees came out of the pot, so the seats that took the pot are the seats
  // that paid them, in proportion to what they took.
  const feeShares = largestRemainder(context.fees, awards);
  const gross = collectsAreGross(context, totalAwarded);

  const cashoutRisk = new Map<number, Amount>();
  for (const result of hand.results.players) {
    if (result.cashoutRisk !== null) {
      cashoutRisk.set(result.seat, result.cashoutRisk);
    }
  }

  const out = new Map<number, SeatMoney>();
  seats.forEach((seat, index) => {
    const money = emptyMoney();
    money.rake_paid = feeShares[index];
    money.won = (collected.get(seat) ?? 0) - (gross ? money.rake_paid : 0);
    money.contributed = contributed.get(seat) ?? 0;
    money.net = money.won - money.contributed;
    money.net_bb_milli = toBbMilli(money.net, context.bigBlind);
    money.out_of_pot = outOfPot(context, seat);
    money.cashout_risk = cashoutRisk.get(seat) ?? 0;
    out.set(seat, money);
  });
  return out;
}
