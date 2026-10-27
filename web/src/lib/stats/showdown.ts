/**
 * Showdown counters: WWSF, WTSD and W$SD.
 *
 * All three are quoted over `flop_seen`, which is why they live next to each
 * other: the questions are "of the flops I saw, how often did I win the pot",
 * "...how often did I reach a showdown" and "of the showdowns I reached, how
 * often did I win". A mismatch between the three denominators is the classic
 * way a stats page shows WTSD above 100%.
 *
 * **Reaching a showdown is derived from folds, not read off `results`.**
 * `PhfResults.wentToShowdown` and `PhfPlayerResult.wentToShowdown` are
 * denormalized copies that each parser fills in from its own room's summary
 * prose; two parsers reading the same hand can disagree, and the round-trip
 * through standard text does not have to preserve them. The structural fact —
 * *two or more players never folded* — is true of the action stream alone, is
 * identical for every parser, and survives serialization. It is also simply
 * what a showdown is.
 */

import type { StatsContext } from "./context";
import type { SeatCounters, SeatMoney } from "./types";

/**
 * Fills in the showdown counters for one seat.
 *
 * `money` is already computed, because "won" here means *collected chips from a
 * pot*, not "finished the hand ahead". A player who calls a river bet, wins the
 * main pot and loses the side pot still won at showdown; a player whose net is
 * positive only because an uncalled bet came back did not win anything at all.
 * Hi/lo reads the same way: a quarter of the low half is chips collected from
 * a pot, so it counts, even when it leaves the player behind for the hand.
 */
export function showdownCounters(
  context: StatsContext,
  seat: number,
  counters: SeatCounters,
  money: SeatMoney,
): void {
  if (counters.flop_seen !== 1) {
    return;
  }

  counters.wwsf_opp = 1;
  if (money.won > 0) {
    counters.wwsf = 1;
  }

  counters.wtsd_opp = 1;

  // Two or more players never folded, and this seat is one of them. Everyone
  // else folding leaves one player, which is a pot won without a showdown.
  const showdown = context.liveSeats.length >= 2 && context.liveSeats.includes(seat);
  if (!showdown) {
    return;
  }

  counters.wtsd = 1;
  counters.wsd_opp = 1;
  if (money.won > 0) {
    counters.wsd = 1;
  }
}
