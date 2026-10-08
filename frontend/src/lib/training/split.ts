/**
 * The range split (Learn L2, the `range-split` exercise): the learner sorts
 * the hand classes of a whole range into actions — check, a small bet or a
 * big bet; or fold, call or raise against a bet — and Rail grades each class
 * by what its own solve does with it at that node.
 *
 * ```
 * flop: a line and flop of the library (flop.ts) ─▶ the hero's node, drawn from the solve's frequencies
 * turn: a turn spot's solve (turn.ts, A5a)        ─▶ the same walk
 *   ─▶ every combo the hero's range holds there, by category: `flopBucket` (made hand × draw) on the
 *      flop, `turnCategory` on the turn — the categories the analysis itself reads solves by
 *   ─▶ per category: its share of the range and the reach-weighted mix of the solve's actions,
 *      grouped into check / small (≤ half the pot) / big (bigger, all-in), or fold / call / raise
 * answer ─▶ one group per category ─▶ right where the solve plays that group within
 *   `SPLIT_SLACK` of its most played one (a class the solve mixes has more than one right answer)
 * ```
 *
 * Pure and deterministic in its seed; the item carries the solve's numbers,
 * so the screen grades without asking the worker again.
 */

import type { ChartPosition, ChartSet } from "../charts";
import { flopBucket, turnCategory, TURN_CATEGORIES, type FlopLibrary } from "../analysis";
import { cardCode, cardIndex } from "../equity/evaluator";
import { comboHi, comboLo, permuteCard, rangesAt, SUIT_PERMUTATIONS, type ActionKind, type SolveResult } from "../solver";
import { heroNode, plannedChunk, type FlopSpotOptions } from "./flop";
import { MAX_ATTEMPTS, type RiverPot, type RiverSeat } from "./river";
import { pickOne, seeded } from "./rng";
import { turnSetup } from "./turn";

export type SplitGroup = "check" | "small" | "big" | "fold" | "call" | "raise";

/** A bet up to this share of the pot is "small"; bigger, and all-in, is "big". */
export const SMALL_MAX = 0.5;
/** A category is right within this many points of the solve's most played group. */
export const SPLIT_SLACK = 0.15;
/** Categories with less of the range than this are left out of the item. */
export const MIN_SPLIT_SHARE = 0.03;
/** At most this many categories per item (the largest). */
export const MAX_SPLIT_ROWS = 8;
/** Share of an item's categories that must be right for the item to count as right. */
export const SPLIT_PASS = 0.7;

export interface SplitOptions extends FlopSpotOptions {
  street: "flop" | "turn";
}

export interface SplitRow {
  /** `flopBucket` (`tp-good/bd`) on the flop, `turnCategory` (`top-pair`) on the turn. */
  key: string;
  /** Weighted combos of the hero's range at the node. */
  combos: number;
  /** Of the hero's whole range at the node. */
  share: number;
  /** The solve's mix, per group of the item, summing to 1. */
  freq: number[];
}

export interface SplitItem {
  kind: "split";
  street: "flop" | "turn";
  seed: number;
  lineId: string;
  pot: RiverPot;
  hero: ChartPosition;
  villain: ChartPosition;
  seat: RiverSeat;
  /** Three or four cards. */
  board: string[];
  /** The street's actions before the decision. */
  before: Array<{ who: "hero" | "villain"; kind: ActionKind; sizePot: number }>;
  potBb: number;
  toCallBb: number;
  groups: SplitGroup[];
  rows: SplitRow[];
  /** The whole range's mix per group. */
  overall: number[];
  /** Where the numbers come from: the flop library's chunk, or the turn solve (ranges narrowed by the heuristic). */
  source: "library" | "turn-solve";
  iterations: number;
  exploitabilityPct: number;
}

/* -------------------------------------------------------------- groups - */

function groupOf(result: SolveResult, node: number, a: number): SplitGroup {
  const at = result.nodes[node];
  const action = at.actions[a];
  if (at.toCall > 0) return action.kind === "fold" ? "fold" : action.kind === "call" ? "call" : "raise";
  if (action.kind === "check") return "check";
  return action.kind === "bet" && action.sizePot <= SMALL_MAX + 1e-9 ? "small" : "big";
}

