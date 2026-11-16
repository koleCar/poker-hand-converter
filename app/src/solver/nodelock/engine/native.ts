/**
 * The native nodelock engine (`docs/NODELOCK.md` §2.5): the solve runs in
 * Rust (`core/rail-solver`, `app/src-tauri/src/nodelock_solve.rs`) on this
 * computer's cores, off the window's thread.
 *
 * The window builds the reference's game (`nodelockSpotOf`: the library
 * job's flop spot, or the deal's live turn for a turn or river lock, its
 * isomorphism limited to what the lock keeps) and sends it with the lock;
 * Rust runs `solveNodelock`'s steps and answers the same chunk bytes
 * (`nodelockHeader`, `lockHash` in it; a turn lock's chunk holds the turn
 * game).
 *
 * `invoke` and `listen` are called here directly, as `lib/ipc.ts` does.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { LIVE_TURN } from "../../door";
import type { NodelockEngine, NodelockProgress, NodelockStats } from "../contract";
import { decodeChunk, loadChartSet, nodelockFlopRun, nodelockHeader, nodelockSpotOf, type LockSet } from "./door";

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
const rangeBits = (range: unknown): string => base64(new Uint8Array(Float64Array.from(range as ArrayLike<number>).buffer));

/**
 * The request `nodelock_solve_start` takes (`rail_solver::nodelock::NodelockRequest`):
 * the reference's game (`nodelockSpotOf`: the library job's flop spot from
 * the chart set, or the deal's live turn), its run settings and the result's
 * header (`nodelockHeader`), the library chunk as the flop's baseline.
 */
export async function nativeRequest(lockSet: LockSet, baseline: Uint8Array, maxIterations?: number) {
  const chunk = decodeChunk(baseline);
  const header = JSON.stringify(nodelockHeader(chunk.header, lockSet));
  if (lockSet.nodes.every((node) => node.street === "flop")) {
    const charts = await loadChartSet(lockSet.spot.set);
    const { spot } = nodelockSpotOf(lockSet, chunk, charts);
    const run = nodelockFlopRun(lockSet, maxIterations);
    return {
      spot: { ...spot, ranges: [rangeBits(spot.ranges[0]), rangeBits(spot.ranges[1])] },
      lockSet,
      baseline: base64(baseline),
      header,
      options: { maxIterations: run.maxIterations, targetPct: run.targetExploitability, checkFrom: run.checkFrom, checkEvery: run.checkEvery, dcfr: run.dcfr },
    };
  }
  const { spot } = nodelockSpotOf(lockSet, chunk);
  return {
    spot: { ...spot, ranges: [rangeBits(spot.ranges[0]), rangeBits(spot.ranges[1])] },
    lockSet,
    // A turn lock's earlier nodes keep the unlocked live turn, which the engine solves first.
    baseline: null,
    header,
    options: {
      maxIterations: maxIterations ?? LIVE_TURN.maxIterations,
      targetPct: lockSet.targetPct,
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
