/**
 * A10 (guideline §7; plan R3.8, R3.10): no help during play. While the HUD
 * has any poker table open, the app hides whatever could help with the hand
 * being played - analysis, solver, equity and chart screens, and inside the
 * other screens the replayer's pot odds and the starting-hand chart. The
 * desktop app has no analysis, solver, equity or chart screen yet (R5.4
 * brings the analysis in): a route that is one says so in
 * {@link SCREEN_HELP}, and the shell (`App.tsx`) shows a notice in its
 * place while tables are open. Pure, so the tests run it
 * (`tests/test/appDuringPlay.test.ts`); whether tables are open is
 * `useTablesOpen`.
 */
import type { Route } from "./router";

/** What A10 hides during play. */
export type PlayHelp = "analysis" | "solver" | "equity" | "charts" | "potOdds" | "handChart";

export const PLAY_HELP: readonly PlayHelp[] = ["analysis", "solver", "equity", "charts", "potOdds", "handChart"];

/**
 * Each route's kind of help, `null` for a screen that gives none during
 * play. Every route must say (the type makes a new screen choose).
 */
export const SCREEN_HELP: Readonly<Record<Route, PlayHelp | null>> = {
  today: null,
  hands: null,
  reports: null,
  players: null,
  hud: null,
  settings: null,
  setup: null,
};

/** Whether `help` is hidden now: always while a poker table is open, never otherwise. */
export function hiddenDuringPlay(help: PlayHelp | null, tablesOpen: boolean): boolean {
  return tablesOpen && help !== null;
}

/** Whether the route's screen is replaced by the "hidden during play" notice. */
export function screenHiddenDuringPlay(route: Route, tablesOpen: boolean): boolean {
  return hiddenDuringPlay(SCREEN_HELP[route], tablesOpen);
}