const GROUP_ORDER: readonly SplitGroup[] = ["fold", "check", "call", "small", "big", "raise"];

/** The made-hand and draw parts of a flop category, strongest first: the order rows are shown in. */
const FLOP_MADE = ["fh+", "flush", "straight", "set", "trips", "two-pair", "overpair", "tp-top", "tp-good", "tp-weak", "middle", "weak", "ace-high", "nothing"];
const FLOP_DRAW = ["combo", "nfd", "fd", "oesd", "gut", "bd", "none"];
const TURN_ORDER: string[] = TURN_CATEGORIES.map((c) => c.key);

function rowOrder(street: "flop" | "turn", key: string): number {
  if (street === "turn") return TURN_ORDER.indexOf(key);
  const [made, draw] = key.split("/");
  return FLOP_MADE.indexOf(made) * 10 + FLOP_DRAW.indexOf(draw);
}

/**
 * The hero's range at `node`, by category: each category's share and the
 * solve's reach-weighted mix of the groups. Every combo counts; the item
 * keeps the larger categories (`MIN_SPLIT_SHARE`, `MAX_SPLIT_ROWS`).
 */
export function splitTable(
  result: SolveResult,
  node: number,
  street: "flop" | "turn",
  board: readonly number[],
): { groups: SplitGroup[]; rows: SplitRow[]; overall: number[] } {
  const at = result.nodes[node];
  const p = at.player as 0 | 1;
  const n = result.hands[p].length;
  const reach = rangesAt(result, node)[p];
  const byAction = at.actions.map((_, a) => groupOf(result, node, a));
  const groups = GROUP_ORDER.filter((g) => byAction.includes(g));
  const g = byAction.map((group) => groups.indexOf(group));
  const sums = new Map<string, { combos: number; freq: number[] }>();
  const overall = new Array(groups.length).fill(0);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const w = reach[i];
    if (!(w > 0)) continue;
    const combo = result.hands[p][i];
    const hole: [number, number] = [comboHi(combo), comboLo(combo)];
    const key = street === "flop" ? flopBucket(hole, board) : turnCategory(hole, board);
    let row = sums.get(key);
    if (!row) {
      row = { combos: 0, freq: new Array(groups.length).fill(0) };
      sums.set(key, row);
    }
    row.combos += w;
    total += w;
    for (let a = 0; a < at.actions.length; a += 1) {
      const f = w * at.strategy[a * n + i];
      row.freq[g[a]] += f;
      overall[g[a]] += f;
    }
  }
  const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
  const rows = [...sums.entries()]
    .map(([key, row]) => ({
      key,
      combos: Math.round(row.combos * 100) / 100,
      share: round4(row.combos / total),
      freq: row.freq.map((f) => round4(f / row.combos)),
    }))
    .filter((row) => row.share >= MIN_SPLIT_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_SPLIT_ROWS)
    .sort((a, b) => rowOrder(street, a.key) - rowOrder(street, b.key));
  return { groups, rows, overall: overall.map((f) => (total > 0 ? round4(f / total) : 0)) };
}

/* ------------------------------------------------------------ the item - */

function before(result: SolveResult, steps: ReadonlyArray<{ node: number; edge: number; player: 0 | 1 }>, hero: 0 | 1, street: "flop" | "turn"): SplitItem["before"] {
  return steps
    .filter((step) => result.nodes[step.node].street === street)
    .map((step) => {
      const action = result.nodes[step.node].actions[step.edge];
      return { who: step.player === hero ? "hero" : "villain", kind: action.kind, sizePot: Math.round(action.sizePot * 1000) / 1000 };
    });
}

