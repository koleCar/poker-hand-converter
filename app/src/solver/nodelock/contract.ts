/**
 * The nodelock's shared shapes, as `docs/NODELOCK.md` states them: the lock
 * (§1), the engine (§2.4) and the stored row (§3). The UI codes against these;
 * the other workstreams' modules implement them (the lock model in
 * `web/src/lib/solver/nodelock.ts`, the engines in `./engine/`, the store
 * behind `nodelock_*` commands).
 */

import { lockHash, type LockSet } from "./engine/types";

export type LockStreet = "flop" | "turn" | "river";

/**
 * The lock model is §1's (`web/src/lib/solver/nodelock.ts`, through the
 * engine's door). A node's address: on the flop, the flop chunk's node path
 * (`X-B1.82`); on a turn or a river, the flop chunk's deal path, the turn
 * card and the live turn's node path: `X-X~Kd/B2.5` (`lockPath`).
 */
export type { LockBase, LockEarlier, LockSet, NodeLockSpec } from "./engine/types";

export interface NodelockProgress {
  iteration: number;
  exploitabilityPct: number | null;
  elapsedMs: number;
  etaMs: number | null;
  memoryMb: number;
}

export interface NodelockStats {
  iterations: number;
  exploitabilityPct: number;
  seconds: number;
  peakMb: number;
  threads: number;
  engine: string;
}

export interface NodelockEngine {
  kind: "workers" | "native";
  threads: number;
  solve(
    /** `baseline`: the library chunk of the lock's spot, its bytes as served. */
    req: { lockSet: LockSet; baseline: Uint8Array; maxIterations?: number },
    onProgress: (p: NodelockProgress) => void,
    signal: AbortSignal,
  ): Promise<{ chunk: Uint8Array; stats: NodelockStats }>;
  /** Frees the solver kept for a warm start (the native one holds ~1–3 GB). */
  release?(): void;
}

/**
 * What the UI keeps in `summary_json`: where the lock was made (to open it
 * again on the same view) and the headline numbers for the list.
 */
export interface NodelockSummary {
  view: { set: string; line: string; flop: string; node: number; turn?: string };
  /** The locked node's position, e.g. `BTN`, and its players, out of position first. */
  position: string;
  players: [string, string];
  /** The decisions before the locked one on its street, in words (`BB Check`). */
  steps?: string[];
  /** Per action of the locked node: its label in words, GTO's share and the lock's. */
  shifts: Array<{ label: string; gto: number; locked: number }>;
}

/** §1's lock hash: sha-256 hex of the lock's canonical JSON (`lockHash`). */
export async function lockHashOf(set: LockSet): Promise<string> {
  return lockHash(set);
}
