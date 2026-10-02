/**
 * The chart generator, as a pure function: equity table, tree, DCFR solve,
 * convergence measurements, chart set. `tests/scripts/preflop-charts/` runs
 * it with the production configuration and writes `data/`; the test suite
 * runs it on a small configuration to check that it is deterministic.
 *
 * Nothing here reads a clock or an unseeded random source, so the same
 * options give the same bytes.
 */

import { type DcfrParams, DEFAULT_DCFR } from "../solver/cfr";
import { CLASS_COMBOS, NUM_CLASSES } from "../solver/handClasses";
import { PreflopSolver, type PreflopExploitability } from "../solver/preflopCfr";
import {
  DEFAULT_EQUITY_BOARDS,
  DEFAULT_EQUITY_SEED,
  preflopEquityTable,
  type PreflopEquityTable,
} from "../solver/preflopEquity";
import {
  CHARTS1_REALISATION,
  realisationAssumptions,
  STANDARD_RAKE,
  type RakeProfile,
  type RealisationModel,
} from "../solver/preflopModel";
import {
  buildPreflopTree,
  PF_ACTION,
  SIX_MAX,
  type PreflopPosition,
  type PreflopSizing,
  type PreflopTree,
} from "../solver/preflopTree";
import { buildChartSet } from "./build";
import type { ChartSetJson } from "./format";

export interface GenerateOptions {
  id?: string;
  /** The set's `version` (default `CHARTS_VERSION`; the 6-max 100bb set is `charts/2`). */
  version?: string;
  players?: readonly PreflopPosition[];
  stackBb?: number;
  sizing?: Partial<PreflopSizing>;
  maxEntrants?: number;
  rake?: Readonly<RakeProfile>;
  cardRemoval?: boolean;
  equityBoards?: number;
  equitySeed?: number;
  /** A precomputed table for these boards and seed (the script caches it). */
  equity?: PreflopEquityTable;
  iterations?: number;
  /** Convergence is measured every this many iterations. */
  checkEvery?: number;
  params?: Partial<DcfrParams>;
  /** Nodes reached less often than this are not written. */
  minReach?: number;
  /** Iterations for the standalone SB-vs-BB solve; 0 skips it. */
  headsUpIterations?: number;
  /**
   * How pots that see a flop are shared. Default: `CHARTS1_REALISATION`, the
   * hand-set model; the committed set uses the one fitted to the postflop
   * solver (`generateRealisedChartSet` in `realisation.ts`).
   */
  realisation?: RealisationModel;
  /** Recorded in the chart set under `model.realisationFit` (how `realisation` was obtained). */
  realisationFit?: unknown;
  onProgress?: (progress: GenerateProgress) => void;
}

export interface GenerateProgress {
  phase: "equity" | "solve" | "heads-up" | "charts";
  iteration?: number;
  nashConvMbb?: number;
}

export interface ConvergencePoint {
  iteration: number;
  nashConvMbb: number;
  gainMbb: number[];
  /** Mean over chart-relevant nodes of the reach-weighted L1 change of the average strategy since the previous point. */
  strategyChange: number;
}

export interface GenerateResult {
  charts: ChartSetJson;
  equity: PreflopEquityTable;
  tree: PreflopTree;
  solver: PreflopSolver;
  convergence: ConvergencePoint[];
  final: PreflopExploitability;
  headsUp: { iterations: number; nashConvMbb: number; gainMbb: number[] } | null;
}

export const PRODUCTION_ITERATIONS = 3000;
export const PRODUCTION_MIN_REACH = 1e-5;

/** Average strategies of every action node, in the solver's layout. */
function averages(solver: PreflopSolver): Float64Array {
  const tree = solver.tree;
  const out = new Float64Array(solver.strategySum.length);
  for (let node = 0; node < tree.size; node += 1) {
    if (tree.type[node] !== PF_ACTION) continue;
    out.set(solver.averageStrategy(node), solver.offset[node]);
  }
  return out;
}

