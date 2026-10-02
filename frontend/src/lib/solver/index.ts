/**
 * Postflop solver: Discounted CFR over heads-up subgames (plan §3.2).
 *
 * ```
 * combos.ts       1326 combo indices, weighted ranges, range text ("TT+, AKs:0.5")
 * tree.ts         the public game tree as flat typed arrays; TreeBuilder; rake
 * game.ts         a game = tree + each player's hands + showdown orderings
 * cfr.ts          DCFR engine, vectorised over hands; best response, exploitability
 * toys.ts         Kuhn, Leduc and the clairvoyance game - the calibration games
 * betting.ts      no-limit betting streets from a bet-size menu
 * subgame.ts      hold'em river and turn+river games from a spot
 * solve.ts        solveRiver / solveTurn -> SolveResult (plain, postMessage-able)
 * format.ts       SOLVER_VERSION and the versioned binary blob
 * isomorphism.ts  suit permutations and canonical boards / spots
 * translation.ts  pseudo-harmonic mapping of real sizes onto solved ones
 * spotKey.ts      the cache key, with no hole cards and no names
 * ```
 *
 * **Import rule: this module may import only `lib/phf/types`, `lib/cards` and
 * `lib/equity`.** No React, no Supabase, no `window`, no `process`, no DOM or
 * Node types - so `tests/test/` runs it under plain Node and a Web Worker runs
 * it in the browser, the same code in both places.
 *
 * **What is production-ready.** The engine, the river builder and solve, the
 * blob format, isomorphism, translation and the spot key. The turn+river solve
 * is correct (the same engine, a chance node per river card) but ~48x the
 * river's cost; it is for tests, tools and offline precomputation until it has
 * river-card isomorphism and a coarser river menu. See `subgame.ts`.
 */

export {
  DEFAULT_DCFR,
  Solver,
  type DcfrParams,
  type Exploitability,
  type RunOptions,
  type RunProgress,
  type RunResult,
} from "./cfr";
export {
  comboCards,
  comboCode,
  comboHi,
  comboIndex,
  comboLo,
  NUM_COMBOS,
  parseCards,
  parseCombo,
  parseRange,
  rangeSize,
  SolverInputError,
  toRange,
  type RangeInput,
} from "./combos";
export { handSet, showdownBoard, type Game, type HandSet, type ShowdownBoard } from "./game";
export { ACTION, CHANCE, FOLD, rakeOf, SHOWDOWN, TreeBuilder, type Edge, type FlatTree, type Rake } from "./tree";
export { clairvoyanceGame, clairvoyanceSolution, kuhnGame, leducGame } from "./toys";
export {
  formatAmount,
  type ActionInfo,
  type ActionKind,
  type BetMenu,
  type BettingRules,
} from "./betting";
export {
  buildRiverGame,
  buildTurnGame,
  type BuiltSubgame,
  type RiverSpot,
  type SpotInput,
  type TurnSpot,
} from "./subgame";
export {
  handIndex,
  nodeAt,
  rangesAt,
  solveBuilt,
  solveRiver,
  solveTurn,
  type SolvedNode,
  type SolveOptions,
  type SolveResult,
} from "./solve";
export { decodeSolution, encodeSolution, SOLVER_VERSION, SolutionFormatError } from "./format";
export {
  canonicalBoard,
  canonicalSpot,
  inversePermutation,
  permuteCard,
  permuteCombo,
  permuteRange,
  SUIT_PERMUTATIONS,
  type CanonicalBoard,
  type CanonicalSpot,
} from "./isomorphism";
export { OFF_TREE_DISTANCE, pseudoHarmonic, translateSize, type Translation } from "./translation";
export { spotHash, spotKey, type SpotKeyParts } from "./spotKey";
