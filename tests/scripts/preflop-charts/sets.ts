/**
 * Every committed chart set and how it is generated (docs/CHARTS.md §6, §10).
 *
 * The runtime registry (`frontend/src/lib/charts/registry.ts`) lists the same
 * ids with their table and depth; everything a set's numbers depend on
 * (sizes, rounds, the starting realisation model) is here and is recorded in
 * the set's own `model`.
 *
 * - `nlhe-cash-6max-100bb` is `charts/2` (A2a.1): three rounds from the
 *   hand-set `charts/1` model. Regenerating it with this config writes the
 *   committed bytes.
 * - The A2c sets (`charts/3`) run the same pipeline at their own table and
 *   depth - the realisation is re-measured on their own ranges at their own
 *   stack-to-pot ratios - starting from `charts/2`'s fitted model, with two
 *   rounds instead of three (the start is already a fit).
 * - `charts/4` (A2d) adds the limp tree to every set (`maxLimpers`, the
 *   tremble `limpFloor`, nodes behind a limp kept down to `minLimpReach`) and
 *   solves it once with the set's own committed realisation fit
 *   (`reuseFit`): no new measurement rounds. The fit's spots are heads-up
 *   raised pots and the blinds' limped pot, whose ranges a tremble of 0.5%
 *   barely moves (docs/CHARTS.md §6.7), and re-measuring every set would
 *   cost hours more. The fit's own record (`model.realisationFit`) is carried
 *   over with a note, so a rerun reads the same model and writes the same
 *   bytes.
 * - `charts/6` solves the two 200bb `charts/4` sets for 9,000 iterations
 *   instead of 3,000 (`deep`, docs/CHARTS.md §5.1); nothing else changes.
 * - `charts/7` does the same for the 9-max 150bb set (`deep`, version
 *   `charts/7`, docs/CHARTS.md §5.1).
 */

import type { PreflopPosition, PreflopSizing, PreflopStraddle } from "../../../frontend/src/lib/solver/preflopTree.js";

export interface SetConfig {
  id: string;
  version: "charts/2" | "charts/3" | "charts/4" | "charts/5" | "charts/6" | "charts/7";
  players: readonly PreflopPosition[];
  stackBb: number;
  sizing?: Partial<PreflopSizing>;
  rounds: number;
  /** The realisation model the first round solves with. */
  start: "charts/1" | "charts/2-fit";
  fitName: string;
  /** Solve once with the committed set's own fitted realisation model (no rounds). */
  reuseFit?: boolean;
  /** Open limps up to this many limpers (`charts/4`). */
  maxLimpers?: number;
  /** The open limp's tremble. */
  limpFloor?: number;
  /** Nodes behind an open limp are kept down to this reach. */
  minLimpReach?: number;
  /** A straddle by the first seat left of the big blind (`charts/5`). */
  straddle?: PreflopStraddle;
  /** Iterations of the final solve (default `PRODUCTION_ITERATIONS`, 3,000; `CHARTS_ITERATIONS` overrides). */
  iterations?: number;
}

/**
 * The limp tree of every `charts/4` set (docs/CHARTS.md §1.3): at most three
 * limpers, a 0.5% tremble, nodes behind a limp kept down to 1e-6 of hands.
 */
export const LIMPS = { maxLimpers: 3, limpFloor: 0.005, minLimpReach: 1e-6 } as const;

