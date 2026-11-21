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
 * **Warm start.** The app process keeps the last spot's solver: the next
 * lock on the same spot goes on from it (`stats.warm`), a lock on another
 * spot frees it first, and `release()` frees it (`nodelock_release`).
 *
 * `invoke` and `listen` are called here directly, as `lib/ipc.ts` does.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { decodeChunk, loadChartSet, lockGameStreet, nodelockSpotOf, type LockSet } from "./door";
import { nativeRequestOf, type NativeRequest } from "./request";
import { speedStorage, speedThreads, type SolveSpeed } from "./speed";
import type { NodelockEngine, NodelockProgress, NodelockStats } from "./types";

export { nativeRequestOf, type NativeRequest } from "./request";

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

/**
 * The request `nodelock_solve_start` takes (`rail_solver::nodelock::NodelockRequest`):
 * the reference's game (`nodelockSpotOf`: the library job's flop spot from
 * the chart set, or the deal's live turn), its run settings and the result's
 * header (`nodelockHeader`), the library chunk as the flop's baseline
 * (`nativeRequestOf`). A based lock (§7.4) passes its base lock's chunk as
 * `baseline`: the deal's ranges and the earlier nodes come from it, and Rust
 * needs no change (its warm key holds the spot's ranges and the baseline).
 */
export async function nativeRequest(lockSet: LockSet, baseline: Uint8Array, maxIterations?: number): Promise<NativeRequest> {
  const chunk = decodeChunk(baseline);
  const charts = lockSet.nodes.every((node) => node.street === "flop") ? await loadChartSet(lockSet.spot.set) : undefined;
  return nativeRequestOf(lockSet, baseline, chunk, nodelockSpotOf(lockSet, chunk, charts), maxIterations);
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
  let busy = false;
  return {
    kind: "native",
    threads: info.threads,
    // The app process keeps the last spot's solver for a warm start; this frees it.
    release() {
      void invoke<void>("nodelock_release").catch(() => {});
    },
    async solve(req, onProgress, signal) {
      if (busy) throw new Error("a nodelock solve is already running");
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      busy = true;
      try {
        return await solveNative(req, info.cores, onProgress, signal);
      } finally {
        busy = false;
      }
    },
  };
}

/**
 * The request with the speed's threads and, for a flop lock, its storage
 * (`speed.ts`, #409). Rust's own defaults (all cores but one, float32 when it
 * fits the memory) stand without a speed.
 */
export function withSpeed(request: NativeRequest, lockSet: LockSet, speed: SolveSpeed | undefined, cores: number): NativeRequest {
  if (!speed) return request;
  const storage = lockGameStreet(lockSet) === "flop" ? speedStorage(speed) : null;
  return { ...request, threads: speedThreads(speed, cores), ...(storage ? { storage } : {}) };
}

async function solveNative(
  req: Parameters<NodelockEngine["solve"]>[0],
  cores: number,
  onProgress: (p: NodelockProgress) => void,
  signal: AbortSignal,
): ReturnType<NodelockEngine["solve"]> {
  const request = withSpeed(await nativeRequest(req.lockSet, req.baseline, req.maxIterations), req.lockSet, req.speed, cores);
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
    const { iterations, exploitabilityPct, seconds, peakMb, threads, warm } = done.stats;
    return { chunk: bytes, stats: { iterations, exploitabilityPct, seconds, peakMb, threads, engine: "native", warm } };
  } finally {
    signal.removeEventListener("abort", abort);
    for (const stop of unlisten) stop();
  }
}
