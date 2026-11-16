/**
 * One flop library job - a (line, flop) solve - built from a chart set, and
 * the `FlopSpot` it solves. Shared by the batch runner
 * (`tests/scripts/flop-library`), which writes the library, and the desktop
 * app's nodelock (`docs/NODELOCK.md` §2.3), which re-solves a library spot
 * with locks: both build the spot here, so a nodelock starts from exactly
 * the game the library chunk was solved on.
 *
 * ```
 * chart set + line ─ lineSpot ─▶ ranges, pot, stack (the analysis' own range walk)
 *                  ─ jobOf ────▶ Job (plain data: crosses a process or a worker)
 *                  ─ jobSpot ──▶ FlopSpot (FLOP_PROFILE's tree, rake, isomorphism)
 * ```
 *
 * Not re-exported from `lib/analysis/index.ts`: it reaches the hand
 * scripting of `lib/training`, which the analysis worker does not need.
 */

import type { ChartSet } from "../charts";
import { flopCards, FLOPLIB_VERSION, SOLVER_VERSION, type FlopChunkHeader, type FlopSpot } from "../solver";
import { buildContext } from "../stats/context";
import { HEADS_UP_SCRIPT_POSITIONS, NINE_SCRIPT_POSITIONS, scriptHand, scriptMoney, seatOf, type HandScript } from "../training/handText";
import { lineActs } from "../training/preflop";
import { chartLineHash, FLOP_PROFILE, flopLinesFor, flopPlayersOf, libraryLineById, lineSeats, type FlopLine, type FlopProfile } from "./flopLibrary";
import { walkRanges } from "./rangeWalk";
import { rakeOf } from "./river";

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

/**
 * The spot of a line under a chart set: both players' ranges as the charts
 * play the line, the pot and the stacks at the flop. The ranges come from
 * the analysis' own walk (`walkRanges` → `preflop`) on a hand scripted from
 * the line (`lib/training`), so a library spot starts from exactly the
 * ranges the analysis gives a real hand on that line. Throws when the
 * charts cannot play the line.
 */
export function lineSpot(charts: ChartSet, line: FlopLine): LineSpot {
  if (charts.game.players !== line.players) throw new Error(`line ${line.id} is spelled for ${line.players}-max, the set is ${charts.game.players}-max`);
  const [oop, ip] = flopPlayersOf(line.key, lineSeats(line));
  const seats = line.players === 9 ? NINE_SCRIPT_POSITIONS : line.players === 2 ? HEADS_UP_SCRIPT_POSITIONS : undefined;
  const preflop = lineActs(charts, line.key);
  // Any flop will do: the walk's preflop ranges are read before the board.
  const script: HandScript = {
    id: `FL${line.id.replace(/[^a-z0-9]/gi, "")}`,
    seats,
    hero: oop,
    heroCards: null,
    stackBb: charts.game.stackBb,
    // An ante set's charts are read only for a hand that posts its ante.
    ante: charts.game.ante,
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

export interface Job {
  /** `<line>/<flop>`: unique, and the chunk's path below the tree directory. */
  id: string;
  line: string;
  lineKey: string;
  flop: string;
  players: [string, string];
  /** 1,326 weights each, out of position first. */
  ranges: [number[], number[]];
  pot: number;
  stack: number;
  charts: FlopChunkHeader["charts"];
  /** `chartLineHash` of the line under the set (the chunk stays readable across re-transcriptions that leave the line alone). */
  lineHash?: string;
  rake: FlopChunkHeader["rake"];
  /** Defaults to `FLOP_PROFILE`; tests pass a small one. */
  profile?: FlopProfile;
}

/** A line of a chart set by id: one of its table's fixed lines, or an extra heads-up line (`x-<key>`). */
export function libraryLineOf(charts: ChartSet, lineId: string): FlopLine | null {
  return flopLinesFor(charts.game.players).find((l) => l.id === lineId) ?? libraryLineById(charts, lineId) ?? null;
}

/** The job of a line's spot on a canonical flop (`flop`: a flop key, e.g. `Ks5h3s`). */
export function jobOf(charts: ChartSet, line: FlopLine, spot: LineSpot, flop: string): Job {
  const rake = rakeOf(charts);
  return {
    id: `${line.id}/${flop}`,
    line: line.id,
    lineKey: line.key,
    flop,
    players: spot.players,
    ranges: [Array.from(spot.ranges[0]), Array.from(spot.ranges[1])],
    pot: spot.pot,
    stack: spot.stack,
    charts: { id: charts.id, version: charts.version, hash: charts.model.hash },
    lineHash: chartLineHash(charts, line.key) ?? undefined,
    rake: { name: rake.name, percent: rake.percent, cap: rake.cap },
  };
}

/** The library job of a line (by id) and a flop key. Throws on an unknown or unplayable line. */
export function libraryJob(charts: ChartSet, lineId: string, flop: string): Job {
  const line = libraryLineOf(charts, lineId);
  if (!line) throw new Error(`unknown line ${lineId} in ${charts.id}`);
  return jobOf(charts, line, lineSpot(charts, line), flop);
}

/** The `FlopSpot` a job solves: its ranges, pot, stack and rake on the profile's tree, with suit isomorphism. */
export function jobSpot(job: Job): FlopSpot {
  const p = job.profile ?? FLOP_PROFILE;
  return {
    board: flopCards(job.flop),
    ranges: [Float64Array.from(job.ranges[0]), Float64Array.from(job.ranges[1])],
    pot: job.pot,
    stack: job.stack,
    firstToAct: 0,
    menus: [p.flopMenu, p.flopMenu],
    raiseCap: p.flopRaiseCap,
    turnMenus: [p.turnMenu, p.turnMenu],
    turnRaiseCap: p.turnRaiseCap,
    riverMenus: [p.riverMenu, p.riverMenu],
    riverRaiseCap: p.riverRaiseCap,
    allInThreshold: p.allInThreshold,
    minBet: p.minBet,
    rake: { percent: job.rake.percent, cap: job.rake.cap },
    bigBlind: 1,
    isomorphism: true,
  };
}

/** The chunk header of a job's solve. */
export function jobHeader(job: Job): FlopChunkHeader {
  const p = job.profile ?? FLOP_PROFILE;
  return {
    version: FLOPLIB_VERSION,
    solver: SOLVER_VERSION,
    charts: job.charts,
    tree: p.tree,
    line: job.line,
    lineKey: job.lineKey,
    ...(job.lineHash ? { lineHash: job.lineHash } : {}),
    players: job.players,
    flop: job.flop,
    pot: job.pot,
    stack: job.stack,
    rake: job.rake,
    targetPct: p.targetPct,
  };
}

/**
 * The exact `FlopSpot` the library solved for a line and flop of a chart set
 * (`docs/NODELOCK.md` §2.3): what a nodelock re-solves, locks added.
 */
export function nodelockSpot(charts: ChartSet, line: string, flop: string): FlopSpot {
  return jobSpot(libraryJob(charts, line, flop));
}
