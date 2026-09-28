/**
 * Statistics derivation — the type system.
 *
 * One `PhfHand` in, N flat rows of **integer counters** out, one row per seat
 * that was dealt in. Every number in this file is an integer: a count of
 * opportunities, a count of actions taken, or an amount in PHF minor units.
 * Nothing here is a percentage, a ratio or a float, because the whole point of
 * the split is that SQL only ever has to `sum()` and `group by` — see
 * `docs/STATS-SPEC.md` §1.
 *
 * Design rules the rest of the module assumes:
 *
 * 1. **Every counter is a pair.** A stat is `<name>_opp` (the number of times
 *    the decision point existed) and `<name>` (the number of times the player
 *    took the action). A rate is `<name> / <name>_opp` and is computed in
 *    `rates.ts`, never stored. Storing a rate makes it impossible to combine
 *    two samples, which is the one thing a stats table has to be able to do.
 * 2. **An opportunity is a decision point that actually existed**, never "the
 *    street was reached". If a player was all-in before the flop, they had no
 *    flop decision and therefore no continuation-bet opportunity, even though
 *    the flop was dealt and they were still in the hand. Getting this wrong is
 *    the classic way cbet% comes out low for a short stack.
 * 3. **Leg sets sum exactly.** A player facing a bet can only fold, call or
 *    raise, so `fold_to_X + call_X + raise_X === X_opp` exactly. That identity
 *    is asserted over the whole corpus, and it is what catches a walk that
 *    counts an opportunity and then forgets to record the response.
 * 4. **No floats.** Money is in minor units, exactly as PHF holds it. The one
 *    normalized figure, `net_bb_milli`, is thousandths of a big blind, rounded
 *    once here rather than repeatedly downstream.
 *
 * See `frontend/src/lib/phf/types.ts` for the format this reads, and
 * `docs/STATS-SPEC.md` for the definition of every counter below, including
 * every place PokerTracker 4 and Holdem Manager 3 disagree.
 */

import type {
  Amount,
  GameFormat,
  LimitType,
  Position,
  Street,
  Variant,
} from "../phf/types";

/**
 * Schema tag stamped on every derived row.
 *
 * Bumped whenever a counter changes *meaning* — a new counter is additive and
 * does not need a bump, but redefining `steal_opp` does, because rows derived
 * under the old rule can no longer be summed with rows derived under the new
 * one. The backfill keys off this.
 */
export const STATS_VERSION = "stats/1" as const;
export type StatsVersion = typeof STATS_VERSION;

/* -------------------------------------------------------------- counters - */

/**
 * The integer counters derived for one seat in one hand.
 *
 * Every field is 0 or 1 except the raw postflop action counts (`bet_flop` and
 * friends), which can exceed 1 when a street is raised back and forth. That is
 * deliberate: the aggression factor needs totals, not "did it happen".
 */
export interface SeatCounters {
  /** Always 1. Summed, this is the hand count of the sample. */
  hands: number;

  /* ------------------------------------------------------------- preflop - */

  /**
   * The player had a voluntary preflop decision.
   *
   * 0 for a bomb pot (no preflop betting round exists) and 0 for a **walk** —
   * everyone folds to the big blind, who never acts. That is PT4's rule; HM3
   * counts the walk as a non-VPIP hand, which drags big-blind VPIP down by
   * roughly the walk frequency. See `docs/STATS-SPEC.md` §4.2.
   */
  vpip_opp: number;
  /**
   * The player put money in preflop of their own accord: `call`, `bet` or
   * `raise`. Blinds, antes, straddles and dead posts are **not** voluntary —
   * `isPostingAction()` is the test, and PT4 and HM3 agree here.
   */
  vpip: number;

  /** Same denominator as `vpip_opp`; PFR% and VPIP% are quoted over one sample. */
  pfr_opp: number;
  /** The player made at least one preflop `raise`. A straddle is not a raise. */
  pfr: number;

  /**
   * Raise-first-in opportunity: at the player's **first** preflop decision the
   * pot was unopened — nobody had raised and nobody had limped.
   *
   * PT4 requires folded-to. The limpers case is an isolation raise, counted
   * separately as `iso`; conflating the two inflates apparent open frequency.
   */
  rfi_opp: number;
  rfi: number;

  /** First preflop decision, no raise yet, but at least one limper already in. */
  iso_opp: number;
  /** ...and the player raised. */
  iso: number;

