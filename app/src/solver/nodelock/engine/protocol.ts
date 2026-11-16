/**
 * Messages between the engine (the window's thread) and its workers.
 * Typed arrays cross by structured clone; the workers' answers transfer
 * their value buffers (no SharedArrayBuffer: the webview is not
 * cross-origin isolated). Values stay float64: the parallel solve is the
 * sequential one bit for bit only if the sums are taken at full precision.
 */
import type { LockSet, NodelockSolve, SplitSpec, SplitStep, UnitValues } from "./door";

export type EngineRequest =
  /** Build this worker's part of a split flop solve: its turn cards' subtrees. */
  | { type: "part"; id: number; key: string; spec: SplitSpec; cards: number[] }
  /** One traversal of the split solve. */
  | { type: "traverse"; id: number; step: SplitStep }
  /** A warm start: drop the part's average strategy (the coordinator restarts its own). */
  | { type: "restart"; id: number; iteration: number }
  /** A turn or river lock, solved whole in this worker (`solveNodelock`). */
  | { type: "turn"; id: number; lockSet: LockSet; baseline: Uint8Array; maxIterations?: number };

export type EngineResponse =
  | { type: "ready"; id: number; bytes: number; valueSum: number | null }
  | { type: "values"; id: number; values: UnitValues }
  | { type: "restarted"; id: number }
  | { type: "progress"; id: number; iteration: number; exploitabilityPct: number | null; memoryMb: number }
  | { type: "turned"; id: number; chunk: Uint8Array; stats: NodelockSolve["stats"]; warm: boolean }
  | { type: "error"; id: number; message: string };
