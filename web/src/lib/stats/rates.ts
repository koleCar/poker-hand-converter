/**
 * Summing rows, and turning sums into the numbers a player recognises.
 *
 * This is the only file in the module that produces a non-integer, and it never
 * stores one. A rate is `made / opp` computed at read time; stored rates cannot
 * be combined, which defeats the entire point of keeping per-hand counters.
 *
 * `aggregate` is also the one place the default exclusions live, because a
 * default that each caller re-implements is a default that will differ between
 * the dashboard and the backfill:
 *
 * - **Bomb pots are excluded from everything.** Every preflop opportunity in a
 *   bomb pot is 0 by construction, so including them would dilute nothing but
 *   `hands`, which is the denominator of bb/100 — a house setting would move a
 *   player's win rate.
 * - **EV cashout hands are excluded from the money series only.** The player
 *   sold their equity mid-hand, so `won - contributed` is not their result. The
 *   counters are still perfectly good and are kept.
 *
 * A third exclusion is offered but not default: **straddled hands**. Their
 * preflop counters are honest under the "straddle is a blind" rule, but the
 * positions mean something different when a player behind the blinds has a live
 * blind of their own, so a position report over a mixed sample is muddy.
 * `has_straddle` is on every row precisely so they can be dropped wholesale.
 */

import type { StatsRow } from "./mapping";
import type { SeatCounters, SeatMoney } from "./types";
import { COUNTER_KEYS, MONEY_KEYS, emptyCounters, emptyMoney } from "./types";

export interface AggregateOptions {
  /** Include bomb pots. Default false; see the file header. */
  bombPots?: boolean;
  /** Include EV-cashout hands in the money series. Default false. */
  cashouts?: boolean;
  /** Include straddled hands. Default true. */
  straddled?: boolean;
}

export interface StatsTotals {
  counters: SeatCounters;
  money: SeatMoney;
  /**
   * Hands whose money was counted. Lower than `counters.hands` whenever the
   * sample contains EV cashouts, which is why bb/100 must divide by this and
   * not by the hand count.
   */
  moneyHands: number;
}

/** Sums rows into one set of totals, applying the default exclusions. */
export function aggregate(rows: StatsRow[], options: AggregateOptions = {}): StatsTotals {
  const bombPots = options.bombPots ?? false;
  const cashouts = options.cashouts ?? false;
  const straddled = options.straddled ?? true;

  const counters = emptyCounters();
  const money = emptyMoney();
  let moneyHands = 0;

  for (const row of rows) {
    if (!bombPots && row.is_bomb_pot) {
      continue;
    }
    if (!straddled && row.has_straddle) {
      continue;
    }
    for (const key of COUNTER_KEYS) {
      counters[key] += row[key];
    }
    if (!cashouts && row.has_cashout) {
      continue;
    }
    for (const key of MONEY_KEYS) {
      money[key] += row[key];
    }
    moneyHands += row.hands;
  }

  return { counters, money, moneyHands };
}

/** `made / opp` as a percentage, or null when the sample has no opportunities. */
export function pct(made: number, opp: number): number | null {
  return opp > 0 ? (made * 100) / opp : null;
}

/**
 * The rates a player reads.
 *
 * Every one is null rather than 0 when its denominator is empty. A 0% cbet over
 * zero opportunities and a 0% cbet over four hundred are different claims, and a
 * UI that cannot tell them apart will show the first one as a leak.
 */
export interface StatsRates {
  hands: number;
  moneyHands: number;

  vpip: number | null;
  pfr: number | null;
  rfi: number | null;
  iso: number | null;
  limp: number | null;
  coldCall: number | null;
  threeBet: number | null;
  fourBet: number | null;
  fiveBet: number | null;
  squeeze: number | null;
  steal: number | null;
  foldToSteal: number | null;
  foldToThreeBet: number | null;
  foldToFourBet: number | null;