const SIX: readonly PreflopPosition[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const NINE: readonly PreflopPosition[] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/**
 * Sizes by depth. 100bb and deeper keep `charts/2`'s (2.5bb opens, SB 3bb,
 * 3-bets 3x / 4x, 4-bets 2.2x / 2.5x, 5-bet all-in). At 40bb the open is
 * 2.2bb (rounded to 0.1bb), and a raise that puts more than 40% of the stack
 * in is all-in - which makes most 40bb 4-bets shoves (all but 2.2x of an
 * in-position 3-bet) and, at 60bb, the 4-bet over a squeeze or over the
 * small blind's re-raise of an iso.
 * Nothing at 100bb or deeper reaches 40% before the 5-bet.
 */
const ALL_IN_ABOVE = 0.4;
const SHORT: Partial<PreflopSizing> = { open: 2.2, roundTo: 0.1, allInAbove: ALL_IN_ABOVE };
const STANDARD: Partial<PreflopSizing> = { allInAbove: ALL_IN_ABOVE };

const a2c = (players: readonly PreflopPosition[], stackBb: number, sizing: Partial<PreflopSizing>): SetConfig => ({
  id: `nlhe-cash-${players.length}max-${stackBb}bb`,
  version: "charts/3",
  players,
  stackBb,
  sizing,
  rounds: 2,
  start: "charts/2-fit",
  fitName: `charts/3-solver-fit-${players.length}max-${stackBb}bb`,
});

/** A `charts/4` set: the A2c configuration plus the limp tree, solved once on its committed fit. */
const a2d = (config: SetConfig): SetConfig => ({ ...config, version: "charts/4", reuseFit: true, ...LIMPS });

/**
 * `charts/6`: the 200bb sets' limp trees solved for 9,000 iterations instead
 * of 3,000 (docs/CHARTS.md §5.1). Their big blind facing a single limp kept
 * early regrets that the 0.5% tremble's tiny counterfactual weights take
 * thousands of iterations to wear down: after 3,000 its average mix still
 * lost 2.2-2.8% of the pot for a class, and the node was left out as
 * unconverged. Same fit, same tree, same engine; only the solve is longer.
 * `charts/7` gives the 9-max 150bb set the same 9,000: at 3,000 its big
 * blind behind an HJ limp lost 2.42% (AQo), crossing 2% at ~3,700.
 */
export const DEEP_ITERATIONS = 9000;
const deep = (config: SetConfig, version: "charts/6" | "charts/7" = "charts/6"): SetConfig => ({
  ...a2d(config),
  version,
  iterations: DEEP_ITERATIONS,
});

/**
 * `charts/5` (A2e): the 6-max 100bb set with a 2bb straddle from UTG
 * (docs/CHARTS.md §1.4). A third blind: the action starts at the HJ and the
 * straddler has the option last. Every size the big blind sets is doubled -
 * the open is 2.5 straddles (5bb), the small blind's and the big blind's
 * raise first in 3 straddles (6bb), an isolation 4 straddles (8bb) plus one
 * per further limper and one out of position; 3-bets and 4-bets are the same
 * multiples of the raise. At 100bb that is a 50-straddle game, so the
 * `allInAbove` rule makes the 4-bet over a 4x (out of position) 3-bet a shove.
 * The limp tree and its tremble as in `charts/4`. The realisation is
 * measured on its own ranges, A2c's way (two rounds from `charts/2`'s fit),
 * on the straddled tree's own spots (`STRADDLE_REALISATION_SPOTS`): the
 * stack-to-pot ratios of a straddled pot are a 50bb game's, and the
 * straddler is a blind the fitted spots never saw.
 */
const STRADDLE: SetConfig = {
  id: "nlhe-cash-6max-100bb-straddle",
  version: "charts/5",
  players: SIX,
  stackBb: 100,
  sizing: { open: 5, sbOpen: 6, isoVsLimp: 8, isoPerLimper: 2, isoOop: 2, allInAbove: ALL_IN_ABOVE },
  rounds: 2,
  start: "charts/2-fit",
  fitName: "charts/5-solver-fit-6max-100bb-straddle",
  ...LIMPS,
  straddle: { position: "UTG", bb: 2 },
};

/**
 * Every committed set, in the order the limp refusals of the owner's library
 * ask for them (A2d: 9-max 100bb 399, 6-max 100bb 284, 6-max 150bb 90, 9-max
 * 150bb 77, 9-max 200bb 60, 6-max 60bb 18, 6-max 200bb 3, 6-max 40bb 2).
 * The 6-max 100bb set keeps `charts/2`'s sizes and its `charts/2` fit.
 */
export const SET_CONFIGS: readonly SetConfig[] = [
  a2d(a2c(NINE, 100, STANDARD)),
  a2d({
    id: "nlhe-cash-6max-100bb",
    version: "charts/2",
    players: SIX,
    stackBb: 100,
    rounds: 3,
    start: "charts/1",
    fitName: "charts/2-solver-fit",
  }),
  a2d(a2c(SIX, 150, STANDARD)),
  deep(a2c(NINE, 150, STANDARD), "charts/7"),
  deep(a2c(NINE, 200, STANDARD)),
  a2d(a2c(SIX, 60, STANDARD)),
  deep(a2c(SIX, 200, STANDARD)),
  a2d(a2c(SIX, 40, SHORT)),
  STRADDLE,
];

export function setConfig(id: string): SetConfig {
  const config = SET_CONFIGS.find((c) => c.id === id);
  if (!config) throw new Error(`no chart set ${id}; known: ${SET_CONFIGS.map((c) => c.id).join(", ")}`);
  return config;
}
