/**
 * The statistics derivation engine.
 *
 * ```
 * PhfHand ──handFacts()──▶ HandFacts ──statsRows()──▶ StatsRow[]  (one per seat)
 *                                                          │
 *                                                    aggregate() + rates()
 * ```
 *
 * All **semantics** live here, in TypeScript, where they can be run against the
 * 413-file corpus in `tests/test/`. All **arithmetic** belongs in SQL, where
 * it is never more than `sum()` and `group by`. See `docs/STATS-SPEC.md` for
 * the definition of every counter and for every place PokerTracker 4 and Holdem
 * Manager 3 disagree.
 *
 * **Import rule: this module may import only `lib/phf/types`,
 * `lib/phf/validate` and `lib/cards`.** No Supabase, no React, no `window`, no
 * `process`. That is what lets `tests/test/` import it directly and what will
 * let a server-side backfill run the identical function later.
 */

export {
  STATS_VERSION,
  ZERO_COUNTERS,
  ZERO_MONEY,
  COUNTER_KEYS,
  MONEY_KEYS,
  OPPORTUNITY_PAIRS,
  LEG_SETS,
  STREET_CHAINS,
  emptyCounters,
  emptyMoney,
  type StatsVersion,
  type SeatCounters,
  type SeatMoney,
  type SeatIdentity,
  type SeatFacts,
  type HandDimensions,
  type HandFacts,
  type CounterKey,
  type MoneyKey,
} from "./types";

export { handFacts, handFactsAll, potTypeOf } from "./derive";

export {
  buildContext,
  detectAnteModel,
  detectBombPot,
  isDecision,
  firstDecision,
  liveOnStreet,
  seatStreet,
  POSTFLOP_STREETS,
  type Decision,
  type PostflopStreet,
  type StatsContext,
} from "./context";

export { stealAttempt, preflopCounters } from "./preflop";
export { cbetChain, postflopCounters } from "./postflop";
export { showdownCounters } from "./showdown";
export {
  collectedBySeat,
  contributedBySeat,
  largestRemainder,
  moneyBySeat,
  toBbMilli,
} from "./money";

export {
  DIMENSION_COLUMNS,
  STATS_COLUMNS,
  statsRows,
  type StatsRow,
} from "./mapping";

export {
  aggregate,
  addCounters,
  addMoney,
  pct,
  rates,
  type AggregateOptions,
  type StatsRates,
  type StatsTotals,
} from "./rates";
