/**
 * One v0 set (docs/PREFLOP-PLAN.md §4.2 step 1): a Rail draft set
 * (`web/src/lib/charts/railSets.ts`) solved by the existing generator -
 * `generateChartSet` (DCFR + the realisation model), or with `rounds` the
 * `charts/2` pipeline `generateRealisedChartSet` (measure-and-fit rounds on
 * turn+river solves, worker threads) - nothing rewritten.
 *
 * **The realisation fit.** Rail's generated sets were deleted from
 * `web/src/lib/charts/data/` by `charts/11`; their fitted models are kept in
 * `fits.json` (read from git, commit inside). Each draft set starts from the
 * fit of the old set nearest to it (`V0_FIT_FROM`): its own table and depth
 * where one existed, 6-max 60bb for 6-max 50bb, the classic set of the same
 * table and depth for an ante set (the fits never saw an ante). Without
 * rounds the set is solved once on that fit; with rounds it is measured and
 * fitted again on its own ranges, starting there.
 */

import { PreflopSolver } from "../../../web/src/lib/solver/preflopCfr.js";
import type { PreflopEquityTable } from "../../../web/src/lib/solver/preflopEquity.js";
import type { RealisationModel } from "../../../web/src/lib/solver/preflopModel.js";
import { buildPreflopTree, type PreflopTree } from "../../../web/src/lib/solver/preflopTree.js";
import { generateChartSet, type GenerateOptions, type GenerateResult } from "../../../web/src/lib/charts/generate.js";
import { loadCharts, serializeCharts, type ChartSetJson } from "../../../web/src/lib/charts/format.js";
import { generateRealisedChartSet, PRODUCTION_ROUND_ITERATIONS } from "../../../web/src/lib/charts/realisation.js";
import type { RealisationSample, RealisationSpot } from "../../../web/src/lib/solver/preflopRealisation.js";
import type { RailSetSpec } from "../../../web/src/lib/charts/railSets.js";
import fitsJson from "./fits.json" with { type: "json" };
import { setTotals, type SetTotals } from "./summary.js";

interface StoredFit {
  version: string;
  hash: string;
  name: string;
  source: string;
  potTypes: RealisationModel["potTypes"];
}
const FITS = fitsJson as unknown as { commit: string; fits: Record<string, StoredFit> };

/** The old Rail set whose fitted realisation model each draft set starts from (see the header). */
export const V0_FIT_FROM: Readonly<Record<string, string>> = {
  "rail-hu-100bb": "nlhe-cash-hu-100bb",
  "rail-hu-150bb": "nlhe-cash-hu-150bb",
  "rail-6max-50bb": "nlhe-cash-6max-60bb",
  "rail-6max-100bb": "nlhe-cash-6max-100bb",
  "rail-6max-150bb": "nlhe-cash-6max-150bb",
  "rail-6max-200bb": "nlhe-cash-6max-200bb",
  "rail-6max-100bb-ante": "nlhe-cash-6max-100bb",
  "rail-9max-100bb": "nlhe-cash-9max-100bb",
  "rail-9max-150bb": "nlhe-cash-9max-150bb",
  "rail-9max-100bb-ante": "nlhe-cash-9max-100bb",
  "rail-6max-100bb-straddle": "nlhe-cash-6max-100bb-straddle",
};

/**
 * Iterations of the final solve: 3,000 as every `charts/3` set (no open
 * limps, so no tremble to wear down, docs/CHARTS.md §5.1); heads-up 9,000
 * as `charts/8` (a ten-node tree, seconds).
 */
export function v0Iterations(spec: RailSetSpec): number {
  return spec.headsUp ? 9000 : 3000;
}

export function v0Fit(spec: RailSetSpec): { model: RealisationModel; from: string; record: Record<string, unknown> } {
  const from = V0_FIT_FROM[spec.id];
  const fit = from ? FITS.fits[from] : undefined;
  if (!fit) throw new Error(`no starting realisation fit for ${spec.id}`);
  return {
    model: { name: fit.name, source: fit.source, potTypes: fit.potTypes },
    from,
    record: {
      method: `v0: solved once on the fitted realisation model of ${from} (${fit.version}, model.hash ${fit.hash}, git ${FITS.commit.slice(0, 8)}), not re-measured (docs/PREFLOP-PLAN.md §4.2)`,
      fitFrom: from,
    },
  };
}

