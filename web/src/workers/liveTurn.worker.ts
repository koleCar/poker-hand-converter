/**
 * Live turn worker (the Solver library): solves the turn and river below one
 * deal of a flop library chunk (`lib/solver/liveTurn.ts`), a few seconds on
 * one thread, off the main thread so the page stays responsive. One job at a
 * time; the page terminates the worker to cancel one.
 */

import { solveLiveTurn, type FlopChunk, type SolveResult } from "../lib/solver";

export interface LiveTurnRequest {
  id: number;
  chunk: FlopChunk;
  chance: number;
  card: string;
}

export type LiveTurnResponse =
  | { id: number; type: "progress"; iteration: number; exploitabilityPct: number | null }
  | { id: number; type: "done"; result: SolveResult; ms: number }
  | { id: number; type: "error"; message: string };

const post = (message: LiveTurnResponse) => self.postMessage(message);

self.onmessage = (event: MessageEvent<LiveTurnRequest>) => {
  const { id, chunk, chance, card } = event.data;
  const started = performance.now();
  try {
    const result = solveLiveTurn(chunk, chance, card, (p) => post({ id, type: "progress", ...p }));
    post({ id, type: "done", result, ms: performance.now() - started });
  } catch (error) {
    post({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
