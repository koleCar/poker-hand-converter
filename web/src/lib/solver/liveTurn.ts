/**
 * The turn and river of a flop library chunk, solved on demand (the Solver
 * library's live turn).
 *
 * A chunk keeps the flop's decisions and stops at each turn deal. Everything
 * a turn solve needs is already in it: both players' ranges on arrival at the
 * deal (the preflop ranges times each player's flop strategy along the line,
 * `rangesAt`), the pot and the stacks the flop's betting left, the rake. This
 * builds that turn game for one dealt card and solves it through a coarse
 * river - the same tree turn grading solves (`lib/analysis/turn.ts`), to a
 * tighter target - so no turn has to be stored: a full solve's turn files are
 * ~10 MB each and ~3 GB a flop, the chunk ~100 KB.
 *
 * The result is an ordinary turn `SolveResult` (`nodes: "all"`, the rivers
 * included), read by `explore.ts` exactly as a full solve's turn file is:
 * players keep the chunk's indices, so `header.players` still names them.
 *
 * Not the same numbers as a full solve's turn: a turn re-solved from fixed
 * ranges is one equilibrium of that subgame, not necessarily the one the flop
 * solve played into, and the river here is one size and all-in.
 */

import { comboHi, comboLo, NUM_COMBOS } from "./combos";
import { cardCode } from "../equity";
import type { FlopChunk } from "./flopLibrary";
import { spotSymmetries, symmetrize } from "./isomorphism";
import { rangesAt, solveTurn, type SolveOptions, type SolveResult } from "./solve";
import type { BetMenu } from "./betting";
import type { TurnSpot } from "./subgame";

/** The turn's bet menu: 75% and all-in up to three pots, one raise of 75%. Turn grading's (`TURN_MENU`). */
export const LIVE_TURN_MENU: Readonly<BetMenu> = { bet: [0.75], raise: [0.75], allIn: true, allInMaxPot: 3 };
/** The river below it: 75% and all-in, no raise (`TURN_RIVER_MENU`). */
export const LIVE_RIVER_MENU: Readonly<BetMenu> = { bet: [0.75], raise: [], allIn: true };

/** How a live turn is solved. */
export const LIVE_TURN = {
  menu: LIVE_TURN_MENU,
  riverMenu: LIVE_RIVER_MENU,
  raiseCap: 1,
  riverRaiseCap: 0,
  allInThreshold: 0.1,
  minBet: 1,
  /** % of the pot at the start of the turn: tighter than grading's 1%, a study view shows the numbers themselves. */
  targetPct: 0.5,
  maxIterations: 400,
  checkFrom: 30,
  checkEvery: 10,
  dcfr: { alpha: 1.5, beta: 0, gamma: 3 },
} as const;

/** A combo under this share of the range's largest weight is left out (`PRUNE_SHARE`, river.ts). */
const PRUNE_SHARE = 0.002;

export class LiveTurnError extends Error {}

/** What the flop's betting leaves at a turn deal: the pot and the effective stack, bb. */
export interface TurnDeal {
  pot: number;
  stack: number;
}

/**
 * The pot and stack at a chance node of a chunk, or null when nothing is left
 * to bet (an all-in on the flop: the turn and river just run out).
 */
export function turnDeal(chunk: FlopChunk, chance: number): TurnDeal | null {
  const nodes = chunk.result.nodes;
  const node = nodes[chance];
  if (!node || node.kind !== "chance") throw new LiveTurnError(`node ${chance} is not a deal`);
  const parent = nodes[node.parent];
  if (!parent || parent.kind !== "action") throw new LiveTurnError(`deal ${chance} has no decision above it`);
  const action = parent.actions[node.parentEdge];
  if (!action) throw new LiveTurnError(`deal ${chance}: no action ${node.parentEdge}`);
  // The decision that closed the flop: its pot already holds every bet in, plus what this action adds.
  const pot = parent.pot + action.amount;
  const stack = parent.behind - action.amount;
  return stack > 1e-9 ? { pot, stack } : null;
}