  sawFlop: number | null;
  cbetFlop: number | null;
  cbetTurn: number | null;
  cbetRiver: number | null;
  foldToCbetFlop: number | null;
  foldToCbetTurn: number | null;
  foldToCbetRiver: number | null;
  donkFlop: number | null;
  checkRaiseFlop: number | null;

  wwsf: number | null;
  wtsd: number | null;
  wsd: number | null;

  /** (bets + raises) / calls, postflop. Null when the player never called. */
  aggressionFactor: number | null;
  /** (bets + raises) / (bets + raises + calls + folds), postflop, as a percentage. */
  aggressionFrequency: number | null;

  /** Big blinds won per 100 hands. Null when no hand carried a big blind. */
  bb100: number | null;
  /** Total result in big blinds. */
  netBb: number;
  /** Total result in minor units. */
  net: number;
}

export function rates(totals: StatsTotals): StatsRates {
  const c = totals.counters;
  const bets = c.bet_flop + c.bet_turn + c.bet_river;
  const raises = c.raise_flop + c.raise_turn + c.raise_river;
  const calls = c.call_flop + c.call_turn + c.call_river;
  const folds = c.fold_flop + c.fold_turn + c.fold_river;
  const aggressive = bets + raises;
  const decisions = aggressive + calls + folds;

  return {
    hands: c.hands,
    moneyHands: totals.moneyHands,

    vpip: pct(c.vpip, c.vpip_opp),
    pfr: pct(c.pfr, c.pfr_opp),
    rfi: pct(c.rfi, c.rfi_opp),
    iso: pct(c.iso, c.iso_opp),
    limp: pct(c.limp, c.limp_opp),
    coldCall: pct(c.cold_call, c.cold_call_opp),
    threeBet: pct(c.three_bet, c.three_bet_opp),
    fourBet: pct(c.four_bet, c.four_bet_opp),
    fiveBet: pct(c.five_bet, c.five_bet_opp),
    squeeze: pct(c.squeeze, c.squeeze_opp),
    steal: pct(c.steal, c.steal_opp),
    foldToSteal: pct(c.fold_to_steal, c.fold_to_steal_opp),
    foldToThreeBet: pct(c.fold_to_three_bet, c.fold_to_three_bet_opp),
    foldToFourBet: pct(c.fold_to_four_bet, c.fold_to_four_bet_opp),

    sawFlop: pct(c.flop_seen, c.hands),
    cbetFlop: pct(c.cbet_flop, c.cbet_flop_opp),
    cbetTurn: pct(c.cbet_turn, c.cbet_turn_opp),
    cbetRiver: pct(c.cbet_river, c.cbet_river_opp),
    foldToCbetFlop: pct(c.fold_to_cbet_flop, c.fold_to_cbet_flop_opp),
    foldToCbetTurn: pct(c.fold_to_cbet_turn, c.fold_to_cbet_turn_opp),
    foldToCbetRiver: pct(c.fold_to_cbet_river, c.fold_to_cbet_river_opp),
    donkFlop: pct(c.donk_flop, c.donk_flop_opp),
    checkRaiseFlop: pct(c.check_raise_flop, c.check_raise_flop_opp),

    wwsf: pct(c.wwsf, c.wwsf_opp),
    wtsd: pct(c.wtsd, c.wtsd_opp),
    wsd: pct(c.wsd, c.wsd_opp),

    aggressionFactor: calls > 0 ? aggressive / calls : null,
    aggressionFrequency: pct(aggressive, decisions),

    bb100: totals.moneyHands > 0 ? (totals.money.net_bb_milli / 1000 / totals.moneyHands) * 100 : null,
    netBb: totals.money.net_bb_milli / 1000,
    net: totals.money.net,
  };
}

/** Sums a `SeatMoney` and `SeatCounters` pair straight from facts, for tests. */
export function addCounters(into: SeatCounters, from: SeatCounters): void {
  for (const key of COUNTER_KEYS) {
    into[key] += from[key];
  }
}

export function addMoney(into: SeatMoney, from: SeatMoney): void {
  for (const key of MONEY_KEYS) {
    into[key] += from[key];
  }
}
