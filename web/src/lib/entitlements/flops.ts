/**
 * The solver's flops a day (the pricing round's contract): Free opens a few
 * distinct flops per UTC day - any turn, river and spot on them - and Pro
 * every flop. The server keeps the count (`solver_open_flop`,
 * `solver_flops_today`); this module only asks it and reads the answer.
 *
 * Every place the web shows or solves a flop asks first (the Solver
 * library's flop view, which also gates its full solve and live turns).
 * Preflop is never limited. With enforcement off, or on Pro, the server
 * allows every flop and records nothing; the web does not even ask then.
 */

import { rpc } from "../db/client";

const RANKS = "AKQJT98765432";
const SUITS = "shdc";

/**
 * A flop as the server keys it: the three cards sorted by rank (high first),
 * then suit in the order s h d c - `Ks7d2c`. Null for anything that is not
 * three distinct cards.
 */
export function canonicalFlopKey(flop: string): string | null {
  const cards = flop.match(/[2-9TJQKA][shdc]/g);
  if (!cards || cards.length !== 3 || cards.join("") !== flop || new Set(cards).size !== 3) return null;
  return cards
    .sort((a, b) => RANKS.indexOf(a[0]) - RANKS.indexOf(b[0]) || SUITS.indexOf(a[1]) - SUITS.indexOf(b[1]))
    .join("");
}

/** Today's flops: the opened keys, the cap (null: none) and the next reset. */
export interface FlopsToday {
  flops: string[];
  cap: number | null;
  resetsAt: string | null;
}

export interface FlopOpenAnswer extends FlopsToday {
  allowed: boolean;
}

type Row = Record<string, unknown>;

function todayOf(raw: unknown): FlopsToday {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Row;
  const flops = Array.isArray(row.flops)
    ? row.flops.filter((f): f is string => typeof f === "string" && canonicalFlopKey(f) !== null)
    : [];
  const cap = typeof row.cap === "number" && Number.isFinite(row.cap) ? row.cap : null;
  const resetsAt = typeof row.resetsAt === "string" ? row.resetsAt : null;
  return { flops, cap, resetsAt };
}

/** `solver_open_flop`'s answer, read; anything odd is allowed (the flops are public data, the count is the gate). */
export function parseFlopOpen(raw: unknown): FlopOpenAnswer {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Row;
  return { ...todayOf(raw), allowed: row.allowed !== false };
}

/** Claims `flop` for today (signed in only). */
export async function openFlop(flop: string): Promise<FlopOpenAnswer> {
  return parseFlopOpen(await rpc<unknown>("solver_open_flop", { p_flop: flop }));
}

/** Today's flops without claiming one. */
export async function flopsToday(): Promise<FlopsToday> {
  return todayOf(await rpc<unknown>("solver_flops_today"));
}
