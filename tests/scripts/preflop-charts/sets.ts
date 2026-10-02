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
 */

import type { PreflopPosition, PreflopSizing } from "../../../frontend/src/lib/solver/preflopTree.js";

export interface SetConfig {
  id: string;
  version: "charts/2" | "charts/3";
  players: readonly PreflopPosition[];
  stackBb: number;
  sizing?: Partial<PreflopSizing>;
  rounds: number;
  /** The realisation model the first round solves with. */
  start: "charts/1" | "charts/2-fit";
  fitName: string;
}

const SIX: readonly PreflopPosition[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const NINE: readonly PreflopPosition[] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/**
 * Sizes by depth. 100bb and deeper keep `charts/2`'s (2.5bb opens, SB 3bb,
 * 3-bets 3x / 4x, 4-bets 2.2x / 2.5x, 5-bet all-in). At 40bb the open is
 * 2.2bb (rounded to 0.1bb), and a raise that puts more than 40% of the stack
 * in is all-in - which makes every 40bb 4-bet a shove and, at 60bb, the 4-bet
 * over a squeeze. Nothing at 100bb or deeper reaches 40% before the 5-bet.
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

export const SET_CONFIGS: readonly SetConfig[] = [
  {
    id: "nlhe-cash-6max-100bb",
    version: "charts/2",
    players: SIX,
    stackBb: 100,
    rounds: 3,
    start: "charts/1",
    fitName: "charts/2-solver-fit",
  },
  a2c(NINE, 100, STANDARD),
  a2c(SIX, 150, STANDARD),
  a2c(SIX, 200, STANDARD),
  a2c(NINE, 150, STANDARD),
  a2c(NINE, 200, STANDARD),
  a2c(SIX, 60, STANDARD),
  a2c(SIX, 40, SHORT),
];

export function setConfig(id: string): SetConfig {
  const config = SET_CONFIGS.find((c) => c.id === id);
  if (!config) throw new Error(`no chart set ${id}; known: ${SET_CONFIGS.map((c) => c.id).join(", ")}`);
  return config;
}
