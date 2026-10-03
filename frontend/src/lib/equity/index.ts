/**
 * Equity and all-in EV.
 *
 * ```
 * evaluator.ts   5-7 card values, full deck and short deck (one table, plus two
 *                short-deck tables chosen per room)
 * omaha.ts       exactly two from the hand, exactly three from the board
 * enumerate.ts   equity per pot over every runout, or a fixed-seed sample
 * range.ts       one hand against a weighted range, card removal applied
 * multiway.ts    one hand against several ranges at once (the field), card removal across all
 * allInEv.ts     PhfHand -> pots at the all-in -> evNet per seat
 * ```
 *
 * **Import rule: this module may import only `lib/phf/types` and `lib/cards`.**
 * Same reason as `lib/stats`: no Supabase, no React, no `window`, no `process`,
 * so `tests/test/` can run it directly and a server route or backfill can run
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
  SHORT_DECK_RULE_BY_SITE,
  SHORT_DECK_STRAIGHT_OVER_TRIPS,
  STANDARD,
  cardCode,
  cardIndex,
  categoryOf,
  evaluate,
  evaluateMasks,
  shortDeckRuleFor,
  shortDeckTable,
  suitMasks,
  type HandCategory,
  type RankingTable,
  type ShortDeckRule,
} from "./evaluator";
export {
  DEFAULT_RANGE_EXHAUSTIVE_LIMIT,
  DEFAULT_RANGE_TRIALS,
  allClasses,
  classCombos,
  equityVsRange,
  parseRange,
  rangeCombos,
  rangeShare,
  strongestOfRange,
  type ClassWeights,
  type RangeEquityRequest,
  type RangeEquityResult,
  type WeightedCombo,
} from "./range";
export {
  DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT,
  DEFAULT_MULTIWAY_TRIALS,
  equityVsRanges,
  type MultiwayEquityRequest,
  type MultiwayEquityResult,
} from "./multiway";
export {
  boardTripleMasks,
  evaluateOmaha,
  evaluateOmahaLow,
  evaluateOmahaMasks,
  holePairMasks,
} from "./omaha";
