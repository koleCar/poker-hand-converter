/**
 * A flop solve split over turn cards (nodelock, `docs/NODELOCK.md` §2.2):
 * the same DCFR as `Solver.run`, with the turn subtrees walked by several
 * solvers - one per worker - and the flop by one.
 *
 * ```
 * coordinator (the flop)                 parts (each: its own turn cards)
 *   splitDown: reach at every turn deal ──▶ unitWalk: each owned turn subtree
 *   splitUp:   the flop with their values ◀── values per (deal, turn card)
 * ```
 *
 * In alternating DCFR the opponent's reach at every deal is fixed before a
 * traversal starts (it reads only regrets the traversal does not change), so
 * the three steps compute exactly what one walk does, and the coordinator
 * adds the subtrees' values in the walk's own order. A split solve is
 * therefore **bit-identical** to the sequential one at any iteration count,
 * whatever the number of parts (`tests/test/solver/nodelock.test.ts`).
 *
 * **Memory.** A part builds a partial game (`buildFlopGame` with
 * `keepTurn`): the flop, the hands and the deals as the whole game has them,
 * but only its own turn cards' subtrees - regrets, sums, tree and showdown
 * boards. The coordinator builds none of them. The parts together hold
 * about what one sequential solver holds.
 *
 * **Driving.** Every solve here is a generator that yields one traversal at
 * a time (`SplitStep`) and takes back the parts' answers (`UnitValues`):
 * `driveSync` runs the parts in this thread (tests, the sequential check),
 * `driveAsync` hands each step to a pool of workers (the app's engine, the
 * Node harness), with the same partition and the same numbers.
 *
 * Same import rule as the rest of `lib/solver`: no framework, no I/O.
 */

import {
  combineConstantSums,
  exploitabilityOf,
  Solver,
  unmeasured,
  type DcfrParams,
  type Exploitability,
  type RunOptions,
  type RunResult,
  type TraversalState,
  type UnitValues,
} from "./cfr";
import { buildFlopGame, type FlopSpot } from "./flop";
import { extract, type SolveResult } from "./solve";
import type { BuiltSubgame } from "./subgame";

/** What every part and the coordinator are built from: the same spot and engine settings. */
export interface SplitSpec {
  spot: FlopSpot;
  dcfr?: Partial<DcfrParams>;
  /** Default `"i16"`, as the library solves. */
  storage?: "f32" | "i16";
}

/** One traversal for the parts: its state and the opponent's reach at each unit (null: not reached). */
export interface SplitStep {
  state: TraversalState;
  reach: (Float64Array | null)[];
}

/** A split solve's generator: yields traversals, takes the parts' answers, returns `T`. */
export type SplitRun<T> = Generator<SplitStep, T, UnitValues[]>;

