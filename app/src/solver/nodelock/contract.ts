/**
 * The nodelock's shared shapes, as `docs/NODELOCK.md` states them: the lock
 * (§1), the engine (§2.4) and the stored row (§3). The UI codes against these;
 * the other workstreams' modules implement them (the lock model in
 * `web/src/lib/solver/nodelock.ts`, the engines in `./engine/`, the store
 * behind `nodelock_*` commands).
 */

export type LockEarlier = "none" | "player" | "all";

export type LockStreet = "flop" | "turn" | "river";

export interface NodeLockSpec {
  street: LockStreet;
  /**
   * The node's address. On the flop, the flop chunk's node path (`X-B1.82`);
   * on a turn or a river, the flop chunk's deal path, the turn card and the
   * live turn's node path: `X-X~Kd/B2.5` (`lockPath`).
   */
  path: string;
  player: 0 | 1;
  actions: string[];
  /** `[action][combo]` over the 1,326 canonical combos. */
  strategy: number[][];
  /** 1,326 flags: 1 = fixed, 0 = adapts. */
  locked: number[];
}

export interface LockSet {
  version: 1;
  spot: { set: string; line: string; flop: string; turn?: string; river?: string };
  nodes: NodeLockSpec[];
  earlier: LockEarlier;
  /** 1 = standard, 2.5 = quick. */
  targetPct: number;
}

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
    req: { lockSet: LockSet; maxIterations?: number },
    onProgress: (p: NodelockProgress) => void,
    signal: AbortSignal,
  ): Promise<{ chunk: Uint8Array; stats: NodelockStats }>;
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

/** §1's canonical JSON hash, until the lock model's `lockHash` is in: sha-256 hex of the JSON. */
export async function lockHashOf(set: LockSet): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(set));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
