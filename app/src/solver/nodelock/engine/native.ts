/**
 * The native nodelock engine (`docs/NODELOCK.md` §2.5): the solve runs in
 * Rust (`core/rail-solver`, `app/src-tauri/src/nodelock_solve.rs`) on this
 * computer's cores, off the window's thread.
 *
 * The window builds the game's spot from the library chunk it already has
 * and sends it with the lock:
 *
 * - a flop lock solves the chunk's own flop: its ranges (the chunk's hands
 *   and weights), pot, stack and rake, on the library's tree (`FLOP_PROFILE`);
 * - a turn or river lock (`X-X~Kd/B2.5`, §5.6) solves the live turn of that
 *   deal and card, as the Solver library's live turn does (`liveTurnSpot`).
 *
 * The result is a chunk in the library's layout, under the library chunk's
 * header with the lock's target and `lockHash` added. A turn or river lock's
 * chunk holds the live turn's solve (`street: "turn"`).
 *
 * `invoke` and `listen` are called here directly, as `lib/ipc.ts` does.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodeChunk, FLOP_PROFILE, LIVE_TURN, liveTurnSpot, NUM_COMBOS, type FlopChunk } from "../../door";
import { lockHashOf, type LockSet, type NodelockEngine, type NodelockProgress, type NodelockStats } from "../contract";

/** `nodelock_engine_info`. */
export interface NativeEngineInfo {
  /** Threads a solve uses: all cores but one. */
  threads: number;
  cores: number;
  /** Apple silicon's performance and efficiency cores; null elsewhere. */
  coresPerformance: number | null;
  coresEfficiency: number | null;
  totalMemoryMb: number | null;
  /** About this much at a solve's peak, MB. */
  memoryMb: { flop: number; turn: number; river: number };
}

interface ProgressEvent extends NodelockProgress {
  id: string;
}

interface DoneEvent {
  id: string;
  ok: boolean;
  error: string | null;
  stats: (NodelockStats & { storage: string; stoppedBy: string }) | null;
}

const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let k = 0; k < bytes.length; k += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  }
  return btoa(text);
};

/** A 1,326-weight range as the engine reads it exactly: little-endian f64 bytes, base64. */
const rangeBits = (range: ArrayLike<number>): string => base64(new Uint8Array(Float64Array.from(range).buffer));

/** The flop of a chunk as a spot: its hands' weights, on the library's tree. */
function flopSpot(chunk: FlopChunk) {
  const { result, header } = chunk;
  const ranges = [0, 1].map((p) => {
    const range = new Float64Array(NUM_COMBOS);
    result.hands[p].forEach((combo, i) => {
      range[combo] = result.weights[p][i];
    });
    return rangeBits(range);
  });
  const p = FLOP_PROFILE;
  return {
    board: result.board,
    ranges,
    pot: header.pot,
    stack: header.stack,
    firstToAct: result.firstToAct,
    menus: [p.flopMenu, p.flopMenu],
    raiseCap: p.flopRaiseCap,
    turnMenus: [p.turnMenu, p.turnMenu],
    turnRaiseCap: p.turnRaiseCap,
    riverMenus: [p.riverMenu, p.riverMenu],
    riverRaiseCap: p.riverRaiseCap,
    allInThreshold: p.allInThreshold,
    minBet: p.minBet,
    rake: { percent: header.rake.percent, cap: header.rake.cap },
    bigBlind: 1,
    isomorphism: true,
  };
}

/** A turn or river lock's address: the deal's path and the turn card (`X-X~Kd/B2.5`). */
function dealOf(path: string): { deal: string; card: string } | null {
  const tilde = path.indexOf("~");
  if (tilde < 0) return null;
  const slash = path.indexOf("/", tilde);
  return { deal: path.slice(0, tilde), card: path.slice(tilde + 1, slash < 0 ? undefined : slash) };
}

