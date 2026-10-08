/**
 * Postflop solver: Discounted CFR over heads-up subgames (plan §3.2), and the
 * multi-player preflop game the chart generator solves (§3.1, docs/CHARTS.md).
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
 * flop.ts         flop+turn+river games and solves, suit isomorphism on both deals (A5b)
 * flopSet.ts      the 1,755 canonical flops, the library's ~100 representatives, the mapping
 * flopLibrary.ts  FLOPLIB_VERSION: the library's chunk format, encode / decode
 * lock.ts         the exploit lab (Learn L4): lock a node, best-respond, gain and risk
 * ```
 *
 * **Import rule: this module may import only `lib/phf/types`, `lib/cards` and
 * `lib/equity`.** No React, no Supabase, no `window`, no `process`, no DOM or
 * Node types - so `tests/test/` runs it under plain Node and a Web Worker runs
 * it in the browser, the same code in both places.
 *
 * **What is production-ready.** The engine, the river builder and solve, the
 * blob format, isomorphism, translation and the spot key; since A5a the
 * turn+river solve too, with river-card isomorphism (`TurnSpot.isomorphism`),
 * optional chance sampling (`SolveOptions.sampling`), a coarse river menu and
 * a turn-only result (`SolveOptions.nodes`). See `subgame.ts` and `cfr.ts`.
 */

export {
  DEFAULT_DCFR,
  Solver,
  type BestResponseRow,
  type ChanceSampling,
  type DcfrParams,
  type Exploitability,
  type RunOptions,
  type RunProgress,
  type RunResult,
  type SolverConfig,
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
export { handSet, showdownBoard, type Game, type HandSet, type Mirror, type ShowdownBoard } from "./game";
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
  type TurnIsomorphism,
  type TurnSpot,
} from "./subgame";
export {
  extract,
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
export {
  exploitLab,
  groupShareOf,
  loadResult,
  lockedStrategy,
  ownReach,
  resultNodeIds,
  type LabOptions,
  type LabResult,
  type NodeLock,
} from "./lock";
export { decodeSolution, encodeSolution, SOLVER_VERSION, SolutionFormatError } from "./format";
export {
  boardSymmetries,
  canonicalBoard,
  canonicalSpot,
  cardOrbit,
  inversePermutation,
  permuteCard,
  permuteCombo,
  permuteRange,
  spotSymmetries,
  SUIT_PERMUTATIONS,
  SYMMETRY_TOLERANCE,
  symmetrize,
  type CanonicalBoard,
  type CanonicalSpot,
} from "./isomorphism";
export {
  buildFlopGame,
  solveFlop,
  type FlopProgress,
  type FlopSolve,
  type FlopSolveOptions,
  type FlopSpot,
} from "./flop";
export type { FlopIsomorphism } from "./subgame";
export {
  canonicalFlops,
  classQuota,
  computeRepresentatives,
  FLOP_CLASSES,
  FLOP_DISTANCE_WEIGHTS,
  FLOP_REPRESENTATIVE_COUNT,
  FLOP_REPRESENTATIVES,
  flopCards,
  flopDistance,
  flopFeatures,
  flopIndices,
  flopKey,
  kMedoids,
  mapFlop,
  MIN_PER_CLASS,
  representativeCoverage,
  straightPairs,
  type CanonicalFlop,
  type FlopClass,
  type FlopFeatures,
  type FlopMapping,
} from "./flopSet";
export {
  chunkHeader,
  chunkPath,
  decodeChunk,
  encodeChunk,
  FLOPLIB_VERSION,
  FlopChunkFormatError,
  type FlopChunk,
  type FlopChunkHeader,
  type FlopManifest,
  type FlopManifestEntry,
} from "./flopLibrary";
export { OFF_TREE_DISTANCE, pseudoHarmonic, translateSize, type Translation } from "./translation";
export { spotHash, spotKey, type SpotKeyParts } from "./spotKey";

/*
 * Preflop (phase A2a): the multi-player game the chart generator solves.
 *
 * handClasses.ts   the 169 classes, combo counts, class-level card removal
 * preflopEquity.ts 169x169 heads-up equity, seeded Monte Carlo, symmetrised
 * preflopModel.ts  equity realisation: odds form, weights by role and class features; rake
 * preflopRealisation.ts  realised shares measured by solving sampled turn+river spots
 * preflopTree.ts   the 6-max action abstraction and its cuts, line keys
 * preflopCfr.ts    DCFR for up to six players over 169-class vectors; NashConv
 */
export {
  CLASS_COMBOS,
  classByName,
  classIndex,
  classOfCards,
  classOfCombo,
  COMBO_CLASS,
  combosOfClass,
  COMBOS_AFTER_HAND,
  comboShare,
  COMPAT,
  HAND_CLASSES,
  incidence,
  independentMass,
  massVector,
  NUM_CLASSES,
  type HandClass,
} from "./handClasses";
export {
  DEFAULT_EQUITY_BOARDS,
  DEFAULT_EQUITY_SEED,
  preflopEquityTable,
  type PreflopEquityOptions,
  type PreflopEquityTable,
} from "./preflopEquity";
export {
  CHARTS1_REALISATION,
  CLASS_FEATURES,
  flopRake,
  NO_RAKE,
  POT_TYPES,
  RAKE_POT_GROWTH,
  realisationAssumptions,
  realisationRole,
  REALISATION_FEATURES,
  REALISATION_ROLES,
  roleBiases,
  roleWeights,
  shareMatrix,
  STANDARD_RAKE,
  type PotType,
  type RakeProfile,
  type RealisationFeature,
  type RealisationModel,
  type RealisationRole,
  type RoleRealisation,
} from "./preflopModel";
export {
  addSample,
  emptySample,
  measureRealisation,
  REALISATION_MENU,
  type RealisationSample,
  type RealisationSpot,
} from "./preflopRealisation";
export {
  buildPreflopTree,
  DEFAULT_SIZING,
  FLAG_COLD_CALL_CUT,
  FLAG_LIMP_CUT,
  FLAG_LIMPERS_CAP,
  FLAG_MULTIWAY_CAP,
  PF_ACTION,
  PF_ALLIN,
  PF_FLOP,
  PF_FOLD,
  POSTFLOP_ORDER,
  potAt,
  POT_TYPE_INDEX,
  preflopNodeAt,
  NINE_MAX,
  SIX_MAX,
  type PreflopPosition,
  type PreflopSizing,
  type PreflopTree,
  type PreflopTreeConfig,
} from "./preflopTree";
export { PreflopSolver, type PreflopExploitability, type PreflopGame } from "./preflopCfr";
