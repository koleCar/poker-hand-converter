/**
 * The app's door to the web's analysis sheet words (R5.4): the dictionaries
 * the web's replayer sheet reads (`lib/i18n/ns/analysis.*.ts`, plain data
 * and functions), so one hand's analysis in the app says what the web's does
 * in both languages - the option labels, the spot's facts, the flags, the
 * approximations and the *why* (`explain()`, sentences built only from the
 * engine's record) - and the reference helpers that pick the best option.
 * Kept apart from `library.ts` so the analysis worker does not bundle the
 * words. ESLint lets only the doors import `@rail/web-lib`.
 */
export { analysisEn } from "@rail/web-lib/i18n/ns/analysis.en";
export { analysisHr } from "@rail/web-lib/i18n/ns/analysis.hr";
export { bestOption, betterAlternative } from "@rail/web-lib/analysis/reference";
export type { OptionAnalysis, SpotFacts } from "@rail/web-lib/analysis/types";
