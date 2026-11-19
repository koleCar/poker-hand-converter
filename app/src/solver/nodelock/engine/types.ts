/**
 * The nodelock engine's interface (`docs/NODELOCK.md` §2.4): what the
 * nodelock screen (workstream U) calls, whichever engine runs the solve -
 * the worker pool here, or the native one (`core/rail-solver`) later.
 */
import type { LockSet } from "./door";

export type { LockBase, LockEarlier, LockSet, NodeLockSpec, RangeLock } from "./door";

export interface NodelockProgress {
  iteration: number;
  /** The last measured exploitability of the locked game, % of the pot; null before the first measurement. */
  exploitabilityPct: number | null;
  elapsedMs: number;
  /** Time to the target at the current pace; null until two measurements give a pace. */
  etaMs: number | null;
  /** The solvers' arrays across every thread, MB. */
  memoryMb: number;
}

export interface NodelockRequest {
  lockSet: LockSet;
  /**
   * The chunk the lock is solved on: the library chunk of the lock's spot
   * (`lockSet.spot`), the bytes the Solver library shows, or for a based
   * lock (`lockSet.base`, §7.4) its base lock's result chunk as stored. A
   * flop lock freezes its earlier nodes at its strategies and checks it was
   * solved on the same ranges; a turn or river lock takes the ranges at the
   * deal from it.
   */
  baseline: Uint8Array;
  /** Default: the library profile's cap (flop), the live turn's (turn and river). */
  maxIterations?: number;
}

export interface NodelockStats {
  iterations: number;
  /** The locked game's exploitability reached, % of the pot. */
  exploitabilityPct: number;
  seconds: number;
  peakMb: number;
  threads: number;
  /** `"workers"` (TypeScript worker pool) or `"native"`. */
  engine: string;
  /** `true` when the solve went on from the previous lock's solver on the same spot. */
  warm: boolean;
}

export interface NodelockResult {
  /** `encodeChunk` bytes; `header.lockHash` is `lockHash(lockSet)`. A flop lock's is a flop-level chunk, a turn or river lock's the deal's whole turn game. */
  chunk: Uint8Array;
  stats: NodelockStats;
}

export interface NodelockEngine {
  kind: "workers" | "native";
  /** Threads a solve uses. */
  threads: number;
  /**
   * Solves a lock. Progress after every iteration; `signal` cancels (the
   * promise rejects with the signal's reason, an `AbortError` by default).
   * One solve at a time: a second call while one runs rejects.
   */
  solve(req: NodelockRequest, onProgress: (p: NodelockProgress) => void, signal: AbortSignal): Promise<NodelockResult>;
  /** Drops the warm solver and stops the workers (they start again on the next solve). */
  release(): void;
}

export { lockHash } from "./door";
