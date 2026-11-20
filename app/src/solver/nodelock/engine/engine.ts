/**
 * The worker engine (`docs/NODELOCK.md` §2.5): a nodelock solved on this
 * computer, in a pool of `hardwareConcurrency - 1` module workers.
 *
 * ```
 * window thread                               workers (one part each)
 *   the flop: SplitCoordinator  ── reach ──▶  SplitPart: its turn cards' subtrees
 *   locks frozen, run, result   ◀─ values ──  (kept for the next lock: warm start)
 * ```
 *
 * - **Flop locks** run split (`split.ts`): the window's thread walks only
 *   the flop's few dozen decisions per traversal; every turn subtree is in
 *   a worker. The result is bit for bit the sequential reference's
 *   (`solveNodelock`) at the same iteration count.
 * - **Turn and river locks** are a turn game: small, solved whole in one
 *   worker of their own, which a cancel terminates.
 * - **Warm start.** The parts and the coordinator of the last flop spot
 *   stay in memory; the next lock on the same spot keeps their regrets and
 *   restarts the average (`NODELOCK_WARM_ITERATION`). `release()` drops them.
 */
import {
  applyNodelock,
  checkBase,
  checkBaseline,
  chunkBaseline,
  decodeChunk,
  driveAsync,
  encodeChunk,
  loadChartSet,
  lockGameStreet,
  NODELOCK_WARM_ITERATION,
  nodelockFlopRun,
  nodelockHeader,
  NodelockError,
  nodelockSpotOf,
  rangesHash,
  SplitCoordinator,
  splitCards,
  type FlopChunk,
  type FlopSpot,
  type LockSet,
  type SplitSpec,
  type SplitStep,
  type UnitValues,
} from "./door";
import { defaultWorker, WorkerPool, type MakeWorker } from "./pool";
import type { EngineResponse } from "./protocol";
import type { NodelockEngine, NodelockProgress, NodelockRequest, NodelockResult } from "./types";

export interface WorkerEngineOptions {
  /** Workers in the pool; default `navigator.hardwareConcurrency - 1` (at least 1). */
  threads?: number;
  /** Tests replace the workers. */
  makeWorker?: MakeWorker;
  /** Loads a chart set by id (a flop lock's ranges); default the web library's `loadChartSet`. */
  loadCharts?: typeof loadChartSet;
  /** The flop spot of a flop lock; default `nodelockSpotOf` on the lock's chart set. Tests give a small one. */
  flopSpotOf?: (lockSet: LockSet, baseline: FlopChunk) => Promise<{ spot: FlopSpot; chartsHash: string }>;
  now?: () => number;
}

/** The threads a pool uses by default: every core but one, which keeps the window responsive. */
export function defaultThreads(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  return Math.max(1, (cores || 2) - 1);
}

/** The pace of a solve and the time to its target (a power law through the last two measurements). */
export function etaOf(
  measurements: readonly { iteration: number; pct: number }[],
  iteration: number,
  msPerIteration: number,
  target: number,
  maxIterations: number,
): number | null {
  if (measurements.length < 2 || !(msPerIteration > 0)) return null;
  const a = measurements[measurements.length - 2];
  const b = measurements[measurements.length - 1];
  if (b.pct <= target) return 0;
  let finish = maxIterations;
  if (a.pct > b.pct && b.iteration > a.iteration && b.pct > 0) {
    const k = Math.log(a.pct / b.pct) / Math.log(b.iteration / a.iteration);
    if (k > 0) finish = Math.min(maxIterations, b.iteration * Math.pow(b.pct / target, 1 / k));
  }
  return Math.max(0, finish - iteration) * msPerIteration;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The nodelock solve was cancelled", "AbortError");
}

/**
 * The cache key of a flop spot's split solve: what the parts' games are built
 * from. A range lock (§9) changes the game's ranges: its hash is in the key.
 */