/** The request `nodelock_solve_start` takes (`rail_solver::nodelock::NodelockRequest`). */
export async function nativeRequest(lockSet: LockSet, baseline: Uint8Array, maxIterations?: number) {
  const chunk = decodeChunk(baseline);
  const first = lockSet.nodes[0];
  if (!first) throw new Error("a lock set with no node");
  const at = dealOf(first.path);
  const target = lockSet.targetPct;
  const header = JSON.stringify({ ...chunk.header, targetPct: target, lockHash: await lockHashOf(lockSet) });
  if (!at) {
    return {
      spot: flopSpot(chunk),
      lockSet,
      baseline: base64(baseline),
      header,
      options: {
        maxIterations: maxIterations ?? FLOP_PROFILE.maxIterations,
        targetPct: target,
        checkFrom: 20,
        checkEvery: 10,
        dcfr: FLOP_PROFILE.dcfr,
      },
    };
  }
  const chance = chunk.result.nodes.findIndex((node) => node.kind === "chance" && node.path === at.deal);
  if (chance < 0) throw new Error(`the chunk has no deal at ${JSON.stringify(at.deal)}`);
  const spot = liveTurnSpot(chunk, chance, at.card);
  return {
    spot: { ...spot, ranges: [rangeBits(spot.ranges[0] as ArrayLike<number>), rangeBits(spot.ranges[1] as ArrayLike<number>)] },
    lockSet,
    // The baseline of a turn's earlier nodes is the unlocked live turn, which the engine solves first.
    baseline: null,
    header,
    options: {
      maxIterations: maxIterations ?? LIVE_TURN.maxIterations,
      targetPct: target,
      checkFrom: LIVE_TURN.checkFrom,
      checkEvery: LIVE_TURN.checkEvery,
      dcfr: LIVE_TURN.dcfr,
    },
  };
}

export function nativeEngineInfo(): Promise<NativeEngineInfo> {
  return invoke<NativeEngineInfo>("nodelock_engine_info");
}

/** The native engine, or null outside the app or in a build without it. */
export async function createNativeEngine(): Promise<NodelockEngine | null> {
  if (!isTauri()) return null;
  let info: NativeEngineInfo;
  try {
    info = await nativeEngineInfo();
  } catch {
    return null;
  }
  return {
    kind: "native",
    threads: info.threads,
    async solve(req, onProgress, signal) {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      const request = await nativeRequest(req.lockSet, req.baseline, req.maxIterations);
      // Listen first: the solve may report before `start` answers.
      let id: string | null = null;
      const early: (ProgressEvent | DoneEvent)[] = [];
      let settle: ((done: DoneEvent) => void) | null = null;
      const finished = new Promise<DoneEvent>((resolve) => {
        settle = resolve;
      });
      const onEvent = (event: ProgressEvent | DoneEvent, done: boolean) => {
        if (id === null) {
          early.push(event);
          return;
        }
        if (event.id !== id) return;
        if (done) settle?.(event as DoneEvent);
        else {
          const { id: _id, ...progress } = event as ProgressEvent;
          void _id;
          onProgress(progress);
        }
      };
      const unlisten: UnlistenFn[] = await Promise.all([
        listen<ProgressEvent>("nodelock://progress", (e) => onEvent(e.payload, false)),
        listen<DoneEvent>("nodelock://done", (e) => onEvent(e.payload, true)),
      ]);
      const abort = () => {
        if (id !== null) void invoke<boolean>("nodelock_solve_cancel", { id });
      };
      signal.addEventListener("abort", abort);
      try {
        id = await invoke<string>("nodelock_solve_start", { req: request });
        for (const event of early.splice(0)) onEvent(event, "ok" in event);
        if (signal.aborted) abort();
        const done = await finished;
        if (!done.ok || !done.stats) {
          throw signal.aborted || done.error === "cancelled"
            ? new DOMException("cancelled", "AbortError")
            : new Error(done.error ?? "the native solve failed");
        }
        const bytes = new Uint8Array(await invoke<ArrayBuffer>("nodelock_solve_result", { id }));
        if (!bytes.length) throw new Error("the native solve left no chunk");
        const { iterations, exploitabilityPct, seconds, peakMb, threads } = done.stats;
        return { chunk: bytes, stats: { iterations, exploitabilityPct, seconds, peakMb, threads, engine: "native" } };
      } finally {
        signal.removeEventListener("abort", abort);
        for (const stop of unlisten) stop();
      }
    },
  };
}
