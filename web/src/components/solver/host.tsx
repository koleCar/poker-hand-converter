/**
 * What the Solver library needs from the page it lives in: its strings, the
 * flop library's reader, and where a full solve is served. The web's
 * `/solver` provides them from Next (`WebSolverLibrary`: the dictionary, the
 * public bucket's URL); the desktop app provides its own (its language, the
 * files through Rust). Nothing under `components/solver` reaches Next, the
 * web's i18n or Supabase itself, so the app renders these components in
 * place, as it runs the web's analysis library (`app/src/solver/door.ts`).
 *
 * Where the page's own pieces go on the screen ("Studio", SV-A):
 *
 * ```
 * top row      [top] [Cash · 6-max · 100 bb ⌄] ··· [copy link: `link`]
 * action strip [Preflop] [Flop] [BB ▸ options + % · lockMark] … [Turn] …
 *              (the turn or river card picker under it)
 * banner       nodelock.banner(at)
 * toolbar      [Strategy + EV | Ranges] [range mode] [filter chips] ··· nodelock.nodeAction(at) nodelock.tabTools(at)
 * body         [side] │ grid                │ panel: who acts · pot, the mix bar, a row per action (lockMark,
 *                     │                     │ GTO's share when comparing), then Hand | Filters
 * ```
 *
 * The slot's controls should use the library's own (`ui.tsx`: `ToolButton`
 * with `tone="lock"`, `Switch`, `Segmented`, `IconButton`), so they read as
 * part of the toolbar.
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { FlopLibraryLoader } from "../../lib/analysis/flopLibrary";
import type { Dict } from "../../lib/i18n/types";
import type { FlopChunk, PickedFlop } from "../../lib/solver";
import type { SolverView } from "./SolverLibrary";

export type SolverDict = Dict["solver"];

export interface SolverHost {
  t: SolverDict;
  /** The flop library's reader; null when none is configured (the page says the library is unavailable). */
  loader: FlopLibraryLoader | null;
  /** Where full solves are served (`fullSolve.ts`), or null: turns are then solved live. */
  fullSolveBase: string | null;
  /**
   * The desktop app's nodelock (`docs/NODELOCK.md` §5): solved on the user's
   * own computer, so only the app sets it. The web never does, and then the
   * library shows no nodelock at all.
   */
  nodelock?: SolverNodelock;
  /** The start of the top row, before the table selector: the app's `Library | My nodelocks` switch. */
  top?: ReactNode;
  /** A column left of the body, under the toolbar: the app's My nodelocks tree. */
  side?: ReactNode;
  /** A link to a view, for the top row's copy button; none (no button) when the host has no address to give. */
  link?: (view: SolverView) => string | null;
  /**
   * Flops a day (the pricing round): asked before a flop's solve is loaded,
   * solved in full or walked to a turn. None (today's behaviour): every flop
   * opens. Preflop is never asked about.
   */
  flops?: SolverFlopGate;
  /** Pro tools shown locked at the toolbar's right end, where the nodelock's go (the web's Nodelock on Free). */
  lockedTools?: ReactNode;
}

/** Opening a flop: open, refused (today's flops are used), or sign in first. */
export type FlopGateAnswer = "open" | "refused" | "sign-in";

export interface SolverFlopGate {
  /** False while the host does not yet know whether flops are limited: no flop loads meanwhile. */
  ready: boolean;
  /**
   * Asked once per flop shown (the library's canonical key, `Ks7h2d`). Keep
   * it stable across renders: a new function asks again. A failure should
   * answer "open".
   */
  open: (flop: string) => Promise<FlopGateAnswer>;
  /**
   * The top row's "today's flops": `reopen(flop)` is the action that shows
   * one of them on the current line, or null when the line has no solve of it.
   */
  today?: (reopen: (flop: string) => (() => void) | null) => ReactNode;
  /** In place of the strategy when a flop does not open. */
  closed: (answer: Exclude<FlopGateAnswer, "open">, flop: string) => ReactNode;
}

/** Where the view is, for the nodelock slot: a heads-up library decision on the flop or a live turn. */
export interface NodelockAt {
  /** Chart set, library line id (`FLOP_LINES`) and the canonical flop key: the chunk's address. */
  set: string;
  line: string;
  flop: string;
  /** The preflop line as the view names it (`SolverView.line`). */
  preflop: string;
  /** The flop as picked, and the relabelling from the chunk's suits. */
  picked: PickedFlop;
  board: readonly string[];
  /** The library's own flop chunk (the GTO baseline). */
  library: FlopChunk;
  /** The chunk the decision is in, as shown: the flop's or a live turn's, locked or not. */
  chunk: FlopChunk;
  node: number;
  /** On a live turn: the flop chunk's deal and the card (chunk suits). */
  turn: { chance: number; card: string } | null;
  /** The shown chunk is the nodelock's, not the library's. */
  locked: boolean;
}

