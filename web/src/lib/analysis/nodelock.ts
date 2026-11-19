/**
 * The locked solve (`docs/NODELOCK.md` §2.3–2.4): a lock set re-solved on
 * the library's own game, sequentially - the reference the desktop app's
 * engines are held to.
 *
 * - **Flop locks** re-solve the flop game the library chunk was solved on
 *   (`nodelockSpot`: the chart set's line, `FLOP_PROFILE`), with the locked
 *   nodes frozen and, per `earlier`, the decisions before them frozen at the
 *   chunk's strategy. The result is a flop-level chunk like the library's.
 * - **Turn and river locks** re-solve the deal's turn game from the chunk's
 *   ranges at the deal, the way the live turn does (`liveTurn.ts`): the flop
 *   stays the chunk's. The earlier turn and river decisions freeze at the
 *   unlocked turn solve (the live turn the user was looking at), and the
 *   locked solve goes on from it (a warm start). The result chunk holds the
 *   whole turn game.
 *
 * - **Based locks** (§7.4, `LockSet.base`) are solved on their base lock's
 *   result chunk where a lock is otherwise solved on the library's: a turn
 *   lock made inside a solved flop lock takes the ranges at the deal from
 *   the locked flop, and its earlier turn decisions freeze at the unlocked
 *   turn solved from it. The baseline is that chunk in every step above.
 *
 * Every result chunk carries the lock's hash (`FlopChunkHeader.lockHash`),
 * and a based one its base's (`baseHash`).
 * Not re-exported from `lib/analysis/index.ts` (it reaches `flopJob.ts`).
 */

import type { ChartSet } from "../charts";
import {
  ACTION,
  applyNodelock,
  buildFlopGame,
  buildTurnGame,
  chunkBaseline,
  earlierNodes,
  encodeChunk,
  extract,
  LIVE_TURN,
  liveTurnSpot,
  lockedNodes,
  lockGameStreet,
  lockNodeActions,
  lockSymmetries,
  NodelockError,
  nodelockHeader,
  Solver,
  splitLockPath,
  type BuiltSubgame,
  type FlopChunk,
  type FlopChunkHeader,
  type FlopSpot,
  type LockSet,
  type NodeLockSpec,
  type RunOptions,
  type SolveResult,
  type TurnSpot,
} from "../solver";
import { nodelockSpot } from "./flopJob";
import { FLOP_PROFILE } from "./flopLibrary";

/**
 * A warm start goes on from this iteration (`Solver.restartAverage`): late
 * enough that DCFR's discount keeps the regrets it starts from, early
 * enough that the new average outweighs nothing old.
 */
export const NODELOCK_WARM_ITERATION = 10;

/** What a lock set re-solves: the flop game, or one deal's turn game. */
export type NodelockSpot =
  | { street: "flop"; spot: FlopSpot }
  | {
      street: "turn";
      spot: TurnSpot;
      /** The chunk's deal (result node index) and the turn card. */
      deal: number;
      card: string;
    };

/** The flop spot of a flop lock: the library's spot, isomorphism limited to what the lock keeps. */
export function nodelockFlopSpot(charts: ChartSet, set: LockSet): FlopSpot {
  const spot = nodelockSpot(charts, set.spot.line, set.spot.flop);
  const nodeActions = lockNodeActions(set);
  return { ...spot, symmetry: lockSymmetries(set, spot.board), ...(nodeActions ? { nodeActions } : {}) };
}

/** The turn game of a turn or river lock: the chunk's deal on its flop line, the lock's turn card. */
export function nodelockTurnSpot(baseline: FlopChunk, set: LockSet): Extract<NodelockSpot, { street: "turn" }> {
  const parts = splitLockPath(set.nodes[0].path);
  if (!parts.turn) throw new NodelockError(`${set.nodes[0].path} names no turn card`);
  const deal = baseline.result.nodes.findIndex((node) => node.kind === "chance" && node.path === parts.flop);
  if (deal < 0) throw new NodelockError(`the chunk has no turn deal after ${parts.flop || "the flop root"}`);
  const spot = liveTurnSpot(baseline, deal, parts.turn);
  const nodeActions = lockNodeActions(set, turnGamePath);
  return { street: "turn", spot: { ...spot, symmetry: lockSymmetries(set, spot.board), ...(nodeActions ? { nodeActions } : {}) }, deal, card: parts.turn };
}

/**
 * The game a lock set re-solves. `baseline` is the chunk it is solved on:
 * the library chunk, or for a based set (`set.base`) its base lock's result.
 * `charts` (the lock's chart set) is needed for a flop lock: the ranges come
 * from it, as the library's did.
 */
