/**
 * One library job: a (line, flop) solve, as data a worker process can take.
 *
 * `jobSpot` (`web/src/lib/analysis/flopJob.ts`) turns it into the `FlopSpot`
 * the solver takes, with the library's profile (`FLOP_PROFILE`); `solveJob` solves it and returns the chunk bytes
 * and what the solve cost. Pure apart from the clock it reads for progress -
 * the bytes depend only on the job.
 */

import { FLOP_PROFILE } from "../../../web/src/lib/analysis/flopLibrary.js";
import { jobHeader, jobSpot, type Job } from "../../../web/src/lib/analysis/flopJob.js";
import { encodeChunk, solveFlop, type FlopProgress } from "../../../web/src/lib/solver/index.js";

// The job and its spot are the web library's (`flopJob.ts`): the app's nodelock builds the same spot.
export { jobHeader, jobSpot, type Job };

export interface JobStats {
  iterations: number;
  exploitabilityPct: number;
  stoppedBy: string;
  seconds: number;
  solverMb: number;
  nodes: number;
  actionNodes: number;
  boards: number;
  turnClasses: number;
  hands: [number, number];
}

/** Solves a job; `onIteration` sees progress and may cancel (returns `false`). */
export function solveJob(
  job: Job,
  onIteration?: (progress: FlopProgress) => boolean | void,
): { bytes: Uint8Array; stats: JobStats; cancelled: boolean } {
  const p = job.profile ?? FLOP_PROFILE;
  const started = performance.now();
  const solved = solveFlop(jobSpot(job), {
    maxIterations: p.maxIterations,
    targetExploitability: p.targetPct,
    checkFrom: p.checkFrom,
    checkEvery: p.checkEvery,
    dcfr: p.dcfr,
    storage: "i16",
    onIteration,
    now: () => performance.now(),
  });
  const { result, stats } = solved;
  const bytes = encodeChunk(jobHeader(job), result);
  return {
    bytes,
    cancelled: solved.run.stoppedBy === "cancelled",
    stats: {
      iterations: result.iterations,
      exploitabilityPct: result.exploitabilityPct,
      stoppedBy: result.stoppedBy,
      seconds: (performance.now() - started) / 1000,
      solverMb: stats.solverBytes / 1e6,
      nodes: stats.nodes,
      actionNodes: stats.actionNodes,
      boards: stats.boards,
      turnClasses: stats.turnClasses,
      hands: [result.hands[0].length, result.hands[1].length],
    },
  };
}
