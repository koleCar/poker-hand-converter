/**
 * One library job: a (line, flop) solve, as data a worker process can take.
 *
 * `jobSpot` turns it into the `FlopSpot` the solver takes, with the library's
 * profile (`FLOP_PROFILE`); `solveJob` solves it and returns the chunk bytes
 * and what the solve cost. Pure apart from the clock it reads for progress -
 * the bytes depend only on the job.
 */

import { FLOP_PROFILE, type FlopProfile } from "../../../frontend/src/lib/analysis/flopLibrary.js";
import {
  encodeChunk,
  FLOPLIB_VERSION,
  flopCards,
  SOLVER_VERSION,
  solveFlop,
  type FlopChunkHeader,
  type FlopProgress,
  type FlopSpot,
} from "../../../frontend/src/lib/solver/index.js";

export interface Job {
  /** `<line>/<flop>`: unique, and the chunk's path below the tree directory. */
  id: string;
  line: string;
  lineKey: string;
  flop: string;
  players: [string, string];
  /** 1,326 weights each, out of position first. */
  ranges: [number[], number[]];
  pot: number;
  stack: number;
  charts: FlopChunkHeader["charts"];
  rake: FlopChunkHeader["rake"];
  /** Defaults to `FLOP_PROFILE`; tests pass a small one. */
  profile?: FlopProfile;
}

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

export function jobSpot(job: Job): FlopSpot {
  const p = job.profile ?? FLOP_PROFILE;
  return {
    board: flopCards(job.flop),
    ranges: [Float64Array.from(job.ranges[0]), Float64Array.from(job.ranges[1])],
    pot: job.pot,
    stack: job.stack,
    firstToAct: 0,
    menus: [p.flopMenu, p.flopMenu],
    raiseCap: p.flopRaiseCap,
    turnMenus: [p.turnMenu, p.turnMenu],
    turnRaiseCap: p.turnRaiseCap,
    riverMenus: [p.riverMenu, p.riverMenu],
    riverRaiseCap: p.riverRaiseCap,
    allInThreshold: p.allInThreshold,
    minBet: p.minBet,
    rake: { percent: job.rake.percent, cap: job.rake.cap },
    bigBlind: 1,
    isomorphism: true,
  };
}

export function jobHeader(job: Job): FlopChunkHeader {
  const p = job.profile ?? FLOP_PROFILE;
  return {
    version: FLOPLIB_VERSION,
    solver: SOLVER_VERSION,
    charts: job.charts,
    tree: p.tree,
    line: job.line,
    lineKey: job.lineKey,
    players: job.players,
    flop: job.flop,
    pot: job.pot,
    stack: job.stack,
    rake: job.rake,
    targetPct: p.targetPct,
  };
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
