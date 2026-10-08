/**
 * The range paint (Learn L3, the `range-paint` exercise): the learner paints
 * a range on the 13×13 grid, and Rail grades it cell by cell against its own
 * numbers.
 *
 * ```
 * chart: a chart set's first-in node for a seat     ─▶ per class: the share the chart plays (raises or limps)
 * river: a river spot's solve (river.ts), the hero's node, drawn as the split draws it (split.ts)
 *        ─▶ per class: the reach-weighted share that bets (first to act or checked to),
 *           or that continues, calls or raises (facing a bet)
 * answer ─▶ one painted / not painted per cell ─▶ gradePaint
 * ```
 *
 * **The tolerance** (`PAINT_IN`, `PAINT_OUT`): a cell Rail plays at least
 * 75% of the time must be painted, one it plays at most 25% must not be, and
 * a cell in between is mixed and right either way. The score is over the
 * cells that matter — every cell that must be painted, and every cell the
 * learner painted — weighted by combos (the chart: 6, 4 or 12; the river: the
 * reach-weighted combos left at the node), so a missed pocket pair costs
 * what it holds and an empty corner of the grid costs nothing. An item is
 * right at `PAINT_PASS` of that weight.
 *
 * Pure and deterministic in its seed; the item carries Rail's numbers, so the
 * screen grades without asking the worker again.
 */

import type { ChartNode, ChartPosition, ChartSet } from "../charts";
import { CLASS_COMBOS, COMBO_CLASS, rangesAt, type SolveResult } from "../solver";
import { heroNode } from "./flop";
import { pickOne, seeded } from "./rng";
import { MAX_ATTEMPTS, riverSetup, type RiverPot, type RiverRole, type RiverSeat } from "./river";

/** A cell Rail plays at least this often must be painted. */
export const PAINT_IN = 0.75;
/** A cell Rail plays at most this often must be left empty. */
export const PAINT_OUT = 0.25;
/** Share of the weight that matters an item needs right to count as right. */
export const PAINT_PASS = 0.8;
/** A river class with fewer reach-weighted combos than this is not in the range at the node: not shown, not graded. */
export const PAINT_MIN_COMBOS = 0.05;
/** A dealt item must ask for something: at least this share of the range's weight must be painted, and as much left empty. */
export const PAINT_MIN_SIDE = 0.08;

/** The first-in seats the chart paint asks about, by table size (the small blind's limps make its node a different question). */
const CHART_SEATS_6: readonly ChartPosition[] = ["UTG", "HJ", "CO", "BTN"];
const CHART_SEATS_9: readonly ChartPosition[] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"];

export interface PaintChartOptions {
  source: "chart";
  /** The chart set the job loads (`trainingChartSets`); the default set when absent. */
  set?: string | null;
  /** A seat to ask about; any first-in seat but the small blind when absent. */
  seat?: ChartPosition | null;
}

export interface PaintRiverOptions {
  source: "river";
  pot: RiverPot | "any";
  seat: RiverSeat | "any";
  role: RiverRole | "any";
  /** The villain checked to the hero (`check`, in position) or bet (`bet`, either seat). */
  facing?: "check" | "bet" | "any";
}

export type PaintOptions = PaintChartOptions | PaintRiverOptions;

/** One cell: Rail's share for the class (`f`, 0..1) and its weight in combos (`w`); null when the class is not in the range. */
export type PaintCell = { f: number; w: number } | null;

