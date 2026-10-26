/**
 * The app's second door to the web's library (R5.4): the leak finder's top
 * three (R5.2) - its pure ranking (`lib/analysis/leaks.ts`,
 * `lib/analysis/topLeaks.ts`) and its words in both languages
 * (`lib/i18n/ns/analysisLeaks.*.ts`, plain data and functions) - so the
 * app's card says exactly what the web's says. Kept apart from
 * `library.ts` so the analysis worker does not bundle the words. ESLint
 * lets only the two doors import `@rail/web-lib`.
 */
export {
  groupLeaks,
  leakKind,
  type Confidence,
  type Leak,
  type SpotRow,
  type Trend,
} from "@rail/web-lib/analysis/leaks";
export {
  EXAMPLES_FETCH,
  leakSize,
  leakTrend,
  pickExamples,
  rankTopLeaks,
  TOP_PERIODS,
  type LeakTrend,
  type RankedLeak,
  type TopPeriod,
} from "@rail/web-lib/analysis/topLeaks";
export { leaksEn, summaryEn, topLeaksEn } from "@rail/web-lib/i18n/ns/analysisLeaks.en";
export { leaksHr, summaryHr, topLeaksHr } from "@rail/web-lib/i18n/ns/analysisLeaks.hr";
