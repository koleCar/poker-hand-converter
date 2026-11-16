/**
 * What the Solver library needs from the page it lives in: its strings, the
 * flop library's reader, and where a full solve is served. The web's
 * `/solver` provides them from Next (`WebSolverLibrary`: the dictionary, the
 * public bucket's URL); the desktop app provides its own (its language, the
 * files through Rust). Nothing under `components/solver` reaches Next, the
 * web's i18n or Supabase itself, so the app renders these components in
 * place, as it runs the web's analysis library (`app/src/solver/door.ts`).
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { FlopLibraryLoader } from "../../lib/analysis/flopLibrary";
import type { Dict } from "../../lib/i18n/types";
import type { FlopChunk, PickedFlop } from "../../lib/solver";

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

/** GTO at the decision on screen, for comparing a locked solution with it: the same actions, in order. */
export interface StrategyCompare {
  /** What the baseline is called, e.g. "GTO". */
  label: string;
  /** A change of share in words, e.g. `+7.5 pp`. */
  shareDelta: (delta: number) => string;
  /** Share of the range taking each action. */
  shares: number[];
  /** Per grid class: the mix and the EV per action, and the class's EV. */
  classes: Array<{ freq: number[]; ev: number[]; value: number }>;
}

export interface SolverNodelock {
  /** The locked solution being shown, or null: the library's own. */
  override: NodelockOverride | null;
  /** Compare the locked decision with GTO (frequency and EV deltas). */
  compare: boolean;
  /** What the baseline is called in the comparison, and a change of share in words. */
  compareLabel: string;
  shareDelta: (delta: number) => string;
  /** The Nodelock action on the node card. */
  nodeAction: (at: NodelockAt) => ReactNode;
  /** Above the view (the Nodelocked banner); `at` is null off a flop or turn decision. */
  banner: (at: NodelockAt | null) => ReactNode;
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