/** Per-node reach-weighted L1 change, averaged over nodes reached at least `minReach`. */
function strategyChange(
  solver: PreflopSolver,
  before: Float64Array,
  after: Float64Array,
  minReach: number,
): number {
  const tree = solver.tree;
  const n = tree.players.length;
  const H = NUM_CLASSES;
  const reach = new Float64Array(n * H).fill(1);
  let total = 0;
  let count = 0;
  const visit = (node: number) => {
    if (tree.type[node] !== PF_ACTION) return;
    const actor = tree.actor[node];
    const cnt = tree.childCount[node];
    const off = solver.offset[node];
    let nodeReach = 1;
    for (let p = 0; p < n; p += 1) {
      let s = 0;
      for (let i = 0; i < H; i += 1) s += CLASS_COMBOS[i] * reach[p * H + i];
      nodeReach *= s / 1326;
    }
    if (nodeReach >= minReach) {
      // Weighted by the actor's range at the node.
      let diff = 0;
      let weight = 0;
      for (let i = 0; i < H; i += 1) {
        const w = CLASS_COMBOS[i] * reach[actor * H + i];
        let d = 0;
        for (let a = 0; a < cnt; a += 1) d += Math.abs(after[off + a * H + i] - before[off + a * H + i]);
        diff += w * d;
        weight += w;
      }
      if (weight > 0) {
        total += diff / weight;
        count += 1;
      }
    }
    const save = reach.slice(actor * H, actor * H + H);
    for (let a = 0; a < cnt; a += 1) {
      for (let i = 0; i < H; i += 1) reach[actor * H + i] = save[i] * after[off + a * H + i];
      visit(tree.children[tree.childStart[node] + a]);
    }
    reach.set(save, actor * H);
  };
  visit(0);
  return count ? total / count : 0;
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Generates a chart set. See the module header. */
export function generateChartSet(options: GenerateOptions = {}): GenerateResult {
  const players = options.players ?? SIX_MAX;
  const rake = options.rake ?? STANDARD_RAKE;
  const cardRemoval = options.cardRemoval ?? true;
  const iterations = options.iterations ?? PRODUCTION_ITERATIONS;
  const checkEvery = Math.max(1, options.checkEvery ?? 500);
  const minReach = options.minReach ?? PRODUCTION_MIN_REACH;
  const params: DcfrParams = { ...DEFAULT_DCFR, ...options.params };
  const boards = options.equityBoards ?? DEFAULT_EQUITY_BOARDS;
  const seed = options.equitySeed ?? DEFAULT_EQUITY_SEED;

  options.onProgress?.({ phase: "equity" });
  const equity =
    options.equity && options.equity.boards === boards && options.equity.seed === seed
      ? options.equity
      : preflopEquityTable({ boards, seed });

  const tree = buildPreflopTree({
    players,
    stackBb: options.stackBb,
    sizing: options.sizing,
    maxEntrants: options.maxEntrants,
  });
  const realisation = options.realisation ?? CHARTS1_REALISATION;
  const solver = new PreflopSolver({ tree, equity: equity.equity, rake, cardRemoval, realisation }, params);

  const convergence: ConvergencePoint[] = [];
  let previous = averages(solver);
  while (solver.iterations < iterations) {
    solver.iterate(Math.min(checkEvery, iterations - solver.iterations));
    const ex = solver.exploitability();
    const current = averages(solver);
    convergence.push({
      iteration: solver.iterations,
      nashConvMbb: round(ex.nashConvMbb, 3),
      gainMbb: ex.gainMbb.map((g) => round(g, 3)),
      strategyChange: round(strategyChange(solver, previous, current, minReach), 5),
    });
    previous = current;
    options.onProgress?.({ phase: "solve", iteration: solver.iterations, nashConvMbb: ex.nashConvMbb });
  }
  const final = solver.exploitability();
  solver.evaluate();

  // The blind-vs-blind subgame on its own: a two-player game, where DCFR's
  // guarantee holds (up to rake), as a calibration of the engine on this model.
  let headsUp: GenerateResult["headsUp"] = null;
  const huIterations = options.headsUpIterations ?? 1000;
  if (huIterations > 0 && players.includes("SB") && players.includes("BB")) {
    options.onProgress?.({ phase: "heads-up" });
    const huTree = buildPreflopTree({ players: ["SB", "BB"], stackBb: options.stackBb, sizing: options.sizing });
    const hu = new PreflopSolver({ tree: huTree, equity: equity.equity, rake, cardRemoval, realisation }, params);
    hu.iterate(huIterations);
    const ex = hu.exploitability();
    headsUp = {
      iterations: huIterations,
      nashConvMbb: round(ex.nashConvMbb, 4),
      gainMbb: ex.gainMbb.map((g) => round(g, 4)),
    };
  }

  options.onProgress?.({ phase: "charts" });
  const id = options.id ?? `nlhe-cash-${players.length}max-${tree.stackBb}bb`;
  const charts = buildChartSet(solver, {
    id,
    version: options.version,
    minReach,
    model: {
      tree: {
        sizing: tree.sizing,
        maxEntrants: tree.maxEntrants,
        sbLimp: tree.sbLimp,
        cuts: [
          "no open limps except the small blind's",
          "at most four players put money in voluntarily; players already in may always continue",
          "no cold call of a 3-bet or 4-bet",
          "5-bet is all-in; a cold player facing an all-in folds",
        ],
        actionNodes: tree.actionNodes,
      },
      rake: { ...rake, potGrowth: realisationAssumptions(realisation).rakePotGrowth },
      realisation: realisationAssumptions(realisation),
      ...(options.realisationFit === undefined ? {} : { realisationFit: options.realisationFit }),
      cardRemoval: cardRemoval
        ? "hero-opponent exact at class level (m[i][j]/1225); opponent-opponent ignored"
        : "none (classes independent)",
      equity: {
        method: "Monte Carlo over shared boards, one representative combo per class, symmetrised",
        boards: equity.boards,
        seed: equity.seed,
        standardError: round(equity.standardError, 5),
      },
      solver: {
        algorithm: "DCFR, alternating updates, 169 classes per player",
        params,
        iterations: solver.iterations,
        offRange: "classes whose stored range is 0 (< 0.5/255) get the best response to the charts (argmax EV)",
      },
      convergence: {
        nashConvMbb: round(final.nashConvMbb, 3),
        gainMbbByPosition: Object.fromEntries(players.map((p, k) => [p, round(final.gainMbb[k], 3)])),
        valueBbByPosition: Object.fromEntries(players.map((p, k) => [p, round(final.value[k], 4)])),
        rakeBbPerHand: round(-final.valueSum, 4),
        history: convergence,
        headsUpBlindVsBlind: headsUp,
        note: "Multi-player CFR has no equilibrium guarantee; NashConv is the sum over players of what a best response would gain against the others' average strategies (0 at a Nash equilibrium of this model).",
      },
      minReach,
    },
  });

  return { charts, equity, tree, solver, convergence, final, headsUp };
}