  /** First preflop decision, no raise yet, and there was something to call. */
  limp_opp: number;
  /** ...and the player called rather than raising or folding. */
  limp: number;

  /**
   * First preflop decision facing a raise, with no money voluntarily in yet
   * and not in a blind or straddle seat. A blind calling a raise is defending,
   * not cold-calling.
   */
  cold_call_opp: number;
  cold_call: number;

  /** A decision facing exactly one raise, the player not yet having raised. */
  three_bet_opp: number;
  three_bet: number;

  /** A decision facing two raises. */
  four_bet_opp: number;
  four_bet: number;

  /** A decision facing three raises. */
  five_bet_opp: number;
  five_bet: number;

  /** Facing one raise with at least one cold-caller already behind it. */
  squeeze_opp: number;
  squeeze: number;

  /**
   * Unopened pot, folded to the player in CO / BTN / SB, three-handed or more,
   * and no straddle in the hand.
   *
   * Heads-up is 0 on purpose: `positionRing(2)` is `["SB","BB"]`, there is no
   * button, and every small-blind raise is by definition a steal — the stat
   * carries no information. A straddle moves the last actor off the blinds, so
   * "folded to the cutoff" is no longer a steal spot either.
   */
  steal_opp: number;
  steal: number;

  /** The player was in a blind and faced a steal attempt as their first decision. */
  fold_to_steal_opp: number;
  fold_to_steal: number;
  call_steal: number;
  three_bet_vs_steal: number;

  /** The player opened the pot and then faced a 3-bet with a decision to make. */
  fold_to_three_bet_opp: number;
  fold_to_three_bet: number;
  call_three_bet: number;
  raise_vs_three_bet: number;

  /** The player 3-bet and then faced a 4-bet with a decision to make. */
  fold_to_four_bet_opp: number;
  fold_to_four_bet: number;
  call_four_bet: number;
  raise_vs_four_bet: number;

  /* ------------------------------------------------------------ postflop - */

  /**
   * The street was dealt and the player had not folded before it.
   *
   * "Seen" is not "acted on": a player all-in preflop sees every street. It is
   * the denominator for WWSF and WTSD, and it is *not* an opportunity in the
   * sense of rule 2 — that is exactly the distinction `cbet_flop_opp` makes.
   */
  flop_seen: number;
  turn_seen: number;
  river_seen: number;

  /**
   * The preflop raiser's first flop decision came with no bet in front of it.
   *
   * No preflop raiser (a limped pot) means nobody has a cbet opportunity. A
   * donk bet in front of the raiser removes it too — that spot is `fold_to_donk`
   * territory, not a cbet.
   */
  cbet_flop_opp: number;
  cbet_flop: number;
  /**
   * The flop cbet was **called** — not raised — and the raiser then had a turn
   * decision with no bet in front of it.
   *
   * PT4's definition, and the one that answers "do I barrel". HM3 counts any
   * turn bet by the preflop raiser, which folds the "my cbet got raised and I
   * called" line into the same number.
   */
  cbet_turn_opp: number;
  cbet_turn: number;
  /** As `cbet_turn_opp`, one street on: the turn cbet was called. */
  cbet_river_opp: number;
  cbet_river: number;

  /** The player's first decision on the street was against the cbet, unraised. */
  fold_to_cbet_flop_opp: number;
  fold_to_cbet_flop: number;
  call_cbet_flop: number;
  raise_cbet_flop: number;
  fold_to_cbet_turn_opp: number;
  fold_to_cbet_turn: number;
  call_cbet_turn: number;
  raise_cbet_turn: number;
  fold_to_cbet_river_opp: number;
  fold_to_cbet_river: number;
  call_cbet_river: number;
  raise_cbet_river: number;

  /**
   * Betting into the previous street's aggressor before that aggressor has
   * acted. The opportunity needs the aggressor to still be live and to be
   * behind the player in the order.
   */
  donk_flop_opp: number;
  donk_flop: number;
  donk_turn_opp: number;
  donk_turn: number;
  donk_river_opp: number;
  donk_river: number;

  /** The player checked, somebody bet, and the player got another decision. */
  check_raise_flop_opp: number;
  check_raise_flop: number;
  check_raise_turn_opp: number;
  check_raise_turn: number;
  check_raise_river_opp: number;
  check_raise_river: number;