/** The generator's options for a draft set (tree, sizes, rake, ante, straddle). */
export function v0GenerateOptions(spec: RailSetSpec): GenerateOptions {
  return {
    id: spec.id,
    version: spec.version,
    players: spec.seats,
    stackBb: spec.stackBb,
    sizing: spec.sizing,
    maxEntrants: spec.maxEntrants,
    maxLimpers: spec.maxLimpers,
    rake: spec.rake,
    ...(spec.ante ? { ante: spec.ante } : {}),
    ...(spec.straddle ? { straddle: spec.straddle } : {}),
    ...(spec.headsUp ? { headsUp: true } : {}),
  };
}

export function v0Tree(spec: RailSetSpec): PreflopTree {
  const o = v0GenerateOptions(spec);
  return buildPreflopTree({
    players: o.players,
    stackBb: o.stackBb,
    sizing: o.sizing,
    maxEntrants: o.maxEntrants,
    maxLimpers: o.maxLimpers,
    straddle: o.straddle,
    headsUp: o.headsUp,
    ante: o.ante,
  });
}

export interface SolveV0Options {
  equity: PreflopEquityTable;
  /** Final solve's iterations (default `v0Iterations`). */
  iterations?: number;
  /** Measure-and-fit rounds before the final solve (default 0). */
  rounds?: number;
  roundIterations?: number;
  /** Runs the rounds' turn+river solves (worker threads); needed when `rounds` > 0. */
  run?: (jobs: RealisationSpot[]) => Promise<RealisationSample[]>;
  log?: (line: string) => void;
}

export interface SolvedV0Set {
  charts: ChartSetJson;
  text: string;
  totals: SetTotals;
  result: GenerateResult;
  fitFrom: string;
  iterations: number;
  rounds: number;
}

export async function solveV0Set(spec: RailSetSpec, options: SolveV0Options): Promise<SolvedV0Set> {
  const iterations = options.iterations ?? v0Iterations(spec);
  const rounds = options.rounds ?? 0;
  const log = options.log ?? (() => {});
  const fit = v0Fit(spec);
  let last = performance.now();
  const onProgress = (p: { phase: string; iteration?: number; nashConvMbb?: number }) => {
    if (p.phase !== "solve") return;
    const now = performance.now();
    log(`iteration ${p.iteration}: NashConv ${p.nashConvMbb?.toFixed(3)} mbb/hand (${((now - last) / 1000).toFixed(1)} s)`);
    last = now;
  };
  const base = {
    ...v0GenerateOptions(spec),
    equity: options.equity,
    equityBoards: options.equity.boards,
    equitySeed: options.equity.seed,
    iterations,
    onProgress,
  };
  let result: GenerateResult;
  if (rounds > 0) {
    if (!options.run) throw new Error("rounds need a runner for the turn+river solves");
    result = await generateRealisedChartSet({
      ...base,
      rounds,
      roundIterations: options.roundIterations ?? PRODUCTION_ROUND_ITERATIONS,
      start: fit.model,
      fitName: `${spec.version}-fit-${spec.id}`,
      run: options.run,
      onRound: (round) => log(`round ${round.round}: ${round.jobs} turn+river solves; widths ${JSON.stringify(round.widths)}`),
    });
  } else {
    result = generateChartSet({ ...base, realisation: fit.model, realisationFit: fit.record });
  }
  const text = serializeCharts(result.charts);
  const totals = setTotals(loadCharts(JSON.parse(text)));
  return { charts: result.charts, text, totals, result, fitFrom: fit.from, iterations, rounds };
}

/**
 * Times `k` iterations and one exploitability measurement of a draft set's
 * solve, and extrapolates the final solve (a checkpoint every 500
 * iterations, as `generateChartSet`) in minutes. For the dry run.
 */
export function probeV0Set(
  spec: RailSetSpec,
  equity: PreflopEquityTable,
  k: number,
): { actionNodes: number; secondsPerIteration: number; secondsPerCheckpoint: number; estimateMinutes: number } {
  const tree = v0Tree(spec);
  const solver = new PreflopSolver({
    tree,
    equity: equity.equity,
    rake: spec.rake,
    cardRemoval: true,
    realisation: v0Fit(spec).model,
    limpFloor: 0,
  });
  let t0 = performance.now();
  solver.iterate(k);
  const perIteration = (performance.now() - t0) / 1000 / k;
  t0 = performance.now();
  solver.exploitability();
  const perCheckpoint = (performance.now() - t0) / 1000;
  const iterations = v0Iterations(spec);
  const seconds = iterations * perIteration + (Math.ceil(iterations / 500) + 1) * perCheckpoint;
  return {
    actionNodes: tree.actionNodes,
    secondsPerIteration: perIteration,
    secondsPerCheckpoint: perCheckpoint,
    estimateMinutes: seconds / 60,
  };
}