/** A locked solution shown in place of the library's (§5.4). */
export interface NodelockOverride {
  /** `set/line/flop`: the chunk it replaces. */
  key: string;
  /** Changes with the lock: part of the cache key of turns solved live from it. */
  id: string;
  /** A flop lock's solve, in place of the library chunk (its turns are then solved live from it). */
  flop: FlopChunk | null;
  /** A turn or river lock's solve, in place of one live turn (`liveTurnId`). */
  turn: { id: string; chunk: FlopChunk } | null;
}

/**
 * GTO at the decision on screen, for comparing a locked solution with it.
 * Actions pair by tree label; EV deltas are the locked solve's minus GTO's,
 * bb, for the actor (`compareWith` in `SolverLibrary.tsx`).
 */
export interface StrategyCompare {
  /** What the baseline is called, e.g. "GTO". */
  label: string;
  /** A change of share in words, e.g. `+7.5 pp`. */
  shareDelta: (delta: number) => string;
  /** Per action on screen: GTO's share of the range taking it, or null when GTO has no such action (a lock's own size). */
  shares: Array<number | null>;
  /** GTO's actions the decision on screen does not offer (a lock took them away), with GTO's share. */
  missing: Array<{ key: string; label: string; colour: string; share: number }>;
  /** Per grid class: its EV gain over GTO, bb, its combos weighed as they reach the decision now; null when none compares. */
  classes: Array<number | null>;
  /** A combo's EV gain over GTO (cards as shown, `AhKd`), bb, or null. */
  combo: (cards: string) => number | null;
  /** Per hand of the actor, in the shown solve's order: EV gain over GTO, bb; NaN where GTO has no such hand. */
  hands: Float64Array;
}

/**
 * A decision on the action strip or in the strategy panel, for the lock marks
 * (§7.3): any decision of the shown solve, not only the one on screen.
 */
export interface NodelockNode {
  /** The library's own flop chunk, and the flop's chunk as shown (the library's or a locked one). */
  library: FlopChunk;
  flop: FlopChunk;
  /** The chunk the decision is in: `flop`, or a live turn's. */
  chunk: FlopChunk;
  node: number;
  /** In a live turn's chunk: the flop chunk's deal and the card (chunk suits); null on the flop. */
  turn: { chance: number; card: string } | null;
  /** The flop as picked: the chunk's cards in the suits on screen. */
  picked: PickedFlop;
}

/** A locked decision's mark: which of its actions are locked, and the lock icon (with its popover) to draw. */
export interface NodelockMark {
  /** The locked actions' tree labels (`B1.82`). */
  actions: ReadonlySet<string>;
  /** The icon after a locked action's label (`action`), or on the decision card's corner (null). */
  render: (action: string | null) => ReactNode;
}

export interface SolverNodelock {
  /** The locked solution being shown, or null: the library's own. */
  override: NodelockOverride | null;
  /** Compare the locked decision with GTO (frequency and EV deltas). */
  compare: boolean;
  /** What the baseline is called in the comparison, and a change of share in words. */
  compareLabel: string;
  shareDelta: (delta: number) => string;
  /** The Nodelock action on the decision on screen: at the toolbar's right end, before `tabTools`. */
  nodeAction: (at: NodelockAt) => ReactNode;
  /** Between the action strip and the toolbar; `at` is null off a flop or turn decision. */
  banner: (at: NodelockAt | null) => ReactNode;
  /** At the right end of the toolbar (`Strategy + EV | Ranges` …): the Compare with GTO switch in My nodelocks. */
  tabTools?: (at: NodelockAt | null) => ReactNode;
  /** A decision's lock mark, or null when none of its actions is locked (§7.3). */
  lockMark?: (node: NodelockNode) => NodelockMark | null;
}

const HostContext = createContext<SolverHost | null>(null);

export function SolverHostProvider({ host, children }: { host: SolverHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useSolverHost(): SolverHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("the Solver library needs a SolverHostProvider");
  return host;
}

export function useSolverDict(): SolverDict {
  return useSolverHost().t;
}
