/**
 * The app's one door to the web's Solver library: the browser the web's
 * `/solver` renders (`web/src/components/solver`), used **in place** through
 * the `@rail/web-solver` alias, as the analysis library is through
 * `@rail/web-lib` (`src/analysis/library.ts`). The components are
 * host-neutral (`host.tsx`): they take their strings, their flop library
 * reader and their view's keeper from the page, so nothing of Next, the
 * web's i18n or Supabase comes in. ESLint keeps every other app file away
 * from both aliases.
 */
export { SolverHostProvider, type SolverDict, type SolverHost } from "@rail/web-solver/host";
export { SolverLibrary, SOLVER_SETS, type SolverView } from "@rail/web-solver/SolverLibrary";
export { solverEn } from "@rail/web-lib/i18n/ns/solver.en";
export { solverHr } from "@rail/web-lib/i18n/ns/solver.hr";
export { FlopLibraryLoader, flopLinesFor, type LibraryFetch } from "@rail/web-lib/analysis/flopLibrary";
export { CHART_SETS } from "@rail/web-lib/charts";
export { pickedFlop } from "@rail/web-lib/solver";
