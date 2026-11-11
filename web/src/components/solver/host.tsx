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

export type SolverDict = Dict["solver"];

export interface SolverHost {
  t: SolverDict;
  /** The flop library's reader; null when none is configured (the page says the library is unavailable). */
  loader: FlopLibraryLoader | null;
  /** Where full solves are served (`fullSolve.ts`), or null: turns are then solved live. */
  fullSolveBase: string | null;
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