/** Both ranges over all 1326 combos as the turn card comes: the flop's narrowing, the card's combos out. */
function rangesAtDeal(chunk: FlopChunk, chance: number, card: string): [Float64Array, Float64Array] {
  const reach = rangesAt(chunk.result, chance);
  const out: [Float64Array, Float64Array] = [new Float64Array(NUM_COMBOS), new Float64Array(NUM_COMBOS)];
  for (let p = 0; p < 2; p += 1) {
    chunk.result.hands[p].forEach((combo, i) => {
      if (cardCode(comboHi(combo)) === card || cardCode(comboLo(combo)) === card) return;
      out[p][combo] = reach[p][i];
    });
  }
  return out;
}

function pruned(range: Float64Array): Float64Array {
  let max = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) max = Math.max(max, range[c]);
  const out = new Float64Array(NUM_COMBOS);
  const floor = max * PRUNE_SHARE;
  for (let c = 0; c < NUM_COMBOS; c += 1) if (range[c] >= floor && range[c] > 0) out[c] = range[c];
  return out;
}

/**
 * The turn game of a chunk's deal and one turn card (the chunk's canonical
 * suits, one of the deal's labels). Player indices are the chunk's.
 */
export function liveTurnSpot(chunk: FlopChunk, chance: number, card: string): TurnSpot {
  const node = chunk.result.nodes[chance];
  if (!node || node.kind !== "chance") throw new LiveTurnError(`node ${chance} is not a deal`);
  if (!node.labels.includes(card)) throw new LiveTurnError(`deal ${chance} does not deal ${card}`);
  const deal = turnDeal(chunk, chance);
  if (!deal) throw new LiveTurnError(`deal ${chance}: all-in, nothing left to solve`);
  const board = [...chunk.result.board, card];
  const raw = rangesAtDeal(chunk, chance, card);
  // Symmetric first, then pruned: pruning a range symmetric up to float noise
  // could keep one combo of a suit pair and drop its twin, and lose the solve its isomorphism.
  const group = spotSymmetries(board, raw);
  const ranges: [Float64Array, Float64Array] = [pruned(symmetrize(raw[0], group)), pruned(symmetrize(raw[1], group))];
  const { rake } = chunk.header;
  return {
    board,
    ranges,
    pot: deal.pot,
    stack: deal.stack,
    // The flop's first actor is out of position on the turn too.
    firstToAct: chunk.result.firstToAct,
    menus: [LIVE_TURN.menu, LIVE_TURN.menu],
    riverMenus: [LIVE_TURN.riverMenu, LIVE_TURN.riverMenu],
    raiseCap: LIVE_TURN.raiseCap,
    riverRaiseCap: LIVE_TURN.riverRaiseCap,
    allInThreshold: LIVE_TURN.allInThreshold,
    minBet: LIVE_TURN.minBet,
    rake: { percent: rake.percent, cap: rake.cap },
    bigBlind: 1,
    isomorphism: true,
  };
}

export interface LiveTurnProgress {
  iteration: number;
  /** The last measurement, % of the pot; null before the first. */
  exploitabilityPct: number | null;
}

/** Solves the turn (and the rivers below it) of a chunk's deal and turn card. */
export function solveLiveTurn(
  chunk: FlopChunk,
  chance: number,
  card: string,
  onProgress?: (progress: LiveTurnProgress) => void,
  options: Partial<Pick<SolveOptions, "targetExploitability" | "maxIterations">> = {},
): SolveResult {
  const spot = liveTurnSpot(chunk, chance, card);
  let last: number | null = null;
  return solveTurn(spot, {
    maxIterations: options.maxIterations ?? LIVE_TURN.maxIterations,
    targetExploitability: options.targetExploitability ?? LIVE_TURN.targetPct,
    checkFrom: LIVE_TURN.checkFrom,
    checkEvery: LIVE_TURN.checkEvery,
    dcfr: LIVE_TURN.dcfr,
    nodes: "all",
    onProgress: (p) => {
      last = p.exploitability.percentPot;
      onProgress?.({ iteration: p.iteration, exploitabilityPct: last });
    },
    onIteration: (iteration) => {
      if (iteration % 5 === 0) onProgress?.({ iteration, exploitabilityPct: last });
    },
  });
}