/** The first deals below the root street (a flop game's turn deals): the units, ascending by node id. */
export function unitNodes(built: BuiltSubgame): number[] {
  const out: number[] = [];
  for (const [node, path] of built.chancePath) {
    if (!path.includes("|")) out.push(node);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The turn cards a flop game deals (one per suit class), split into `parts`
 * groups of about equal work - a turn card's work is the river classes
 * dealt below it. Deterministic: the biggest first, each to the lightest
 * group so far, ties by card and by group.
 */
export function splitCards(built: BuiltSubgame, parts: number): number[][] {
  const tree = built.game.tree;
  const units = unitNodes(built);
  if (!units.length) return Array.from({ length: Math.max(1, parts) }, () => []);
  const first = units[0];
  const start = tree.childStart[first];
  const cards: { card: number; work: number }[] = [];
  const rivers = new Map((built.flopIsomorphism?.turns ?? []).map((t) => [t.card, t.rivers]));
  for (let e = start; e < start + tree.childCount[first]; e += 1) {
    const card = tree.edgeCard[e];
    cards.push({ card, work: rivers.get(tree.edgeLabel[e]) ?? 48 });
  }
  cards.sort((a, b) => b.work - a.work || a.card - b.card);
  const count = Math.max(1, Math.min(parts, cards.length));
  const groups: number[][] = Array.from({ length: count }, () => []);
  const load = new Array<number>(count).fill(0);
  for (const { card, work } of cards) {
    let best = 0;
    for (let g = 1; g < count; g += 1) if (load[g] < load[best]) best = g;
    groups[best].push(card);
    load[best] += work;
  }
  return groups.map((g) => g.sort((a, b) => a - b));
}

/** One part of a split solve: a partial game with its own turn cards, and its solver. */
export class SplitPart {
  readonly built: BuiltSubgame;
  readonly solver: Solver;
  readonly cards: readonly number[];

  constructor(spec: SplitSpec, cards: readonly number[]) {
    const own = new Set(cards);
    this.cards = cards.slice();
    this.built = buildFlopGame(spec.spot, { keepTurn: (card) => own.has(card) });
    this.solver = new Solver(this.built.game, spec.dcfr, { storage: spec.storage ?? "i16" });
    this.solver.setUnits(unitNodes(this.built));
  }

  /** This part's walk of one traversal. */
  traverse(step: SplitStep): UnitValues {
    return this.solver.unitWalk(step.state, step.reach);
  }

  /** The constant sum of this part's terminals (`combineConstantSums`). */
  get valueSum(): number | null {
    return this.solver.valueSum;
  }

  get bytes(): number {
    return this.solver.bytes;
  }
}

/** The flop of a split solve: the top part's solver, and the solve's generators. */
export class SplitCoordinator {
  readonly built: BuiltSubgame;
  readonly solver: Solver;

  /** `partSums`: each part's `valueSum`, for the game's constant sum. */
  constructor(spec: SplitSpec, partSums: readonly (number | null)[]) {
    this.built = buildFlopGame(spec.spot, { keepTurn: () => false });
    this.solver = new Solver(this.built.game, spec.dcfr, { storage: spec.storage ?? "i16" });
    this.solver.setUnits(unitNodes(this.built));
    this.setPartSums(partSums);
  }

  /** The parts' `valueSum`s, once they are built (a coordinator made with none). */
  setPartSums(partSums: readonly (number | null)[]): void {
    this.solver.setValueSum(combineConstantSums([this.solver.valueSum, ...partSums]));
  }

  /** One DCFR iteration: both traversals. */
  *iterate(): SplitRun<void> {
    const t = this.solver.beginIteration();
    for (const player of [0, 1] as const) {
      yield* this.traversal({ kind: "cfr", player, iteration: t, bestFrozen: false });
    }
  }

  /** One traversal through the parts; returns the traverser's root value. */
  *traversal(state: TraversalState): SplitRun<number> {
    const reach = this.solver.splitDown(state);
    const answers: UnitValues[] = yield { state, reach };
    return this.solver.splitUp(state, valuesSource(answers, this.solver.game.hands[state.player].size));
  }

  /** `Solver.exploitability` (the locked game's, with frozen nodes). */
  *exploitability(options: { unconstrained?: boolean } = {}): SplitRun<Exploitability> {
    const bestFrozen = this.solver.frozenNodes.length > 0 && !options.unconstrained;
    const it = this.solver.iterations;
    const br: [number, number] = [
      yield* this.traversal({ kind: "best", player: 0, iteration: it, bestFrozen }),
      yield* this.traversal({ kind: "best", player: 1, iteration: it, bestFrozen }),
    ];
    const sum = this.solver.totalSum;
    let value: [number, number];
    if (Number.isNaN(sum)) {
      value = [
        yield* this.traversal({ kind: "eval", player: 0, iteration: it, bestFrozen: false }),
        yield* this.traversal({ kind: "eval", player: 1, iteration: it, bestFrozen: false }),
      ];
    } else {
      const v0 = yield* this.traversal({ kind: "eval", player: 0, iteration: it, bestFrozen: false });
      value = [v0, sum - v0];
    }
    const game = this.solver.game;
    return exploitabilityOf(br, value, game.pot, game.bigBlind ?? 1);
  }

  /** `Solver.run`, step for step: the same iterations and the same measurements. */
  *run(options: RunOptions = {}): SplitRun<RunResult> {
    const solver = this.solver;
    const max = options.maxIterations ?? 1000;
    const target = options.targetExploitability ?? 0.3;
    const every = Math.max(1, options.checkEvery ?? 10);
    const from = Math.max(1, options.checkFrom ?? every);
    let measured: Exploitability | null = null;
    while (solver.iterations < max) {
      const next = solver.iterations < from ? from : solver.iterations + every;
      const step = Math.min(next - solver.iterations, max - solver.iterations);
      for (let k = 0; k < step; k += 1) {
        yield* this.iterate();
        if (options.onIteration?.(solver.iterations) === false) {
          return { iterations: solver.iterations, exploitability: measured ?? unmeasured(), stoppedBy: "cancelled" };
        }
      }
      measured = yield* this.exploitability();
      const keepGoing = options.onProgress?.({ iteration: solver.iterations, exploitability: measured });
      if (measured.percentPot <= target) {
        return { iterations: solver.iterations, exploitability: measured, stoppedBy: "target" };
      }
      if (keepGoing === false) {
        return { iterations: solver.iterations, exploitability: measured, stoppedBy: "cancelled" };
      }
    }
    measured ??= yield* this.exploitability();
    return {
      iterations: solver.iterations,
      exploitability: measured,
      stoppedBy: measured.percentPot <= target ? "target" : "max-iterations",
    };
  }

  /** `Solver.evaluate` over the flop's nodes (what a flop-level result records). */
  *evaluate(): SplitRun<{ value: [number, number]; rootEv: [Float64Array, Float64Array] }> {
    const solver = this.solver;
    const info = this.built.info;
    solver.beginEvaluate((node) => info[node]?.street === "flop");
    try {
      const it = solver.iterations;
      const value: [number, number] = [0, 0];
      const rootEv: [Float64Array, Float64Array] = [new Float64Array(0), new Float64Array(0)];
      for (const player of [0, 1] as const) {
        value[player] = yield* this.traversal({ kind: "eval", player, iteration: it, bestFrozen: false });
        rootEv[player] = solver.rootEvOf(player);
      }
      return { value, rootEv };
    } finally {
      solver.endEvaluate();
    }
  }

  /** The flop-level result of a finished run (`extract(..., "flop")`), with the parts' bytes counted. */
  *result(run: RunResult, partBytes: number): SplitRun<SolveResult> {
    const evaluated = yield* this.evaluate();
    const result = extract(this.built, this.solver, run, "flop", evaluated);
    return { ...result, memoryBytes: this.solver.bytes + partBytes };
  }
}

/** The parts' answers as `splitUp` reads them: the values of (unit, edge). */
export function valuesSource(answers: readonly UnitValues[], n: number): (unit: number, edge: number) => Float64Array | undefined {
  const at = new Map<number, Float64Array>();
  for (const answer of answers) {
    for (let k = 0; k < answer.units.length; k += 1) {
      at.set(answer.units[k] * 4096 + answer.edges[k], answer.values.subarray(k * n, (k + 1) * n));
    }
  }
  return (unit, edge) => at.get(unit * 4096 + edge);
}

/** Runs a split solve's generator with the parts in this thread. */
export function driveSync<T>(run: SplitRun<T>, parts: readonly SplitPart[]): T {
  let next = run.next();
  while (!next.done) {
    const step = next.value;
    next = run.next(parts.map((part) => part.traverse(step)));
  }
  return next.value;
}

/**
 * Runs a split solve's generator with each traversal handed to `traverse`
 * (a worker pool: every part's answer, in part order). An aborted `signal`
 * stops it between traversals with the signal's reason.
 */
export async function driveAsync<T>(
  run: SplitRun<T>,
  traverse: (step: SplitStep) => Promise<UnitValues[]>,
  signal?: AbortSignal,
): Promise<T> {
  let next = run.next();
  while (!next.done) {
    if (signal?.aborted) {
      run.return(undefined as T);
      throw signal.reason ?? new Error("aborted");
    }
    const answers = await traverse(next.value);
    next = run.next(answers);
  }
  return next.value;
}

/**
 * A whole split solve in this thread: `parts` partial games and the
 * coordinator. The reference for the parallel engine, and the bit-identity
 * test against `Solver.run`.
 */
export function solveFlopSplit(spec: SplitSpec, parts: number, options: RunOptions = {}): { result: SolveResult; run: RunResult; coordinator: SplitCoordinator; parts: SplitPart[] } {
  const probe = new SplitCoordinator(spec, []);
  const groups = splitCards(probe.built, parts);
  const made = groups.map((cards) => new SplitPart(spec, cards));
  const coordinator = new SplitCoordinator(spec, made.map((p) => p.valueSum));
  const run = driveSync(coordinator.run(options), made);
  const bytes = made.reduce((sum, p) => sum + p.bytes, 0);
  const result = driveSync(coordinator.result(run, bytes), made);
  return { result, run, coordinator, parts: made };
}
