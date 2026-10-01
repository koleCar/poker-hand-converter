/**
 * `HandFacts` → the flat, snake_case rows a database stores.
 *
 * This file is the single definition of "what a stats row is". M0 ships no
 * schema — that is #43 — but the row shape is fixed here and checked against a
 * literal column list, so the migration that follows is a transcription rather
 * than a design, and so a counter added to `types.ts` without a matching column
 * fails a test instead of silently never being persisted.
 *
 * Everything is flat and integer. There is no nesting, no array of counters and
 * no jsonb: the whole point of deriving in TypeScript is that SQL never has to
 * do more than `sum()` and `group by`, and that only works if every counter is
 * its own column.
 */

import type { HandFacts, SeatFacts } from "./types";
import { COUNTER_KEYS, MONEY_KEYS, ZERO_COUNTERS, ZERO_MONEY } from "./types";

/** Dimension columns, in order. Counters and money follow, in their own order. */
export const DIMENSION_COLUMNS = [
  "stats_version",
  "hand_key",
  "site_id",
  "hand_id",
  "played_at",
  "variant",
  "limit_type",
  "game_format",
  "currency",
  "currency_minor_units",
  "small_blind",
  "big_blind",
  "player_count",
  "max_seats",
  "table_name",
  "tournament_id",
  "fast_fold",
  "has_straddle",
  "is_bomb_pot",
  "is_big_blind_ante",
  "is_run_it_twice",
  "has_cashout",
  "is_walk",
  "street_reached",
  "total_pot",
  "house_into_pot",
  "fees",
  "seat",
  "player",
  "is_hero",
  "position",
  "hole_cards",
  "hand_class",
  "starting_stack",
  "starting_stack_bb_tenths",
] as const;

/**
 * Every column of a stats row, in order.
 *
 * `tests/test/statsDerive.test.ts` asserts that the keys of a real derived row
 * are exactly this list. That is the schema-drift guard: adding a counter to
 * `types.ts` and forgetting the column, or renaming one, fails loudly here
 * rather than quietly producing rows the table cannot take.
 */
export const STATS_COLUMNS: string[] = [
  ...DIMENSION_COLUMNS,
  ...COUNTER_KEYS,
  ...MONEY_KEYS,
];

/**
 * One derived row: one seat of one hand.
 *
 * Typed loosely on purpose — the counter and money members are spread in from
 * `SeatCounters` and `SeatMoney`, so they cannot drift from the definitions in
 * `types.ts`.
 */
export type StatsRow = {
  stats_version: string;
  hand_key: string;
  site_id: string;
  hand_id: string;
  played_at: string | null;
  variant: string;
  limit_type: string;
  game_format: string;
  currency: string;
  currency_minor_units: number;
  small_blind: number;
  big_blind: number;
  player_count: number;
  max_seats: number;
  table_name: string | null;
  tournament_id: string | null;
  fast_fold: string | null;
  has_straddle: boolean;
  is_bomb_pot: boolean;
  is_big_blind_ante: boolean;
  is_run_it_twice: boolean;
  has_cashout: boolean;
  is_walk: boolean;
  street_reached: string;
  total_pot: number;
  house_into_pot: number;
  fees: number;
  seat: number;
  player: string;
  is_hero: boolean;
  position: string | null;
  hole_cards: string[];
  hand_class: string | null;
  starting_stack: number;
  starting_stack_bb_tenths: number;
} & typeof ZERO_COUNTERS &
  typeof ZERO_MONEY;

function rowFor(facts: HandFacts, seat: SeatFacts): StatsRow {
  const { hand } = facts;
  return {
    stats_version: hand.statsVersion,
    hand_key: hand.handKey,
    site_id: hand.siteId,
    hand_id: hand.handId,
    played_at: hand.playedAt,
    variant: hand.variant,
    limit_type: hand.limit,
    game_format: hand.format,
    currency: hand.currency,
    currency_minor_units: hand.currencyMinorUnits,
    small_blind: hand.smallBlind,
    big_blind: hand.bigBlind,
    player_count: hand.playerCount,
    max_seats: hand.maxSeats,
    table_name: hand.tableName,
    tournament_id: hand.tournamentId,
    fast_fold: hand.fastFold,
    has_straddle: hand.hasStraddle,
    is_bomb_pot: hand.isBombPot,
    is_big_blind_ante: hand.isBigBlindAnte,
    is_run_it_twice: hand.isRunItTwice,
    has_cashout: hand.hasCashout,
    is_walk: hand.isWalk,
    street_reached: hand.streetReached,
    total_pot: hand.totalPot,
    house_into_pot: hand.houseIntoPot,
    fees: hand.fees,
    seat: seat.seat,
    player: seat.player,
    is_hero: seat.isHero,
    position: seat.position,
    hole_cards: seat.holeCards,
    hand_class: seat.handClass,
    starting_stack: seat.startingStack,
    starting_stack_bb_tenths: seat.startingStackBbTenths,
    ...seat.counters,
    ...seat.money,
  };
}

/** One row per dealt-in seat. */
export function statsRows(facts: HandFacts): StatsRow[] {
  return facts.seats.map((seat) => rowFor(facts, seat));
}
