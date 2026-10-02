/**
 * Hand analysis: how far each hero decision was from a reference, what it
 * cost, and why. `docs/ANALYSIS-PLAN.md` is the plan; this module is phase A1
 * of it — the decision model, the facts, the heuristic flags and the grading
 * rules, with no reference strategy yet.
 *
 * ```
 * types.ts       DecisionAnalysis, HandAnalysis, SpotFacts, flags, ANALYSIS_VERSION
 * grading.ts     §2 thresholds and grade(), ready for A2's frequencies
 * walk.ts        hero decisions with the money state before each (on lib/stats)
 * texture.ts     board texture, made hand, draws, blockers
 * ranges.ts      default ranges per preflop line — a labelled placeholder
 * heuristics.ts  §3.6 flags: notes, never grades
 * analyze.ts     analyzeHand(hand) -> HandAnalysis
 * ```
 *
 * **Import rule: this module may import only `lib/phf/types`, `lib/cards`,
 * `lib/stats` and `lib/equity`.** The same rule as `lib/stats` and
 * `lib/equity`, for the same reason: `tests/test/` imports it directly under
 * plain Node, and the rebuild runs the identical function in a Web Worker.
 * No React, no Supabase, no `window`, no `process`.
 */

export {
  ANALYSIS_VERSION,
  APPROXIMATIONS,
  DECISION_SKIP_REASONS,
  FLAG_CODES,
  FLAG_SEVERITIES,
  GRADES,
  HAND_SKIP_REASONS,
  type AnalysisSource,
  type AnalysisVersion,
  type Approximation,
  type BlockerClass,
  type BoardTexture,
  type Connectedness,
  type DecisionAction,
  type DecisionAnalysis,
  type DecisionSkipReason,
  type DecisionStreet,
  type DrawClass,
  type Dynamism,
  type Flag,
  type FlagCode,
  type FlagSeverity,
  type Grade,
  type HandAnalysis,
  type HandSkipReason,
  type HandStatus,
  type HighCardClass,
  type KickerClass,
  type MadeHand,
  type MadeHandClass,
  type OptionAnalysis,
  type PostflopFacing,
  type PostflopRole,
  type PreflopScenario,
  type SpotFacts,
  type SuitTexture,
} from "./types";

export {
  GOOD_MIN_FREQ,
  INACCURATE_MAX_EV_LOSS_POT,
  MISTAKE_MAX_EV_LOSS_POT,
  PERFECT_EV_LOSS_POT,
  PERFECT_FREQ_BAND,
  SCORE_PER_POT,
  grade,
  gradeRank,
  meanScore,
  worstGrade,
  worstSeverity,
  type GradeInput,
  type GradeResult,
} from "./grading";

export { heroSpots, type Spot } from "./walk";
export { blockers, boardTexture, draws, madeHand, straightCombos, toIndices } from "./texture";
export { defaultRange, preflopLine, type DefaultRange, type PreflopLine } from "./ranges";
export {
  BEATS_NOTHING,
  CALL_SHORTFALL,
  COMMITTED_PRICE,
  COMMITTED_SHARE,
  FOLD_SURPLUS,
  THIN_BEHIND,
  heuristicFlags,
} from "./heuristics";
export { analyzeHand, heroSeatOf, type AnalyzeOptions } from "./analyze";
