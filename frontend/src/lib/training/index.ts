/**
 * Training (phase A7, `docs/ANALYSIS-PLAN.md` §7): the preflop trainer, the
 * river spot trainer and spaced-repetition drills of the player's own
 * mistakes. Everything here is pure and deterministic given a seed; the
 * screens are `components/analysis/train/`, the storage
 * `20270208090000_analysis_training.sql` through `lib/db/training.ts`.
 *
 * ```
 * rng.ts       a seeded generator: a spot is a function of its seed
 * handText.ts  a short script as standard hand-history text, parsed like an upload; the spot as a player sees it
 * preflop.ts   chart nodes by family and seat, dealing weights (range, card removal, borderline bias), spot and answer hands
 * river.ts     heads-up river spots: a chart line, a board, flop/turn patterns, the analysis' narrowing and solve
 * grade.ts     a trainer answer graded by the analysis itself; a drill answer against its stored options
 * schedule.ts  SM-2 for drills (the database runs the same arithmetic)
 * session.ts   a session's score: Perfect…Blunder counts, streaks, EV lost
 * jobs.ts      the trainer worker's requests and answers, and the function that does them
 * ```
 *
 * **Import rule: the same as `lib/analysis`, plus `lib/analysis` and the
 * standard-text parser (`lib/phf/serialize`).** This module may import only
 * `lib/phf`, `lib/cards`, `lib/stats`, `lib/equity`, `lib/charts`,
 * `lib/solver` and `lib/analysis`: `tests/test/` imports it under plain Node
 * and the trainer runs it in a Web Worker. No React, no Supabase, no
 * `window`, no `process`. The chart set is passed in, never loaded here.
 *
 * **One grader.** A trainer answer is graded by `analyzeHand` on the spot's
 * hand with the answer appended (`gradeAnswer`), so a trainer grade is the
 * analysis grade of the same spot by construction; the tests hold it to that.
 */

export { nextSeed, pickOne, pickWeighted, seeded, type Rng } from "./rng";
export {
  HERO_NAME,
  POSTFLOP_ORDER,
  SCRIPT_POSITIONS,
  ScriptError,
  completePreflop,
  handUpTo,
  lastHeroDecision,
  scriptHand,
  scriptMoney,
  scriptText,
  seatOf,
  type HandScript,
  type ScriptAct,
  type ScriptMoney,
  type ScriptPosition,
} from "./handText";
export {
  BORDERLINE_FLOOR,
  CLOSE_EV_BB,
  DEAL_BIASES,
  MIN_NODE_REACH,
  PREFLOP_FAMILIES,
  PREFLOP_SEATS,
  dealPreflop,
  dealingWeights,
  familiesOf,
  freshSeed,
  interest,
  lineActs,
  preflopAnswer,
  spotClass,
  trainerNodes,
  type DealBias,
  type PreflopFamily,
  type PreflopMenuItem,
  type PreflopSpotOptions,
  type PreflopTrainerSpot,
} from "./preflop";
export {
  RIVER_LINES,
  RIVER_POTS,
  RIVER_SEATS,
  flopPlayers,
  generateRiverSpot,
  riverAnswer,
  riverDealingWeights,
  riverLines,
  type RiverLine,
  type RiverMenuItem,
  type RiverPot,
  type RiverSeat,
  type RiverSpotOptions,
  type RiverTrainerSpot,
} from "./river";
export { asAnswered, gradeAnswer, gradeDrill, type DrillDecision } from "./grade";
export {
  INITIAL_EASE,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  PASS_QUALITY,
  QUALITY,
  RELEARN_MINUTES,
  isDue,
  newDrillState,
  nextDrillState,
  reviewDrill,
  type DrillState,
} from "./schedule";
export {
  runTrainingJob,
  type GradedAnswer,
  type TrainerSpot,
  type TrainingRequest,
  type TrainingResponse,
} from "./jobs";
export {
  STREAK_GRADES,
  addAnswer,
  emptySession,
  sessionAccuracy,
  sessionScore,
  type SessionStats,
  type TrainerAnswer,
} from "./session";
