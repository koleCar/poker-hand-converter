/**
 * Hand analysis: how far each hero decision was from a reference, what it
 * cost, and why. `docs/ANALYSIS-PLAN.md` is the plan; this module is phases
 * A1 (the decision model, the facts, the heuristic flags and the grading
 * rules) and A2b (preflop grades from the charts).
 *
 * ```
 * types.ts       DecisionAnalysis, HandAnalysis, SpotFacts, flags, ANALYSIS_VERSION
 * grading.ts     §2 thresholds and grade()
 * preflop.ts     chart grading of preflop decisions; opponents' chart ranges
 * walk.ts        hero decisions with the money state before each (on lib/stats)
 * texture.ts     board texture, made hand, draws, blockers
 * ranges.ts      default ranges per preflop line — the labelled fallback
 * heuristics.ts  §3.6 flags: notes, never grades
 * analyze.ts     analyzeHand(hand) -> HandAnalysis
 * reports.ts     A3: range and hand-adjusted reference frequencies, stats rolled up from nodes
 * ```
 *
 * **Import rule: this module may import only `lib/phf/types`, `lib/cards`,
 * `lib/stats`, `lib/equity` and `lib/charts` (its public index only).** The
 * same rule as `lib/stats` and `lib/equity`, for the same reason: `tests/test/`
 * imports it directly under plain Node, and the rebuild runs the identical
 * function in a Web Worker. No React, no Supabase, no `window`, no `process`.
 * The chart set itself is passed in (`AnalyzeOptions.charts`), never loaded
 * here.
 */

export {
  ANALYSIS_VERSION,
  APPROXIMATIONS,
  CHART_SKIP_REASONS,
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
  type ChartRef,
  type ChartSkipReason,
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
export {
  MIX_MIN_FREQ,
  bestOption,
  betterAlternative,
  impliedOddsClass,
  modelCaveat,
  mostFrequent,
  outOfRange,
  referenceMix,
} from "./reference";
export { WEAK_CHART_VERSIONS, chartRange, gradePreflop, type ChartRange, type PreflopGrade, type PreflopGradeInput } from "./preflop";
export {
  CHART_ACTIONS,
  MIN_PRACTICAL_DIFF,
  MIN_SAMPLE,
  POSTFLOP_ORDER,
  POSTFLOP_ROLES,
  REPORT_STATS,
  STAT_SPECS,
  TABLE_ORDER,
  WILSON_Z,
  aggregate,
  compare,
  compatibility,
  defenceTable,
  handAdjustedReference,
  inPositionAgainst,
  nodeKey,
  nodeReport,
  nodeSamples,
  openerOf,
  opponentRanges,
  postflopRoles,
  rangeReference,
  removalFactors,
  statParts,
  statReport,
  walkLine,
  wilsonInterval,
  type ActionFreq,
  type Comparison,
  type DefenceRow,
  type LineStep,
  type NodeActionCount,
  type NodeClassCount,
  type NodeReport,
  type NodeSample,
  type OpponentRange,
  type PostflopCount,
  type PostflopRoleStats,
  type PostflopRoleId,
  type RangeReference,
  type ReportStatId,
  type SplitKey,
  type StatPart,
  type StatReport,
  type StatSplit,
  type Verdict,
} from "./reports";
