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

type Factory = () => NodelockEngine | null | Promise<NodelockEngine | null>;

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
    const workers = await factory("createWorkerEngine");
    return workers ? await workers() : null;
  })().catch(() => null);
  return picked;
}

/** What a solve will use, for the line under the Solve button. */
export interface EngineInfo {
  kind: NodelockEngine["kind"] | null;
  threads: number;
  cores: number;
  /** About this much memory at the peak, MB. */
  memoryMb: number;
}

/** Peak memory by street, MB (`docs/NODELOCK.md` §0: a flop solve peaks at 0.6–1.8 GB). */
const MEMORY_MB: Record<LockStreet, number> = { flop: 1200, turn: 250, river: 60 };

export async function engineInfo(street: LockStreet): Promise<EngineInfo> {
  const cores = Math.max(1, navigator.hardwareConcurrency || 1);
  const engine = await pickEngine();
  let memoryMb = MEMORY_MB[street];
  let total = cores;
  if (engine?.kind === "native") {
    try {
      const info = await invoke<{ cores?: number; threads?: number; memoryMb?: Partial<Record<LockStreet, number>> }>("nodelock_engine_info");
      total = info.cores ?? total;
      memoryMb = info.memoryMb?.[street] ?? memoryMb;
    } catch {
      // The estimate stands.
    }
  }
  return { kind: engine?.kind ?? null, threads: engine?.threads ?? Math.max(1, cores - 1), cores: total, memoryMb };
}