export function nodelockSpotOf(set: LockSet, baseline: FlopChunk, charts?: ChartSet): NodelockSpot {
  checkSpot(set, baseline.header);
  checkBase(set, baseline);
  if (lockGameStreet(set) === "turn") return nodelockTurnSpot(baseline, set);
  if (!charts) throw new NodelockError("a flop lock needs its chart set");
  if (charts.id !== set.spot.set) throw new NodelockError(`the lock is on ${set.spot.set}, the charts are ${charts.id}`);
  return { street: "flop", spot: nodelockFlopSpot(charts, set) };
}

/** The lock and the library chunk name the same spot. */
function checkSpot(set: LockSet, header: FlopChunkHeader): void {
  if (header.charts.id !== set.spot.set || header.line !== set.spot.line || header.flop !== set.spot.flop) {
    throw new NodelockError(`the chunk is ${header.charts.id} ${header.line} ${header.flop}, the lock ${set.spot.set} ${set.spot.line} ${set.spot.flop}`);
  }
}

/**
 * The chunk a lock set is solved on is the one it names: the library's (no
 * `base`, so no `lockHash` in its header), or its base lock's result (its
 * `lockHash` is `base.lockHash`). A base is a flop-level chunk: a turn
 * game's chunk deals no turn, and one lock set is one game, so a lock on a
 * turn lock adds to its nodes instead of building on its result.
 */
export function checkBase(set: LockSet, baseline: FlopChunk): void {
  const solvedOn = baseline.header.lockHash;
  if (!set.base) {
    if (solvedOn !== undefined) throw new NodelockError("a lock without a base is solved on the library chunk, not on a locked one");
    return;
  }
  if (solvedOn !== set.base.lockHash) {
    throw new NodelockError(`the lock is built on ${set.base.lockHash.slice(0, 12)}, the chunk is ${solvedOn === undefined ? "the library's" : solvedOn.slice(0, 12)}`);
  }
  const street = baseline.result.street === "flop" ? "flop" : "turn";
  if (street !== set.base.street) throw new NodelockError(`the base is a ${set.base.street} lock, the chunk a ${street} game`);
  if (street !== "flop") throw new NodelockError("a lock is built on a flop lock's result, not on a turn game's");
}

/**
 * The library chunk was solved on this game: the same hands for both
 * players, the same pot and stack. Else the chunk's strategies would be
 * frozen onto another game.
 */
export function checkBaseline(built: BuiltSubgame, baseline: FlopChunk): void {
  const { result, header } = baseline;
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
  if (!same(built.combos[0], result.hands[0]) || !same(built.combos[1], result.hands[1]) || built.pot !== header.pot || built.stack !== header.stack) {
    throw new NodelockError("the library chunk was solved on other ranges than the charts give now");
  }
}

/** How a flop lock runs: the library's profile, to the lock's target. */
export function nodelockFlopRun(set: LockSet, maxIterations?: number): Pick<RunOptions, "maxIterations" | "targetExploitability" | "checkFrom" | "checkEvery"> & { dcfr: typeof FLOP_PROFILE.dcfr } {
  return {
    maxIterations: maxIterations ?? FLOP_PROFILE.maxIterations,
    targetExploitability: set.targetPct,
    checkFrom: FLOP_PROFILE.checkFrom,
    checkEvery: FLOP_PROFILE.checkEvery,
    dcfr: FLOP_PROFILE.dcfr,
  };
}

/** How a turn or river lock runs: the live turn's engine settings, to the lock's target. */
export function nodelockTurnRun(set: LockSet, maxIterations?: number): Pick<RunOptions, "maxIterations" | "targetExploitability" | "checkFrom" | "checkEvery"> {
  return {
    maxIterations: maxIterations ?? LIVE_TURN.maxIterations,
    targetExploitability: set.targetPct,
    checkFrom: LIVE_TURN.checkFrom,
    checkEvery: LIVE_TURN.checkEvery,
  };
}

/** A turn or river lock's path in the deal's turn game. */
export const turnGamePath = (spec: NodeLockSpec) => splitLockPath(spec.path).inner;

export interface NodelockProgressEvent {
  iteration: number;
  /** The last measurement, % of the pot; null before the first. */
  exploitabilityPct: number | null;
}

export interface NodelockSolveOptions {
  /** The chunk the lock is solved on: the library chunk of the lock's spot, or its base lock's result (`set.base`). */
  baseline: FlopChunk;
  maxIterations?: number;
  /** Default: `"i16"` for a flop lock (as the library), `"f32"` for a turn lock (as the live turn). */
  storage?: "f32" | "i16";
  /** After every iteration; returning `false` cancels. */
  onIteration?: (progress: NodelockProgressEvent) => boolean | void;
  /** The last solve of the same game (`street`, spot and symmetry) to go on from: a warm start. Its locks are replaced. */
  warm?: NodelockWarm;
  /** Milliseconds clock for the stats; default `Date.now`. */
  now?: () => number;
}

