/**
 * A preflop line of the flop library as a solvable spot: both players' ranges
 * as the charts play the line, the pot and the stacks at the flop.
 *
 * The ranges come from the analysis' own walk (`walkRanges` → `preflop`) on a
 * hand scripted from the line (`lib/training`), so a library spot starts from
 * exactly the ranges the analysis gives a real hand on that line: the same
 * `chartRange` reads both.
 */

import type { ChartSet } from "../../../frontend/src/lib/charts/index.js";
import { walkRanges } from "../../../frontend/src/lib/analysis/rangeWalk.js";
import { flopPlayersOf, lineSeats, type FlopLine } from "../../../frontend/src/lib/analysis/flopLibrary.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";
import { NINE_SCRIPT_POSITIONS, scriptHand, scriptMoney, seatOf, type HandScript } from "../../../frontend/src/lib/training/handText.js";
import { lineActs } from "../../../frontend/src/lib/training/preflop.js";

export interface LineSpot {
  line: FlopLine;
  /** Out of position first. */
  players: [string, string];
  /** 1,326 weights each, out of position first, before any board card is removed. */
  ranges: [Float64Array, Float64Array];
  /** Pot at the flop and the effective stack behind, bb. */
  pot: number;
  stack: number;
}

/** The spot of a line under a chart set. Throws when the charts cannot play the line. */
export function lineSpot(charts: ChartSet, line: FlopLine): LineSpot {
  if (charts.game.players !== line.players) throw new Error(`line ${line.id} is spelled for ${line.players}-max, the set is ${charts.game.players}-max`);
  const [oop, ip] = flopPlayersOf(line.key, lineSeats(line));
  const seats = line.players === 9 ? NINE_SCRIPT_POSITIONS : undefined;
  const preflop = lineActs(charts, line.key);
  // Any flop will do: the walk's preflop ranges are read before the board.
  const script: HandScript = {
    id: `FL${line.id.replace(/[^a-z0-9]/gi, "")}`,
    seats,
    hero: oop,
    heroCards: null,
    stackBb: charts.game.stackBb,
    preflop,
    board: ["2c", "3d", "4h"],
    flop: [{ position: oop, type: "check" }],
  };
  const hand = scriptHand(script);
  const walk = walkRanges(hand, buildContext(hand), seatOf(oop, seats), seatOf(ip, seats), charts);
  if (!walk.ok) throw new Error(`line ${line.id}: no range walk (${walk.reason})`);
  if (walk.sources.hero !== "chart" || walk.sources.villain !== "chart") {
    throw new Error(`line ${line.id}: the charts give no range for ${walk.sources.hero === "chart" ? ip : oop}`);
  }
  const money = scriptMoney({ ...script, flop: [] });
  const pot = money.streetPot.flop ?? 0;
  const behind: Partial<Record<string, number>> = money.streetBehind.flop ?? {};
  const stack = Math.min(behind[oop] ?? 0, behind[ip] ?? 0);
  return { line, players: [oop, ip], ranges: [walk.preflop.hero, walk.preflop.villain], pot, stack };
}