  /* Raw postflop action counts. The aggression factor's ingredients. */
  bet_flop: number;
  raise_flop: number;
  call_flop: number;
  check_flop: number;
  fold_flop: number;
  bet_turn: number;
  raise_turn: number;
  call_turn: number;
  check_turn: number;
  fold_turn: number;
  bet_river: number;
  raise_river: number;
  call_river: number;
  check_river: number;
  fold_river: number;

  /* ------------------------------------------------------------ showdown - */

  /** Denominator for "won when saw flop"; equal to `flop_seen`. */
  wwsf_opp: number;
  /** The player saw the flop and collected chips from some pot. */
  wwsf: number;

  /** Denominator for "went to showdown"; equal to `flop_seen`. */
  wtsd_opp: number;
  /**
   * Two or more players were still live when the hand ended.
   *
   * Derived structurally from the fold stream rather than read off
   * `results.wentToShowdown`, so it survives the round trip through standard
   * text and cannot disagree between two parsers of the same hand.
   */
  wtsd: number;

  /** Denominator for "won at showdown"; equal to `wtsd`. */
  wsd_opp: number;
  wsd: number;

  /* --------------------------------------------------------------- flags - */

  /** The player's summary carried a GG EV-cashout. Money series must exclude these. */
  cashed_out: number;
}

/** Money for one seat in one hand, in PHF minor units unless stated. */
export interface SeatMoney {
  /**
   * Chips that actually landed in the stack, from every pot and every runout,
   * **after** the fees taken out of that pot.
   *
   * Rooms disagree about what their own collect line means: most write the
   * amount the winner received, but several — WePlay among them — write the
   * gross pot and report the rake separately, so the two shapes differ by
   * exactly the fees. `moneyBySeat` normalizes them, because a `won` that means
   * one thing at one room and another at the next makes every win rate a
   * per-room artifact. See `docs/STATS-SPEC.md` §7.1.
   */
  won: Amount;
  /**
   * Chips put in, net of uncalled returns — exactly the sum of the action
   * stream for this seat, which is what makes `net` add up across the table.
   *
   * Under a **big-blind ante** one seat posts the whole table's ante, so this
   * is inflated for that seat by the other players' antes. It is real money and
   * it stays here; a report filtered to "big blind only" is therefore
   * misleading, and that is documented rather than fixed. See §7.2.
   */
  contributed: Amount;
  /** `won - contributed`. The player's result in this hand. */
  net: Amount;
  /**
   * `net` in thousandths of a big blind, so samples at different stakes can be
   * summed. bb/100 is `sum(net_bb_milli) / 10 / hands`.
   */
  net_bb_milli: number;
  /**
   * The fees this seat bore: rake, jackpot, bingo, fortune and tax.
   *
   * Attributed to the **winners**, split in proportion to what each collected
   * and distributed by largest remainder so the shares sum to the hand's fee
   * total exactly. That is not an estimate — the fees come out of the pot as it
   * is pushed, so the seat that took the pot is the seat that paid them. The
   * alternative, splitting by contribution, is a modelling choice that no room
   * reports and that cannot be checked against anything.
   */
  rake_paid: Amount;
  /**
   * Chips that left this stack without ever reaching the pot — MicroGaming's
   * bad-beat drop. Deliberately **not** in `net`: including it would break the
   * table-wide money identity, which is the invariant that keeps the engine
   * honest. A true "chips off the table" figure is `net - out_of_pot`.
   */
  out_of_pot: Amount;
  /** GG EV-cashout risk the seat paid, settled outside the pot. */
  cashout_risk: Amount;
}

/* ----------------------------------------------------------------- facts - */

/** What a seat was, as opposed to what it did. */
export interface SeatIdentity {
  seat: number;
  player: string;
  isHero: boolean;
  /** `null` heads-up for the button seat, and for any seat with no known button. */
  position: Position | null;
  /** Hole cards when known; length is variant dependent. */
  holeCards: string[];
  /** `"AKs"` / `"77"`, or null for anything that is not exactly two cards. */
  handClass: string | null;
  startingStack: Amount;
  /** Starting stack in big blinds times 10, so "95.4bb" stays an integer. */
  startingStackBbTenths: number;
}

export interface SeatFacts extends SeatIdentity {
  counters: SeatCounters;
  money: SeatMoney;
}

/**
 * Hand-level facts every row carries, so a filter never has to join back to the
 * hand document.
 */
