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
 * plan.ts      the study plan (A8b): focus areas from the leak finder, the week's checklist, the retrospective
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
  NINE_SCRIPT_POSITIONS,
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
  ALL_PREFLOP_SEATS,
  PREFLOP_SEATS,
  trainerSet,
  dealPreflop,
  dealingWeights,
  familiesOf,
  freshSeed,
  interest,
  lineActs,
  lineAggressor,
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
  RIVER_ROLES,
  RIVER_SEATS,
  facingWeights,
  filterSeat,
  flopPlayers,
  generateRiverSpot,
  riverAnswer,
  riverDealingWeights,
  riverLines,
  riverSeatings,
  type RiverLine,
  type RiverMenuItem,
  type RiverPot,
  type RiverRole,
  type RiverSeat,
  type RiverSeating,
  type RiverSpotOptions,
  type RiverTrainerSpot,
} from "./river";
export { generateTurnSpot, turnAnswer, turnSetup, type TurnSetup, type TurnSpotOptions, type TurnTrainerSpot } from "./turn";
export {
  flopAnswer,
  flopChunkFor,
  flopFilterSeat,
  flopSeatings,
  generateFlopSpot,
  heroNode,
  libraryFlops,
  planFlop,
  type FlopFacing,
  type FlopPlan,
  type FlopSpotOptions,
  type FlopTrainerSpot,
} from "./flop";
export {
  MAX_SPLIT_ROWS,
  MIN_SPLIT_SHARE,
  SMALL_MAX,
  SPLIT_PASS,
  SPLIT_SLACK,
  generateSplit,
  gradeSplit,
  rightGroups,
  splitTable,
  type SplitGrade,
  type SplitGroup,
  type SplitItem,
  type SplitOptions,
  type SplitRow,
} from "./split";
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
  answerHand,
  needsFlopLibrary,
  prepareFlopLibrary,
  runTrainingJob,
  trainingChunk,
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
export {
  AREA_CONCEPTS,
  FUNDAMENTAL_CONCEPTS,
  MAX_AREA_KEYS,
  MAX_DRILL_TARGET,
  MIN_PLAN_MOVES,
  PLAN_FOCUS,
  REVIEW_HANDS,
  TENTATIVE_MIN_MISTAKES,
  TRAIN_TARGET,
  addWeeks,
  areaChange,
  areaId,
  areaPeriod,
  daysLeft,
  focusAreas,
  fundamentalsTasks,
  localDate,
  parseFocus,
  parseTrainerRef,
  pickFocus,
  planFocus,
  planProgress,
  planTasks,
  retroWindows,
  rpcTask,
  trainerMatch,
  trainerRef,
  trainerTarget,
  areaSet,
  weekBounds,
  weekStart,
  withReviews,
  type AreaChange,
  type AreaPeriod,
  type AreaWhere,
  type FocusArea,
  type FocusInput,
  type FocusLeak,
  type PlanFocus,
  type PlanKind,
  type PlanProgress,
  type PlanTask,
  type PreviousPlan,
  type RetroWindows,
  type ReviewHand,
  type TaskInput,
  type TaskKind,
  type TaskState,
  type TrainerMatch,
  type TrainerTarget,
} from "./plan";
