/**
 * Preflop reference charts (ANALYSIS-PLAN §3.1, phase A2a). See docs/CHARTS.md.
 *
 * ```
 * format.ts     CHARTS_VERSION, the stored JSON, encode / decode, loadCharts
 * build.ts      a solved preflop game -> a chart set (reach, ranges, scenarios)
 * generate.ts   the generator as a pure function: equity, tree, DCFR, convergence
 * realisation.ts charts/2: measure realisation with the postflop solver, fit, rounds
 * lookup.ts     a real preflop line -> node, options, approximations (or a reason)
 * fromHand.ts   PhfHand -> the PreflopSpot of one hero decision; the sets a hand needs
 * registry.ts   the library of sets (table x depth x kind), which one answers a spot, lazy loading
 * base64.ts     the blob encoding, without Buffer or atob
 * data/         the committed chart sets, one JSON per table, depth and kind, transcribed - never edited by hand
 * ```
 *
 * **Import rule: the same as `lib/solver`, plus `lib/solver` itself.** This
 * module may import only `lib/phf/types`, `lib/cards`, `lib/equity` and
 * `lib/solver`: it runs under plain Node in `tests/test` and in a Web Worker.
 *
 * The charts are GTO Wizard's (`charts/11`): every committed set is a GTO
 * Wizard preflop solution, transcribed by
 * `tests/scripts/preflop-charts/gtow.test.ts` (sizes merged where Rail's
 * one-raise-per-decision line needs it, docs/CHARTS.md §6). Rail's own
 * generator (`generate.ts`, `build.ts`, `realisation.ts`: `lib/solver`'s
 * preflop DCFR with a realisation model fitted to its postflop solves)
 * stays for its tests and research, but none of its sets ships.
 */

export {
  CHART_SET_VERSIONS,
  CHARTS_VERSION,
  GTOW_CHARTS_VERSION,
  ChartFormatError,
  isOpenLimpNode,
  loadCharts,
  serializeCharts,
  type ChartAction,
  type ChartNode,
  type ChartNodeJson,
  type ChartOptionJson,
  type ChartPosition,
  type ChartScenario,
  type ChartSet,
  type ChartSetJson,
} from "./format";
export {
  buildChartSet,
  fnv1a,
  IN_RANGE,
  MAX_SELF_LOSS,
  nodeReaches,
  OFF_RANGE,
  type BuildChartOptions,
} from "./build";
export {
  generateChartSet,
  PRODUCTION_ITERATIONS,
  PRODUCTION_MIN_REACH,
  type ConvergencePoint,
  type GenerateOptions,
  type GenerateProgress,
  type GenerateResult,
} from "./generate";
export {
  aggregateSamples,
  fitRealisation,
  generateRealisedChartSet,
  MAX_FIT_SHARE,
  measurementJobs,
  prepareSpots,
  PRODUCTION_MEASURE,
  PRODUCTION_ROUND_ITERATIONS,
  PRODUCTION_ROUNDS,
  RANGE_SHRINK,
  REALISATION_SPOTS,
  REPORT_GROUPS,
  RIDGE,
  sampleDeals,
  spotTerminal,
  type PreparedSpot,
  type RealisationFit,
  type RealisationFitReport,
  type RealisationMeasureOptions,
  type RealisationRound,
  type RealisationSpotSpec,
  type RealisedGenerateOptions,
} from "./realisation";
export {
  chartTree,
  handClassOf,
  hasRailTree,
  lookupPreflop,
  rareLineDepthSets,
  STACK_NOTE_TOLERANCE,
  STACK_TOLERANCE,
  type ChartApproximation,
  type ChartLookup,
  type ChartMissReason,
  type ChartOption,
  type LookupOptions,
  type PreflopActionInput,
  type PreflopSpot,
  uncoveredDepthSets,
} from "./lookup";
export { anteOf, liveNames, postedLimp, preflopSpotFromHand, rareLineChartSets, requiredChartSets, type SpotFromHandResult } from "./fromHand";
export {
  ANTE_SIZE_TOLERANCE,
  anteMismatch,
  CHART_SETS,
  chartLibrary,
  chartSetKind,
  DEFAULT_CHART_SET,
  effectiveStackBb,
  ensureChartSets,
  isChartLibrary,
  loadChartLibrary,
  loadChartSet,
  pickChartSet,
  PLANNED_CHART_SETS,
  PREFERRED_CHART_SET,
  setsOfKind,
  STRADDLE_SIZE_TOLERANCE,
  straddleMismatch,
  type ChartLibrary,
  type ChartSetKind,
  type ChartSetPick,
  type ChartSetSpec,
} from "./registry";

/** The library's default set alone (`DEFAULT_CHART_SET`), loaded on demand. */
export async function loadDefaultCharts() {
  const { loadChartSet, DEFAULT_CHART_SET } = await import("./registry");
  return loadChartSet(DEFAULT_CHART_SET);
}
