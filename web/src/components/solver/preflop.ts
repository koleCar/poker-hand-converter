/**
 * The Solver library's preflop line, seat by seat (the bar of position cards
 * above the grid): who has acted and how, who is to act and with which
 * options, what each stack has behind, and where the line ends.
 *
 * ```
 * a chart set + a line key (`fffr…`, the charts' own spelling)
 *   ─▶ walk it node by node: each letter is the actor's option at that node
 *   ─▶ a decision still to make (the chart node, its options)
 *      or the end: everyone folded to one player, a multiway flop, an all-in,
 *      or a heads-up flop - on a library line (`sameLine`) or not
 *   ─▶ for each seat still to act this round: the decision it would face if
 *      every seat before it folds (`SeatState.ahead`), so a later seat's
 *      option can be picked straight away, as a solver's viewer allows
 * ```
 *
 * Pure: no React, no fetch. Positions and amounts come from the chart set,
 * so heads-up, 6-max and full ring read alike.
 */

import { sameLine, type FlopLine } from "../../lib/analysis/flopLibrary";
import type { ChartAction, ChartNode, ChartPosition, ChartSet } from "../../lib/charts";

export interface SeatAct {
  /** Index of the letter in the line key: rewinding to it drops this act and everything after. */
  index: number;
  action: ChartAction;
  /** What the seat has in after the act, bb. */
  toBb: number;
}

export interface SeatState {
  position: ChartPosition;
  /** Chips behind, bb. */
  stackBb: number;
  /** Chips in the pot so far, bb. */
  inBb: number;
  folded: boolean;
  acts: SeatAct[];
  /**
   * The decision this seat would face if the seat to act and every seat
   * between them fold: the line to that node and its options (picking one
   * appends its code). Only for seats that have not acted yet; null when the
   * folds never reach the seat (the hand ends, a seat that has acted is next,
   * or a seat on the way cannot fold).
   */
  ahead: { line: string; node: ChartNode } | null;
}

export type PreflopEnd =
  | { kind: "flop"; players: [ChartPosition, ChartPosition]; line: FlopLine | null }
  | { kind: "multiway"; players: ChartPosition[] }
  | { kind: "allin" }
  | { kind: "folded"; winner: ChartPosition };

export interface PreflopState {
  /** The line as walked: a malformed tail is cut off. */
  line: string;
  seats: SeatState[];
  /** The decision to make, or null when the line has ended. */
  node: ChartNode | null;
  end: PreflopEnd | null;
  potBb: number;
}

const BLINDS: Partial<Record<ChartPosition, number>> = { SB: 0.5, BB: 1 };

/** Walks `line` through the chart set; `lines` are the library's lines for its table (`flopLinesFor`). */
export function preflopState(charts: ChartSet, line: string, lines: readonly FlopLine[]): PreflopState {
  const positions = charts.game.positions;
  const stack = charts.game.stackBb;
  const seats: SeatState[] = positions.map((position) => {
    const blind = BLINDS[position] ?? 0;
    return { position, stackBb: stack - blind, inBb: blind, folded: false, acts: [], ahead: null };
  });
  const seatOf = (position: ChartPosition) => seats.find((seat) => seat.position === position)!;

  let walked = "";
  let allIn = false;
  for (let index = 0; index < line.length; index += 1) {
    const node = charts.nodes.get(walked);
    const option = node?.options.find((o) => o.code === line[index]);
    if (!node || !option) break;
    const seat = seatOf(node.actor);
    seat.acts.push({ index, action: option.action, toBb: option.toBb });
    if (option.action === "fold") seat.folded = true;
    else {
      seat.inBb = option.toBb;
      seat.stackBb = stack - option.toBb;
    }
    if (option.action === "allin") allIn = true;
    walked += line[index];
  }

  const potBb = seats.reduce((sum, seat) => sum + seat.inBb, 0);
  const node = charts.nodes.get(walked) ?? null;
  if (node) {
    foldAhead(charts, walked, node, seats);
    return { line: walked, seats, node, end: null, potBb };
  }

  const live = seats.filter((seat) => !seat.folded).map((seat) => seat.position);
  let end: PreflopEnd;
  if (live.length === 1) end = { kind: "folded", winner: live[0] };
  else if (allIn) end = { kind: "allin" };
  else if (live.length > 2) end = { kind: "multiway", players: live };
  else {
    const solved = lines.find((candidate) => sameLine(candidate.key, walked)) ?? null;
    end = { kind: "flop", players: [live[0], live[1]], line: solved };
  }
  return { line: walked, seats, node: null, end, potBb };
}

/**
 * Folds from the node to act onwards, giving each seat that has not acted
 * yet the node it reaches (`SeatState.ahead`). Stops where a seat that has
 * acted is next to decide - folding it is a choice of its own, not the
 * "everyone in between folds" a later pick assumes - or where nobody else
 * acts.
 */
function foldAhead(charts: ChartSet, line: string, node: ChartNode, seats: SeatState[]): void {
  let at = node;
  let walked = line;
  for (let step = 0; step < seats.length; step += 1) {
    const fold = at.options.find((option) => option.action === "fold");
    if (!fold) return;
    walked += fold.code;
    const next = charts.nodes.get(walked);
    if (!next) return;
    const seat = seats.find((candidate) => candidate.position === next.actor)!;
    if (seat.acts.length > 0 || seat.ahead) return;
    seat.ahead = { line: walked, node: next };
    at = next;
  }
}
