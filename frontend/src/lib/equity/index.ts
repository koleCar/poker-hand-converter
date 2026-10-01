/**
 * Equity and all-in EV.
 *
 * ```
 * evaluator.ts   5-7 card values, full deck and short deck (two ranking tables)
 * omaha.ts       exactly two from the hand, exactly three from the board
 * enumerate.ts   equity per pot over every runout, or a fixed-seed sample
 * allInEv.ts     PhfHand -> pots at the all-in -> evNet per seat
 * ```
 *
 * **Import rule: this module may import only `lib/phf/types` and `lib/cards`.**
 * Same reason as `lib/stats`: no Supabase, no React, no `window`, no `process`,
 * so `backend/test/` can run it directly and a server route or backfill can run
 * the identical function.
 */

export {
  EV_VERSION,
  allInEv,
  analyzeAllIn,
  evNetBySeat,
  type AllInEv,
  type AllInEvOptions,
  type AllInEvOutcome,
  type AllInSkipReason,
  type EvPot,
  type EvSeat,
  type EvVersion,
} from "./allInEv";
export {
  DEFAULT_EXHAUSTIVE_LIMIT,
  DEFAULT_SEED,
  DEFAULT_TRIALS,
  EquityInputError,
  equity,
  holeCardsFor,
  mulberry32,
  plan,
  tableFor,
  type EquityGame,
  type EquityRequest,
  type EquityResult,
} from "./enumerate";
export {
  HAND_CATEGORIES,
  SHORT_DECK,
  STANDARD,
  cardCode,
  cardIndex,
  categoryOf,
  evaluate,
  evaluateMasks,
  suitMasks,
  type HandCategory,
  type RankingTable,
} from "./evaluator";
export { boardTripleMasks, evaluateOmaha, evaluateOmahaMasks, holePairMasks } from "./omaha";
