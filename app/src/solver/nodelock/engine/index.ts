/**
 * The nodelock engine (`docs/NODELOCK.md` §2.4–2.5), for the nodelock screen:
 *
 * ```ts
 * const engine = createWorkerEngine();
 * const { chunk, stats } = await engine.solve({ lockSet, baseline }, onProgress, controller.signal);
 * ```
 */
export { createWorkerEngine, defaultThreads, etaOf, type WorkerEngineOptions } from "./engine";
export { lockHash, type LockBase, type LockEarlier, type LockSet, type NodeLockSpec, type NodelockEngine, type NodelockProgress, type NodelockRequest, type NodelockResult, type NodelockStats } from "./types";