function spotKey(lockSet: LockSet, spec: SplitSpec, chartsHash: string): string {
  const ranges = rangesHash(lockSet.ranges);
  return JSON.stringify([lockSet.spot.set, chartsHash, lockSet.spot.line, lockSet.spot.flop, spec.spot.symmetry ?? null, spec.dcfr ?? null, spec.storage, spec.spot.nodeActions ?? null, ranges]);
}

interface Warm {
  key: string;
  coordinator: SplitCoordinator;
  parts: number;
  partBytes: number;
}

/** The worker engine: `NodelockEngine` over a pool of module workers (workstream U's factory). */
export function createWorkerEngine(options: WorkerEngineOptions = {}): NodelockEngine {
  const threads = Math.max(1, Math.floor(options.threads ?? defaultThreads()));
  const make = options.makeWorker ?? defaultWorker;
  const pool = new WorkerPool(threads, make);
  // Turn and river locks: a worker of their own, so a cancel can terminate it without losing the flop's parts.
  const turnPool = new WorkerPool(1, () => make(threads));
  const loadCharts = options.loadCharts ?? loadChartSet;
  const flopSpotOf =
    options.flopSpotOf ??
    (async (lockSet: LockSet, baseline: FlopChunk) => {
      const charts = await loadCharts(lockSet.spot.set);
      const spot = nodelockSpotOf(lockSet, baseline, charts);
      if (spot.street !== "flop") throw new Error("not a flop lock");
      return { spot: spot.spot, chartsHash: charts.model.hash };
    });
  const now = options.now ?? (() => performance.now());
  let warm: Warm | null = null;
  let busy = false;

  const release = () => {
    warm = null;
    pool.stop();
    turnPool.stop();
  };

  async function solveFlop(req: NodelockRequest, onProgress: (p: NodelockProgress) => void, signal: AbortSignal, started: number): Promise<NodelockResult> {
    const { lockSet } = req;
    const baseline = decodeChunk(req.baseline);
    checkBase(lockSet, baseline);
    const { spot, chartsHash } = await flopSpotOf(lockSet, baseline);
    if (signal.aborted) throw abortError(signal);
    const how = nodelockFlopRun(lockSet, req.maxIterations);
    const spec: SplitSpec = { spot, dcfr: how.dcfr, storage: "i16" };
    const key = spotKey(lockSet, spec, chartsHash);

    let state = warm?.key === key ? warm : null;
    const isWarm = state !== null;
    if (state) {
      state.coordinator.solver.unfreezeAll();
      state.coordinator.solver.restartAverage(NODELOCK_WARM_ITERATION);
      await Promise.all(Array.from({ length: state.parts }, (_, i) => pool.call(i, { type: "restart", iteration: NODELOCK_WARM_ITERATION })));
    } else {
      warm = null;
      const coordinator = new SplitCoordinator(spec, []);
      checkBaseline(coordinator.built, baseline, lockSet);
      const groups = splitCards(coordinator.built, threads);
      const ready = await Promise.all(groups.map((cards, i) => pool.call(i, { type: "part", key, spec, cards })));
      const answers = ready.map((r) => r as Extract<EngineResponse, { type: "ready" }>);
      coordinator.setPartSums(answers.map((r) => r.valueSum));
      state = { key, coordinator, parts: groups.length, partBytes: answers.reduce((sum, r) => sum + r.bytes, 0) };
      warm = state;
    }
    if (signal.aborted) throw abortError(signal);

    const { coordinator, parts, partBytes } = state;
    applyNodelock(coordinator.built, coordinator.solver, lockSet, { baseline: chunkBaseline(baseline, coordinator.built) });
    const memoryMb = (coordinator.solver.bytes + partBytes) / 1e6;
    const traverse = async (step: SplitStep): Promise<UnitValues[]> => {
      const answers = await Promise.all(Array.from({ length: parts }, (_, i) => pool.call(i, { type: "traverse", step })));
      return answers.map((a) => (a as Extract<EngineResponse, { type: "values" }>).values);
    };

    const runStarted = now();
    const firstIteration = coordinator.solver.iterations;
    const max = how.maxIterations ?? 300;
    const measurements: { iteration: number; pct: number }[] = [];
    const report = (iteration: number) => {
      const elapsed = now() - runStarted;
      const msPerIteration = iteration > firstIteration ? elapsed / (iteration - firstIteration) : 0;
      onProgress({
        iteration,
        exploitabilityPct: measurements.length ? measurements[measurements.length - 1].pct : null,
        elapsedMs: now() - started,
        etaMs: etaOf(measurements, iteration, msPerIteration, lockSet.targetPct, max),
        memoryMb,
      });
    };
    const run = await driveAsync(
      coordinator.run({
        ...how,
        onIteration: (iteration) => {
          report(iteration);
          return !signal.aborted;
        },
        onProgress: (p) => {
          measurements.push({ iteration: p.iteration, pct: p.exploitability.percentPot });
          report(p.iteration);
        },
      }),
      traverse,
      signal,
    );
    if (signal.aborted) throw abortError(signal);
    const result = await driveAsync(coordinator.result(run, partBytes), traverse, signal);
    const chunk = encodeChunk(nodelockHeader(baseline.header, lockSet), result);
    return {
      chunk,
      stats: {
        iterations: run.iterations,
        exploitabilityPct: run.exploitability.percentPot,
        seconds: (now() - started) / 1000,
        peakMb: memoryMb,
        threads: parts,
        engine: "workers",
        warm: isWarm,
      },
    };
  }

  async function solveTurn(req: NodelockRequest, onProgress: (p: NodelockProgress) => void, signal: AbortSignal, started: number): Promise<NodelockResult> {
    const stop = () => turnPool.kill(0, abortError(signal) as Error);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const measurements: { iteration: number; pct: number }[] = [];
      const answer = await turnPool.call(
        0,
        { type: "turn", lockSet: req.lockSet, baseline: req.baseline, maxIterations: req.maxIterations },
        (message) => {
          if (message.type !== "progress") return;
          if (message.exploitabilityPct !== null && measurements[measurements.length - 1]?.pct !== message.exploitabilityPct) {
            measurements.push({ iteration: message.iteration, pct: message.exploitabilityPct });
          }
          const elapsed = now() - started;
          onProgress({
            iteration: message.iteration,
            exploitabilityPct: message.exploitabilityPct,
            elapsedMs: elapsed,
            etaMs: etaOf(measurements, message.iteration, message.iteration > 0 ? elapsed / message.iteration : 0, req.lockSet.targetPct, req.maxIterations ?? 400),
            memoryMb: message.memoryMb,
          });
        },
      );
      if (answer.type !== "turned") throw new Error(`unexpected answer ${answer.type}`);
      return {
        chunk: answer.chunk,
        stats: {
          iterations: answer.stats.iterations,
          exploitabilityPct: answer.stats.exploitabilityPct,
          seconds: (now() - started) / 1000,
          peakMb: answer.stats.peakMb,
          threads: 1,
          engine: "workers",
          warm: answer.warm,
        },
      };
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  return {
    kind: "workers",
    threads,
    release,
    async solve(req, onProgress, signal) {
      if (busy) throw new Error("a nodelock solve is already running");
      if (signal.aborted) throw abortError(signal);
      busy = true;
      const started = now();
      try {
        return lockGameStreet(req.lockSet) === "flop" ? await solveFlop(req, onProgress, signal, started) : await solveTurn(req, onProgress, signal, started);
      } catch (error) {
        // A failed worker loses its part: the next flop lock starts cold. A cancel, or a lock
        // that does not fit the game, keeps them.
        if (!signal.aborted && !(error instanceof NodelockError)) {
          warm = null;
          pool.stop();
        }
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