export interface HandDimensions {
  statsVersion: StatsVersion;
  handKey: string;
  siteId: string;
  handId: string;
  playedAt: string | null;
  variant: Variant;
  limit: LimitType;
  format: GameFormat;
  currency: string;
  currencyMinorUnits: number;
  smallBlind: Amount;
  bigBlind: Amount;
  /** Number of seats dealt in. Drives `steal_opp` and every position rate. */
  playerCount: number;
  maxSeats: number;
  tableName: string | null;
  tournamentId: string | null;
  /** Fast-fold brand (`Zoom`, `Rush & Cash`, ...) or null. */
  fastFold: string | null;

  /* Exclusion flags. See `defaultExclusions` in `rates.ts`. */

  /**
   * Somebody straddled. Derived from `actions`, never from `game.straddles` —
   * only two of nineteen parsers populate that field, so the rest would
   * silently report "no straddle".
   */
  hasStraddle: boolean;
  /** No blinds, everyone antes, dealt straight to the flop. Every preflop opportunity is 0. */
  isBombPot: boolean;
  /** One seat posted the ante for the whole table. Inflates that seat's `contributed`. */
  isBigBlindAnte: boolean;
  /** More than one runout. Needs no special case: `net` already sums the collects. */
  isRunItTwice: boolean;
  /** Some seat took a GG EV cashout, so `won - contributed` is not its real result. */
  hasCashout: boolean;
  /** Everyone folded to the big blind, who never acted. */
  isWalk: boolean;
  /** Furthest street the hand reached. */
  streetReached: Street;
  /** Chips the house dropped into the pot (GG cash drop, Run It Once STP). */
  houseIntoPot: Amount;
  /** Everything taken out of the pot: rake, jackpot, bingo, fortune, tax, other. */
  fees: Amount;
  totalPot: Amount;
}

export interface HandFacts {
  hand: HandDimensions;
  seats: SeatFacts[];
}

/* ----------------------------------------------------- the zero row + keys - */

/** Every counter at zero. The single definition of the counter set. */
export const ZERO_COUNTERS: SeatCounters = {
  hands: 0,

  vpip_opp: 0,
  vpip: 0,
  pfr_opp: 0,
  pfr: 0,
  rfi_opp: 0,
  rfi: 0,
  iso_opp: 0,
  iso: 0,
  limp_opp: 0,
  limp: 0,
  cold_call_opp: 0,
  cold_call: 0,
  three_bet_opp: 0,
  three_bet: 0,
  four_bet_opp: 0,
  four_bet: 0,
  five_bet_opp: 0,
  five_bet: 0,
  squeeze_opp: 0,
  squeeze: 0,
  steal_opp: 0,
  steal: 0,
  fold_to_steal_opp: 0,
  fold_to_steal: 0,
  call_steal: 0,
  three_bet_vs_steal: 0,
  fold_to_three_bet_opp: 0,
  fold_to_three_bet: 0,
  call_three_bet: 0,
  raise_vs_three_bet: 0,
  fold_to_four_bet_opp: 0,
  fold_to_four_bet: 0,
  call_four_bet: 0,
  raise_vs_four_bet: 0,

  flop_seen: 0,
  turn_seen: 0,
  river_seen: 0,
  cbet_flop_opp: 0,
  cbet_flop: 0,
  cbet_turn_opp: 0,
  cbet_turn: 0,
  cbet_river_opp: 0,
  cbet_river: 0,
  fold_to_cbet_flop_opp: 0,
  fold_to_cbet_flop: 0,
  call_cbet_flop: 0,
  raise_cbet_flop: 0,
  fold_to_cbet_turn_opp: 0,
  fold_to_cbet_turn: 0,
  call_cbet_turn: 0,
  raise_cbet_turn: 0,
  fold_to_cbet_river_opp: 0,
  fold_to_cbet_river: 0,
  call_cbet_river: 0,
  raise_cbet_river: 0,
  donk_flop_opp: 0,
  donk_flop: 0,
  donk_turn_opp: 0,
  donk_turn: 0,
  donk_river_opp: 0,
  donk_river: 0,
  check_raise_flop_opp: 0,
  check_raise_flop: 0,
  check_raise_turn_opp: 0,
  check_raise_turn: 0,
  check_raise_river_opp: 0,
  check_raise_river: 0,

  bet_flop: 0,
  raise_flop: 0,
  call_flop: 0,
  check_flop: 0,
  fold_flop: 0,
  bet_turn: 0,
  raise_turn: 0,
  call_turn: 0,
  check_turn: 0,
  fold_turn: 0,
  bet_river: 0,
  raise_river: 0,
  call_river: 0,
  check_river: 0,
  fold_river: 0,

  wwsf_opp: 0,
  wwsf: 0,
  wtsd_opp: 0,
  wtsd: 0,
  wsd_opp: 0,
  wsd: 0,

  cashed_out: 0,
};