export interface PaintItem {
  kind: "paint";
  source: "chart" | "river";
  seed: number;
  /** What to paint: the hands a seat plays first in, the hands that bet, or the hands that continue against a bet. */
  ask: "open" | "bet" | "continue";
  /** The chart set (chart source), for the caption. */
  set: string;
  hero: ChartPosition;
  villain: ChartPosition | null;
  /** River source only. */
  lineId: string | null;
  pot: RiverPot | null;
  seat: RiverSeat | null;
  board: string[];
  /** The river's action before the decision (river source). */
  facing: { kind: string; sizePot: number } | null;
  potBb: number | null;
  /** 169 cells, grid order (`HAND_CLASSES`). */
  cells: PaintCell[];
  iterations: number | null;
  exploitabilityPct: number | null;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const round2 = (x: number) => Math.round(x * 100) / 100;

/* ------------------------------------------------------------- grading - */

export type CellTarget = "in" | "out" | "mixed";

/** What a cell asks for under the tolerance. */
export function cellTarget(f: number): CellTarget {
  if (f >= PAINT_IN - 1e-9) return "in";
  if (f <= PAINT_OUT + 1e-9) return "out";
  return "mixed";
}

export interface PaintGrade {
  /** Per cell: right, missed (should be painted), extra (should be empty), or null when it does not matter. */
  cells: Array<"right" | "missed" | "extra" | null>;
  /** Weight right, and weight that matters. */
  right: number;
  considered: number;
  score: number;
  passed: boolean;
  missed: number;
  extra: number;
}

/**
 * Grades a painting (one boolean per cell) against an item's cells. A cell
 * matters when it must be painted, or when it was painted; a mixed cell that
 * was painted is right, one left empty does not matter.
 */
export function gradePaint(cells: readonly PaintCell[], painted: readonly boolean[]): PaintGrade {
  const out: PaintGrade["cells"] = [];
  let right = 0;
  let considered = 0;
  let missed = 0;
  let extra = 0;
  cells.forEach((cell, k) => {
    if (!cell) {
      out.push(null);
      return;
    }
    const target = cellTarget(cell.f);
    const on = painted[k] === true;
    if (!on && target !== "in") {
      out.push(null);
      return;
    }
    considered += cell.w;
    if (on && target === "out") {
      extra += 1;
      out.push("extra");
    } else if (!on) {
      missed += 1;
      out.push("missed");
    } else {
      right += cell.w;
      out.push("right");
    }
  });
  const score = considered > 0 ? right / considered : 1;
  return { cells: out, right: round2(right), considered: round2(considered), score: round4(score), passed: score >= PAINT_PASS - 1e-9, missed, extra };
}

/** The painting Rail itself would make: every cell it plays at least half the time. Right by construction. */
export function railPainting(cells: readonly PaintCell[]): boolean[] {
  return cells.map((cell) => cell !== null && cell.f >= 0.5);
}

/** Whether an item asks for something on both sides (`PAINT_MIN_SIDE` of the weight to paint and to leave). */
export function paintable(cells: readonly PaintCell[]): boolean {
  let total = 0;
  let inside = 0;
  let outside = 0;
  for (const cell of cells) {
    if (!cell) continue;
    total += cell.w;
    const target = cellTarget(cell.f);
    if (target === "in") inside += cell.w;
    if (target === "out") outside += cell.w;
  }
  return total > 0 && inside / total >= PAINT_MIN_SIDE && outside / total >= PAINT_MIN_SIDE;
}

/* ------------------------------------------------------------ the chart - */

/** The first-in node of a seat in a chart set (the line folds to it), or null. */
export function firstInNode(charts: ChartSet, seat: ChartPosition): ChartNode | null {
  for (const node of charts.nodes.values()) {
    if (node.actor === seat && /^f*$/.test(node.line) && node.limpers.length === 0) return node;
  }
  return null;
}

/** Per class: the share the node plays (anything but a fold), weighted by the class's combos. */
export function chartCells(node: ChartNode): PaintCell[] {
  const fold = node.options.findIndex((option) => option.action === "fold");
  return Array.from({ length: 169 }, (_, k) => {
    const f = fold >= 0 ? 1 - node.freq[fold * 169 + k] : 1;
    return { f: round4(Math.min(1, Math.max(0, f))), w: CLASS_COMBOS[k] };
  });
}

function chartPaint(charts: ChartSet, options: PaintChartOptions, seed: number): PaintItem | null {
  const rng = seeded(seed);
  const nine = charts.game.players > 6;
  const seats = options.seat ? [options.seat] : nine ? CHART_SEATS_9 : CHART_SEATS_6;
  for (let tries = 0; tries < seats.length * 2; tries += 1) {
    const seat = pickOne(seats, rng);
    const node = firstInNode(charts, seat);
    if (!node) continue;
    const cells = chartCells(node);
    if (!paintable(cells)) continue;
    return {
      kind: "paint",
      source: "chart",
      seed,
      ask: "open",
      set: charts.id,
      hero: seat,
      villain: null,
      lineId: null,
      pot: null,
      seat: null,
      board: [],
      facing: null,
      potBb: null,
      cells,
      iterations: null,
      exploitabilityPct: null,
    };
  }
  return null;
}

/* ------------------------------------------------------------ the river - */

/**
 * Per class at a solved node: the reach-weighted share that bets (no bet to
 * call) or that continues (calls or raises a bet), weighted by the
 * reach-weighted combos left; null for a class the range no longer holds.
 */
export function nodeCells(result: SolveResult, node: number): PaintCell[] {
  const at = result.nodes[node];
  const p = at.player as 0 | 1;
  const n = result.hands[p].length;
  const reach = rangesAt(result, node)[p];
  const facing = at.toCall > 0;
  const plays = at.actions.map((action) => (facing ? action.kind !== "fold" : action.kind !== "check"));
  const weight = new Float64Array(169);
  const share = new Float64Array(169);
  for (let i = 0; i < n; i += 1) {
    const w = reach[i];
    if (!(w > 0)) continue;
    const k = COMBO_CLASS[result.hands[p][i]];
    weight[k] += w;
    for (let a = 0; a < at.actions.length; a += 1) if (plays[a]) share[k] += w * at.strategy[a * n + i];
  }
  return Array.from({ length: 169 }, (_, k) => (weight[k] >= PAINT_MIN_COMBOS ? { f: round4(share[k] / weight[k]), w: round2(weight[k]) } : null));
}

function riverPaint(charts: ChartSet, options: PaintRiverOptions, seed: number): PaintItem | null {
  const rng = seeded(seed);
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    // Facing a check is in position; a bet to answer, either seat (the walk finds the node).
    const seat = options.facing === "check" ? "ip" : options.seat;
    const setup = riverSetup(charts, { pot: options.pot, seat, role: options.role }, rng, seed);
    if (!setup) continue;
    const result = setup.solve.result;
    const walked = heroNode(result, setup.solve.hero, options.facing, rng, "river");
    if (!walked) continue;
    const cells = nodeCells(result, walked.node);
    if (!paintable(cells)) continue;
    const node = result.nodes[walked.node];
    const last = walked.steps.at(-1);
    const before = last ? result.nodes[last.node].actions[last.edge] : null;
    return {
      kind: "paint",
      source: "river",
      seed,
      ask: node.toCall > 0 ? "continue" : "bet",
      set: charts.id,
      hero: setup.hero,
      villain: setup.villain,
      lineId: setup.line.id,
      pot: setup.line.pot,
      seat: setup.seat,
      board: setup.board,
      facing: before ? { kind: before.kind, sizePot: Math.round(before.sizePot * 1000) / 1000 } : null,
      potBb: round2(node.pot),
      cells,
      iterations: result.iterations,
      exploitabilityPct: Math.round(result.exploitabilityPct * 1000) / 1000,
    };
  }
  return null;
}

/** A paint item for `seed`, or null when none could be made. Deterministic. */
export function generatePaint(charts: ChartSet, options: PaintOptions, seed: number): PaintItem | null {
  if (options.source === "chart") return chartPaint(charts, options, seed);
  return riverPaint(charts, options, seed);
}
