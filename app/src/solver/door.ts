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
export type { StrategyHero } from "@rail/web-solver/StrategyView";
export { solverEn } from "@rail/web-lib/i18n/ns/solver.en";
export { solverHr } from "@rail/web-lib/i18n/ns/solver.hr";
export { FlopLibraryLoader, flopLinesFor, type LibraryFetch } from "@rail/web-lib/analysis/flopLibrary";
export { CHART_SETS } from "@rail/web-lib/charts";
export { pickedFlop } from "@rail/web-lib/solver";
export { solverLinkOf } from "@rail/web-lib/analysis/solverWalk";

// The desktop app's nodelock (`docs/NODELOCK.md` §5, `./nodelock/`): the
// library's slot, the decision's data the editor reads, and the suggestions.
export type { NodelockAt, NodelockMark, NodelockNode, NodelockOverride, SolverNodelock } from "@rail/web-solver/host";
export { actionColours, ComboText } from "@rail/web-solver/StrategyView";
// The library's own controls and stylesheet ("Studio"), so the slot's tools read as part of the screen.
export { ChevronDown, Chip, IconButton, LockGlyph, MixBar, Popover, Segmented, SignedBb, Switch, ToolButton } from "@rail/web-solver/ui";
export { default as solverStyles } from "@rail/web-solver/solver.module.css";
export { liveTurnCached, liveTurnId } from "@rail/web-solver/liveTurn";
export {
  classOfCombo,
  comboText,
  decodeChunk,
  DRAWS,
  exploreHistory,
  exploreNode,
  HAND_CLASSES,
  handFeatures,
  MADE_HANDS,
  rangesAt,
  type ExploreAction,
  type FlopChunk,
} from "@rail/web-lib/solver";
export { cardIndex } from "@rail/web-lib/equity";
// The native nodelock engine (`./nodelock/engine/native.ts`): how a turn lock runs.
export { LIVE_TURN } from "@rail/web-lib/solver";
export {
  availableArchetypes,
  nodelockSuggestEn,
  nodelockSuggestHr,
  suggestLocks,
  type Archetype,
  type NodeKind,
  type NodelockSuggestDict,
  type NodelockSuggestion,
  type SuggestContext,
} from "@rail/web-lib/solver/nodelockSuggest";