export const ZERO_MONEY: SeatMoney = {
  won: 0,
  contributed: 0,
  net: 0,
  net_bb_milli: 0,
  rake_paid: 0,
  out_of_pot: 0,
  cashout_risk: 0,
};

export type CounterKey = keyof SeatCounters;
export type MoneyKey = keyof SeatMoney;

/** Counter names, in declaration order. The checked-in column list keys off this. */
export const COUNTER_KEYS = Object.keys(ZERO_COUNTERS) as CounterKey[];
export const MONEY_KEYS = Object.keys(ZERO_MONEY) as MoneyKey[];

/** A fresh, independent zero row. Never hand out `ZERO_COUNTERS` itself. */
export function emptyCounters(): SeatCounters {
  return { ...ZERO_COUNTERS };
}

export function emptyMoney(): SeatMoney {
  return { ...ZERO_MONEY };
}

/* ------------------------------------------------- the structural rulebook - */

/**
 * `made` can never exceed `opp`. Asserted over the whole corpus.
 *
 * Every pair in the module is listed explicitly rather than inferred from the
 * `_opp` suffix, because inference would silently stop checking a counter whose
 * name later stopped matching the pattern.
 */
export const OPPORTUNITY_PAIRS: Array<[CounterKey, CounterKey]> = [
  ["vpip_opp", "vpip"],
  ["pfr_opp", "pfr"],
  ["rfi_opp", "rfi"],
  ["iso_opp", "iso"],
  ["limp_opp", "limp"],
  ["cold_call_opp", "cold_call"],
  ["three_bet_opp", "three_bet"],
  ["four_bet_opp", "four_bet"],
  ["five_bet_opp", "five_bet"],
  ["squeeze_opp", "squeeze"],
  ["steal_opp", "steal"],
  ["cbet_flop_opp", "cbet_flop"],
  ["cbet_turn_opp", "cbet_turn"],
  ["cbet_river_opp", "cbet_river"],
  ["donk_flop_opp", "donk_flop"],
  ["donk_turn_opp", "donk_turn"],
  ["donk_river_opp", "donk_river"],
  ["check_raise_flop_opp", "check_raise_flop"],
  ["check_raise_turn_opp", "check_raise_turn"],
  ["check_raise_river_opp", "check_raise_river"],
  ["wwsf_opp", "wwsf"],
  ["wtsd_opp", "wtsd"],
  ["wsd_opp", "wsd"],
];

/**
 * Leg sets that sum to their opportunity **exactly**.
 *
 * Facing a bet, there are three legal replies and no fourth, so any drift here
 * means a decision walk lost an action or counted a spot that did not exist.
 */
export const LEG_SETS: Array<{ opp: CounterKey; legs: CounterKey[] }> = [
  {
    opp: "fold_to_steal_opp",
    legs: ["fold_to_steal", "call_steal", "three_bet_vs_steal"],
  },
  {
    opp: "fold_to_three_bet_opp",
    legs: ["fold_to_three_bet", "call_three_bet", "raise_vs_three_bet"],
  },
  {
    opp: "fold_to_four_bet_opp",
    legs: ["fold_to_four_bet", "call_four_bet", "raise_vs_four_bet"],
  },
  {
    opp: "fold_to_cbet_flop_opp",
    legs: ["fold_to_cbet_flop", "call_cbet_flop", "raise_cbet_flop"],
  },
  {
    opp: "fold_to_cbet_turn_opp",
    legs: ["fold_to_cbet_turn", "call_cbet_turn", "raise_cbet_turn"],
  },
  {
    opp: "fold_to_cbet_river_opp",
    legs: ["fold_to_cbet_river", "call_cbet_river", "raise_cbet_river"],
  },
];

/**
 * Counters that are monotone down the streets: you cannot see the river without
 * having seen the turn.
 */
export const STREET_CHAINS: CounterKey[][] = [
  ["hands", "flop_seen", "turn_seen", "river_seen"],
  ["flop_seen", "wtsd", "wsd"],
  ["vpip_opp", "vpip", "pfr"],
];
