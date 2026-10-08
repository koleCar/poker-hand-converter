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
 * registry.ts   charts/3: the library of sets (table x depth), which one answers a spot, lazy loading
 * base64.ts     the blob encoding, without Buffer or atob
 * data/         the committed chart sets, one JSON per table and depth, generated - never edited by hand
 * ```
 *
 * **Import rule: the same as `lib/solver`, plus `lib/solver` itself.** This
 * module may import only `lib/phf/types`, `lib/cards`, `lib/equity` and
 * `lib/solver`: it runs under plain Node in `tests/test` and in a Web Worker.
 *
 * The charts are ours: computed by `lib/solver`'s preflop DCFR with an
 * equity-realisation model fitted to `lib/solver`'s own postflop solves,
 * never copied from any published chart.
 */

export {
  CHART_SET_VERSIONS,
  CHARTS_VERSION,
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
  lookupPreflop,
  STACK_NOTE_TOLERANCE,
  STACK_TOLERANCE,
  type ChartApproximation,
  type ChartLookup,
  type ChartMissReason,
  type ChartOption,
  type PreflopActionInput,
  type PreflopSpot,
} from "./lookup";
export { preflopSpotFromHand, requiredChartSets, type SpotFromHandResult } from "./fromHand";
export {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  effectiveStackBb,
  ensureChartSets,
  isChartLibrary,
  loadChartLibrary,
  loadChartSet,
  pickChartSet,
  STRADDLE_SIZE_TOLERANCE,
  straddleMismatch,
  type ChartLibrary,
  type ChartSetPick,
  type ChartSetSpec,
} from "./registry";

/** The committed 6-max 100bb cash set alone, loaded on demand (~0.7 MB of JSON). */
export async function loadDefaultCharts() {
  const { loadCharts } = await import("./format");
  const data = await import("./data/nlhe-cash-6max-100bb.json");
  return loadCharts(data.default ?? data);
}