/**
 * What a warm start goes on from: the last lock's solver, and for a turn
 * game the unlocked turn's strategies (its earlier nodes' baseline), once
 * solved.
 */
export interface NodelockWarm {
  solver: Solver;
  turnBaseline: Map<number, Float32Array> | null;
}

export interface NodelockSolve {
  result: SolveResult;
  /** `encodeChunk` of the result, `lockHash` in its header. */
  chunk: Uint8Array;
  header: FlopChunkHeader;
  /** The solver, kept for a warm start of the next lock on the same game (`warm`). */
  solver: Solver;
  warm: NodelockWarm;
  built: BuiltSubgame;
  /** `warm`: the solve went on from `options.warm`'s solver (a turn game's warm solver without the unlocked baseline its earlier nodes need starts cold). */
  stats: { iterations: number; exploitabilityPct: number; seconds: number; peakMb: number; threads: number; engine: string; stoppedBy: string; warm: boolean };
}

/**
 * The sequential reference solve of a lock set (§2.4). `spot` is
 * `nodelockSpotOf(set, baseline, charts)`.
 */
export function solveNodelock(spot: NodelockSpot, set: LockSet, options: NodelockSolveOptions): NodelockSolve {
  checkBase(set, options.baseline);
  const now = options.now ?? Date.now;
  const started = now();
  let last: number | null = null;
  const onIteration = options.onIteration
    ? (iteration: number) => (options.onIteration as NonNullable<NodelockSolveOptions["onIteration"]>)({ iteration, exploitabilityPct: last })
    : undefined;
  const onProgress = (p: { exploitability: { percentPot: number } }) => {
    last = p.exploitability.percentPot;
  };

  let built: BuiltSubgame;
  let solver: Solver;
  let scope: "flop" | "all";
  let turnBaseline: Map<number, Float32Array> | null = null;
  let warmed = false;
  let run;
  if (spot.street === "flop") {
    built = buildFlopGame(spot.spot);
    checkBaseline(built, options.baseline);
    const how = nodelockFlopRun(set, options.maxIterations);
    solver = options.warm?.solver ?? new Solver(built.game, how.dcfr, { storage: options.storage ?? "i16" });
    warmed = options.warm !== undefined;
    if (options.warm) {
      solver.unfreezeAll();
      solver.restartAverage(NODELOCK_WARM_ITERATION);
    }
    applyNodelock(built, solver, set, { baseline: chunkBaseline(options.baseline, built) });
    run = solver.run({ ...how, onIteration, onProgress });
    scope = "flop";
  } else {
    built = buildTurnGame(spot.spot);
    const how = nodelockTurnRun(set, options.maxIterations);
    const earlier = earlierNodes(built, set, lockedNodes(built, set, turnGamePath));
    turnBaseline = options.warm?.turnBaseline ?? null;
    // Earlier nodes freeze at the unlocked turn's strategies: a warm solver that never solved it starts cold.
    const warm = options.warm && (turnBaseline || !earlier.length) ? options.warm.solver : null;
    solver = warm ?? new Solver(built.game, LIVE_TURN.dcfr, { storage: options.storage ?? "f32" });
    warmed = warm !== null;
    if (warm) solver.unfreezeAll();
    if (earlier.length && !turnBaseline) {
      // The baseline: the unlocked turn, solved as the live turn solves it.
      solver.run({
        maxIterations: LIVE_TURN.maxIterations,
        targetExploitability: LIVE_TURN.targetPct,
        checkFrom: LIVE_TURN.checkFrom,
        checkEvery: LIVE_TURN.checkEvery,
      });
      turnBaseline = new Map();
      for (let node = 0; node < built.game.tree.size; node += 1) {
        if (built.game.tree.type[node] === ACTION) turnBaseline.set(node, solver.averageStrategy(node));
      }
    }
    const baseline = turnBaseline;
    applyNodelock(built, solver, set, { pathOf: turnGamePath, baseline: (node) => baseline?.get(node) ?? null });
    if (earlier.length || warm) solver.restartAverage(NODELOCK_WARM_ITERATION);
    run = solver.run({ ...how, onIteration, onProgress });
    scope = "all";
  }
  const result = extract(built, solver, run, scope);
  const header = nodelockHeader(options.baseline.header, set);
  return {
    result,
    chunk: encodeChunk(header, result),
    header,
    solver,
    warm: { solver, turnBaseline },
    built,
    stats: {
      iterations: run.iterations,
      exploitabilityPct: run.exploitability.percentPot,
      seconds: (now() - started) / 1000,
      peakMb: solver.bytes / 1e6,
      threads: 1,
      engine: "ts",
      stoppedBy: run.stoppedBy,
      warm: warmed,
    },
  };
}