function flopSplit(charts: ChartSet, library: FlopLibrary, options: SplitOptions, seed: number): SplitItem | null {
  const rng = seeded(seed);
  const planned = plannedChunk(charts, library, options, rng);
  if (!planned) return null;
  const { plan, chunk } = planned;
  const result = chunk.result;
  const hero: 0 | 1 = plan.seat === "oop" ? 0 : 1;
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const walked = heroNode(result, hero, options.facing, rng);
    if (!walked) continue;
    const canonical = result.board.map(cardIndex);
    const table = splitTable(result, walked.node, "flop", canonical);
    if (table.rows.length < 3 || table.groups.length < 2) continue;
    // Categories are suit-blind: the board is shown in suits of its own.
    const perm = pickOne(SUIT_PERMUTATIONS, rng);
    const node = result.nodes[walked.node];
    return {
      kind: "split",
      street: "flop",
      seed,
      lineId: plan.line.id,
      pot: plan.line.pot,
      hero: plan.hero,
      villain: plan.villain,
      seat: plan.seat,
      board: canonical.map((card) => cardCode(permuteCard(card, perm))),
      before: before(result, walked.steps, hero, "flop"),
      potBb: Math.round(node.pot * 100) / 100,
      toCallBb: Math.round(node.toCall * 100) / 100,
      ...table,
      source: "library",
      iterations: result.iterations,
      exploitabilityPct: Math.round(result.exploitabilityPct * 1000) / 1000,
    };
  }
  return null;
}

function turnSplit(charts: ChartSet, options: SplitOptions, seed: number): SplitItem | null {
  const rng = seeded(seed);
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const setup = turnSetup(charts, { pot: options.pot, seat: options.seat, role: options.role, bias: options.bias }, rng, seed);
    if (!setup) continue;
    const { solve } = setup;
    const result = solve.result;
    const walked = heroNode(result, solve.hero, options.facing, rng, "turn");
    if (!walked) continue;
    const board = setup.board.map(cardIndex);
    const table = splitTable(result, walked.node, "turn", board);
    if (table.rows.length < 3 || table.groups.length < 2) continue;
    const node = result.nodes[walked.node];
    return {
      kind: "split",
      street: "turn",
      seed,
      lineId: setup.line.id,
      pot: setup.line.pot,
      hero: setup.hero,
      villain: setup.villain,
      seat: setup.seat,
      board: setup.board,
      before: before(result, walked.steps, solve.hero, "turn"),
      potBb: Math.round(node.pot * 100) / 100,
      toCallBb: Math.round(node.toCall * 100) / 100,
      ...table,
      source: "turn-solve",
      iterations: result.iterations,
      exploitabilityPct: Math.round(result.exploitabilityPct * 1000) / 1000,
    };
  }
  return null;
}

/**
 * A split item for `seed`, or null when none could be made (the flop needs
 * the library with the plan's chunk loaded: `flopChunkFor` names it).
 * Deterministic.
 */
export function generateSplit(charts: ChartSet, library: FlopLibrary | null, options: SplitOptions, seed: number): SplitItem | null {
  if (options.street === "turn") return turnSplit(charts, options, seed);
  return library ? flopSplit(charts, library, options, seed) : null;
}

/* ------------------------------------------------------------- grading - */

/** The groups (indices into `item.groups`) that are right for a row: within `SPLIT_SLACK` of its most played group. */
export function rightGroups(row: SplitRow): number[] {
  const top = Math.max(...row.freq);
  return row.freq.flatMap((f, g) => (f >= top - SPLIT_SLACK - 1e-9 ? [g] : []));
}

export interface SplitGrade {
  /** Per row: whether the pick is right. */
  right: boolean[];
  correct: number;
  total: number;
  /** Whether the item counts as right: at least `SPLIT_PASS` of the rows. */
  passed: boolean;
}

/** Grades one pick per row (an index into `item.groups`; -1 for none). */
export function gradeSplit(item: Pick<SplitItem, "rows" | "groups">, picks: readonly number[]): SplitGrade {
  const right = item.rows.map((row, r) => rightGroups(row).includes(picks[r] ?? -1));
  const correct = right.filter(Boolean).length;
  const total = item.rows.length;
  return { right, correct, total, passed: total > 0 && correct >= Math.ceil(SPLIT_PASS * total - 1e-9) };
}
