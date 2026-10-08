/**
 * How often the preflop raiser bets the flop, by board group, over the flop
 * library's own solves (Learn L2, *flop bets by board type*). Rail's numbers
 * only: each row is one solved chunk of the library, read at one node, and
 * the committed data (`data/flop-bets.json`) is written by
 * `tests/scripts/flop-library/flopBets.test.ts` from the full library
 * (`npm run floplib:bets`); `tests/test/flopBets.test.ts` recomputes every row
 * the committed pilot holds from its chunks, and every group from the rows.
 *
 * Pure: no React, no fetch. The lesson's widget imports the small JSON.
 */

import { flopCards, type FlopChunk } from "../solver";

/** The lines and nodes the data covers: the raiser's first flop decision on each. */
export const FLOP_BET_SPOTS = [
  { line: "btn-bb", path: "X" },
  { line: "utg-bb", path: "X" },
  { line: "btn-bb-3bet", path: "" },
] as const;
export type FlopBetLine = (typeof FLOP_BET_SPOTS)[number]["line"];

/** A bet above this share of the pot (or all-in) is "big". */
export const BIG_FROM = 0.5;

export interface FlopBetRow {
  /** Canonical flop key. */
  flop: string;
  /** Share of the raiser's range that bets, any size. */
  bet: number;
  /** Share that bets big (75% of the pot, or all-in). */
  big: number;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** One chunk read at the raiser's node: how much of the range bets, and bets big. Null when the node is not in the chunk. */
export function flopBetRow(chunk: FlopChunk, path: string): FlopBetRow | null {
  const node = chunk.result.nodes.find((n) => n.kind === "action" && n.street === "flop" && n.path === path);
  if (!node || node.toCall > 0) return null;
  let bet = 0;
  let big = 0;
  node.actions.forEach((action, i) => {
    if (action.kind === "check") return;
    bet += node.frequency[i];
    if (action.kind === "allin" || action.sizePot > BIG_FROM) big += node.frequency[i];
  });
  return { flop: chunk.header.flop, bet: round4(bet), big: round4(big) };
}

/** Board groups, as the lesson names them. */
export const FLOP_GROUPS = ["ace-high", "king-queen-high", "middle", "low", "monotone", "paired", "trips"] as const;
export type FlopGroup = (typeof FLOP_GROUPS)[number];

const RANKS = "23456789TJQKA";

/** A flop's group: trips, paired, monotone, else unpaired by its top card. */
export function flopGroup(flop: string): FlopGroup {
  const cards = flopCards(flop);
  const ranks = cards.map((c) => RANKS.indexOf(c[0])).sort((a, b) => b - a);
  const suits = new Set(cards.map((c) => c[1]));
  if (ranks[0] === ranks[2]) return "trips";
  if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) return "paired";
  if (suits.size === 1) return "monotone";
  if (ranks[0] === 12) return "ace-high";
  if (ranks[0] >= 10) return "king-queen-high";
  if (ranks[0] >= 6) return "middle";
  return "low";
}

export interface FlopGroupRow {
  group: FlopGroup;
  /** Solved flops in the group. */
  flops: number;
  /** Plain means over those flops. */
  bet: number;
  big: number;
}

/** The rows of one line averaged by group (each solved flop counts once), in `FLOP_GROUPS` order; empty groups left out. */
export function groupRows(rows: readonly FlopBetRow[]): FlopGroupRow[] {
  return FLOP_GROUPS.flatMap((group) => {
    const inGroup = rows.filter((row) => flopGroup(row.flop) === group);
    if (inGroup.length === 0) return [];
    const mean = (pick: (row: FlopBetRow) => number) => round4(inGroup.reduce((sum, row) => sum + pick(row), 0) / inGroup.length);
    return [{ group, flops: inGroup.length, bet: mean((r) => r.bet), big: mean((r) => r.big) }];
  });
}

/** The committed data's shape. */
export interface FlopBetData {
  /** Chart set id and model hash the chunks were solved from, and the tree. */
  set: string;
  hash: string;
  tree: string;
  lines: Record<FlopBetLine, FlopBetRow[]>;
}
