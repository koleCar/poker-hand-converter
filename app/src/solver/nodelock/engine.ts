/**
 * Which engine solves a nodelock on this computer (`docs/NODELOCK.md` §2.5):
 * the native one when this build has it, else the pool of workers in the
 * window. Both are found here, so the screens only see a `NodelockEngine`
 * and the line that says what it will use.
 *
 * The engines live in `./engine/`: the worker pool's `createWorkerEngine()`
 * and the native engine's `createNativeEngine()` (with `nodelock_engine_info`
 * from Rust). A build without one simply does not offer it.
 */
import { invoke } from "@tauri-apps/api/core";

import { inApp } from "../../lib/ipc";
import type { LockStreet, NodelockEngine } from "./contract";
import { SOLVE_SPEEDS, speedStorage, speedThreads, type SolveSpeed } from "./engine/speed";

export { loadSpeed, saveSpeed, SOLVE_SPEEDS, type SolveSpeed } from "./engine/speed";

type Factory = (options?: { threads?: number }) => NodelockEngine | null | Promise<NodelockEngine | null>;

/** The engines' modules, loaded when a solve first needs one (the worker entries are theirs to start). */
const MODULES = import.meta.glob<Record<string, unknown>>(["./engine/*.ts", "!./engine/*worker*.ts", "!./engine/*.test.ts"]);

async function factory(name: string): Promise<Factory | null> {
  for (const load of Object.values(MODULES)) {
    const module = await load();
    if (typeof module[name] === "function") return module[name] as Factory;
  }
  return null;
}

let provided: NodelockEngine | null | undefined;

/** An engine set from outside (a preview of the screens); `undefined` goes back to finding one. */
export function provideEngine(engine: NodelockEngine | null | undefined): void {
  provided = engine;
  picked = null;
}

let picked: Promise<NodelockEngine | null> | null = null;

/** The native engine when present, else the workers; null when neither is in this build. */
export function pickEngine(): Promise<NodelockEngine | null> {
  if (provided !== undefined) return Promise.resolve(provided);
  picked ??= (async () => {
    if (inApp) {
      const native = await factory("createNativeEngine");
      const engine = native ? await native() : null;
      if (engine) return engine;
    }
    // A pool as large as Fast needs (every core); Slow and Medium use fewer of its workers.
    const workers = await factory("createWorkerEngine");
    return workers ? await workers({ threads: Math.max(1, navigator.hardwareConcurrency || 2) }) : null;
  })().catch(() => null);
  return picked;
}

/** What a solve will use at a speed, for the Speed choice under the Solve button. */
export interface SpeedInfo {
  threads: number;
  /** About this much memory at the peak, MB. */
  memoryMb: number;
}

export interface EngineInfo {
  kind: NodelockEngine["kind"] | null;
  cores: number;
  speeds: Record<SolveSpeed, SpeedInfo>;
}

/** A native flop solve's peak with 16-bit storage, MB (`docs/NODELOCK.md` §0: ~1.1 GB, float32 ~3.1 GB). */
const NATIVE_FLOP_I16_MB = 1100;

/**
 * The worker engine's peak by street, MB, on `threads` workers: a flop lock's
 * split grows with its parts (§0: 1.11 GB on one thread, 1.46 GB on six).
 */
function workersMb(street: LockStreet, threads: number): number {
  return street === "flop" ? 1050 + 70 * threads : street === "turn" ? 250 : 60;
}

export async function engineInfo(street: LockStreet): Promise<EngineInfo> {
  const engine = await pickEngine();
  let cores = Math.max(1, navigator.hardwareConcurrency || 1);
  // Float32 when it fits (Fast on the native engine): Rust says how much that takes here.
  let nativeMb: Record<LockStreet, number> = { flop: 3100, turn: 150, river: 20 };
  if (engine?.kind === "native") {
    try {
      const info = await invoke<{ cores?: number; memoryMb?: Partial<Record<LockStreet, number>> }>("nodelock_engine_info");
      cores = info.cores ?? cores;
      nativeMb = { ...nativeMb, ...info.memoryMb };
    } catch {
      // The estimate stands.
    }
  }
  const speeds = Object.fromEntries(
    SOLVE_SPEEDS.map((speed) => {
      const threads = speedThreads(speed, cores);
      const memoryMb = engine?.kind === "native" ? (speedStorage(speed) === "i16" && street === "flop" ? NATIVE_FLOP_I16_MB : nativeMb[street]) : workersMb(street, street === "flop" ? threads : 1);
      return [speed, { threads, memoryMb }];
    }),
  ) as Record<SolveSpeed, SpeedInfo>;
  return { kind: engine?.kind ?? null, cores, speeds };
}
