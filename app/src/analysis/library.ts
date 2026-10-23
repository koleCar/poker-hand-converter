/**
 * The app's one door to the web's analysis library (docs/RAIL-PLAN.md R5.4).
 *
 * The analysis is `frontend/src/lib/analysis` - the decision walk, the
 * preflop charts (`lib/charts`), the solver, the flop library reader - used
 * **in place**: `@rail/web-lib` is an alias of `frontend/src/lib`
 * (`vite.config.ts`, `tsconfig.app.json`), not a copy and not a package, so
 * a change merged into the web's library is the app's on its next build and
 * the two grade a hand identically by construction (`tests/test/
 * appAnalysisParity.test.ts` holds them to it).
 *
 * The surface is exactly what is re-exported here. The library is
 * framework-free by the web's own lint rule; what it reaches is pure
 * TypeScript (`lib/analysis`, `lib/charts`, `lib/solver`, `lib/equity`,
 * `lib/stats`, `lib/phf`, `lib/cards`) and the charts' JSON. Nothing that
 * knows about Supabase or Next comes in: the web's own analysis worker
 * (`frontend/src/workers/analysis.worker.ts`) reads the Supabase URL and the
 * rebuild (`lib/db/analysis.ts`) the browser client, so the app has a worker
 * and a runner of its own (`worker.ts`, `runner.ts`) and injects what they
 * took from Supabase: the flop library's files (through Rust, cached on
 * disk), the opponents' statistics (the local store) and the rows' writer.
 * ESLint (`no-restricted-imports`) keeps every other app file away from
 * `@rail/web-lib`, and `tests/test/appAnalysisLibrary.test.ts` bundles the
 * worker and fails on any module outside that list.
 */
export {
  ANALYSIS_VERSION,
  analyzeHand,
  FLOP_LIBRARY_ENABLED,
  FlopLibraryLoader,
  VILLAIN_MIN_HANDS,
  type DecisionAnalysis,
  type FlopLibrary,
  type HandAnalysis,
  type LibraryFetch,
  type LoaderOptions,
  type VillainStatsMap,
} from "@rail/web-lib/analysis";
export {
  CHART_SETS,
  ensureChartSets,
  loadChartLibrary,
  loadChartSet,
  rareLineChartSets,
  requiredChartSets,
  type ChartLibrary,
  type ChartSet,
} from "@rail/web-lib/charts";
export {
  analyseStoredHands,
  handAnalysisFromStored,
  handAnalysisRow,
  type AnalysedBatch,
  type DecisionAnalysisInsert,
  type HandAnalysisInsert,
} from "@rail/web-lib/db/analysisRows";
export {
  opponentsOf,
  VillainCounters,
  type VillainCountersFetch,
  type VillainCountersRow,
  type VillainPlayer,
} from "@rail/web-lib/db/villainCounters";
export type { PhfHand } from "@rail/web-lib/phf/types";
