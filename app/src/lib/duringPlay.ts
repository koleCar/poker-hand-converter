/**
 * A10 (guideline §7; plan R3.8, R3.10): no help during play. While the HUD
 * has any poker table open, the app hides whatever could help with the hand
 * being played - analysis, solver, equity and chart screens, and inside the
 * other screens the replayer's pot odds and the starting-hand chart. A
 * route that is one says so in {@link SCREEN_HELP} - (R5.4) the analysis:
 * the session review, the top leaks, the user's own charts and a hand's
 * decision-by-decision grades - and the shell (`App.tsx`) shows a notice in
 * its place while tables are open; (R3.10) the sidebar and the command
 * palette leave such a screen out, and its shortcut does nothing. Pure, so the tests run it
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
  // (R5.4) The session review, the top leaks, the own charts and a hand's grades.
  analysis: "analysis",
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

/**
 * (R3.10) Whether a screen is offered at all - in the sidebar, in the command
 * palette and by its Cmd/Ctrl + digit shortcut: not while a table is open if
 * it helps with play (the shell would only show the notice in its place).
 * `help` is the classification (tests pass their own).
 */
export function screenOffered(
  route: Route,
  tablesOpen: boolean,
  help: Readonly<Record<Route, PlayHelp | null>> = SCREEN_HELP,
): boolean {
  return !hiddenDuringPlay(help[route], tablesOpen);
}

/** The screens offered now, in their order (A10: the helping ones left out while a table is open). */
export function offeredScreens<S extends Route>(
  screens: readonly S[],
  tablesOpen: boolean,
  help: Readonly<Record<Route, PlayHelp | null>> = SCREEN_HELP,
): S[] {
  return screens.filter((screen) => screenOffered(screen, tablesOpen, help));
}
