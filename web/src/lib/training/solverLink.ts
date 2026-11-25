/**
 * A dealt trainer spot in the Solver library (#420: the Trainer's "Look up in
 * Solver" after an answer), as near as the library holds it - the same rules
 * the replayer's "Open in Solver" follows for a hand's decision
 * (`solverLinkOf`, the app's `solver/handSpot.ts`):
 *
 * - preflop: the chart node the spot was dealt from (its set and line);
 * - flop: the library's line and the spot's own flop, at the node's path in
 *   the solve the spot was dealt from;
 * - turn and river: the hand's line from the flop on (`handWalk`), which the
 *   library follows onto the turn it solves live and that turn's river. A
 *   flop the library holds only by its representative stops at the turn's
 *   deal (`approx: "flop"`);
 * - a postflop spot whose flop the library does not hold at all: the preflop
 *   line it went to the flop on (`approx: "preflop"`).
 *
 * Pure apart from the library's manifest (`has`), which the caller loads.
 */

import { chartLineOf, chunkFor, flopPair, type FlopLibrary } from "../analysis/flopLibrary";
import { encodeWalk, handWalk } from "../analysis/solverWalk";
import type { ChartSet } from "../charts";
import { buildContext } from "../stats/context";
import type { TrainerSpot } from "./jobs";

export interface TrainerSolverLink {
  /** The chart set. */
  set: string;
  /** The preflop line, in the charts' letters. */
  line: string;
  /** The flop as the library reads it (the spot's own, or its representative); null preflop. */
  flop: string | null;
  /** A flop spot's node in its solve (`X-B1.8`). */
  path: string | null;
  /** A turn or river spot's line from the flop (`x-b33-c-Kh-x`). */
  walk: string | null;
  /** What the link stands in for when it is not the spot itself: its flop, or its preflop line. */
  approx: "flop" | "preflop" | null;
}

export function trainerSolverLink(spot: TrainerSpot, charts: ChartSet, library: FlopLibrary | null): TrainerSolverLink | null {
  if (spot.kind === "preflop") return { set: spot.set, line: spot.line, flop: null, path: null, walk: null, approx: null };
  let context: ReturnType<typeof buildContext>;
  try {
    context = buildContext(spot.hand);
  } catch {
    return null;
  }
  const pair = flopPair(context);
  const placed = pair ? chartLineOf(spot.hand, pair, charts) : null;
  if (!placed) return null;
  const want = library ? chunkFor(spot.hand, context, charts, library) : null;
  if (!want) return { set: placed.set.id, line: placed.line, flop: null, path: null, walk: null, approx: "preflop" };
  const own = spot.board.slice(0, 3).join("");
  const flop = want.exact && own.length === 6 ? own : want.flop;
  if (spot.kind === "flop") return { set: want.set, line: want.line.key, flop, path: spot.path, walk: null, approx: null };
  // Every action of the spot's hand is before the hero's decision: the hand stops there.
  const steps = handWalk(spot.hand, { street: spot.kind, actionIndex: Number.POSITIVE_INFINITY, facts: { board: spot.board } });
  if (!steps) return { set: want.set, line: want.line.key, flop, path: null, walk: null, approx: "flop" };
  // A representative flop has none of the spot's turns and rivers: its walk stops at the turn's deal.
  const firstCard = steps.findIndex((step) => step.kind === "card");
  const cut = !want.exact && firstCard >= 0;
  return {
    set: want.set,
    line: want.line.key,
    flop,
    path: null,
    walk: encodeWalk(cut ? steps.slice(0, firstCard) : steps) || null,
    approx: cut ? "flop" : null,
  };
}
