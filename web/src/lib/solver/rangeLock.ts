/**
 * Range locks (`docs/NODELOCK.md` §9): a player's range as the flop comes,
 * changed by the user, solved from in place of the chart's. Pure: the
 * canonical form a lock hashes, the text syntax, the diff against GTO, the
 * class shortcuts and the quick scale.
 *
 * ```
 * GTO's two ranges (the library chunk's, the board's combos out)
 *   ─ the user paints, pastes, scales ─▶ edited ranges
 *   ─ rangeLocksOf ─▶ RangeLock[] (only the changed players; canonical) ─▶ LockSet.ranges
 * ```
 *
 * This never solves preflop again: it fixes the ranges that reach the flop.
 */

import { comboCards, comboCode, NUM_COMBOS, parseRange, SolverInputError } from "./combos";
import { combosOfClass, COMBO_CLASS, HAND_CLASSES, NUM_CLASSES } from "./handClasses";
import type { RangeLock } from "./nodelock";
import { preflopEquityTable } from "./preflopEquity";

type Pair<T> = [T, T];

/** Weights are kept to this step: the same picture always hashes the same. */
export const RANGE_QUANTUM = 1e-4;

/** A weight on `RANGE_QUANTUM`'s grid, within [0, 1]. */
export function quantise(weight: number): number {
  if (!(weight > 0)) return 0;
  if (weight >= 1) return 1;
  return Math.round(weight / RANGE_QUANTUM) / Math.round(1 / RANGE_QUANTUM);
}

/** 1 for a combo that holds no board card (`board`: card indices), else 0. */
export function liveCombos(board: readonly number[]): Uint8Array {
  const out = new Uint8Array(NUM_COMBOS);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const [a, b] = comboCards(c);
    out[c] = board.includes(a) || board.includes(b) ? 0 : 1;
  }
  return out;
}

/** A range in its canonical form: quantised, the board's combos 0. */
export function canonicalRange(weights: ArrayLike<number>, board: readonly number[]): number[] {
  const live = liveCombos(board);
  return Array.from({ length: NUM_COMBOS }, (_, c) => (live[c] ? quantise(weights[c]) : 0));
}

/** The two ranges differ on a live combo by more than `RANGE_QUANTUM` / 2. */
export function rangesDiffer(a: ArrayLike<number>, b: ArrayLike<number>, board: readonly number[]): boolean {
  const live = liveCombos(board);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (live[c] && Math.abs(quantise(a[c]) - quantise(b[c])) > RANGE_QUANTUM / 2) return true;
  }
  return false;
}

/**
 * The range locks of `edited` against GTO (`gto`): one per player whose range
 * differs on a live combo, canonical, by player. Undefined when neither
 * differs ("ranges as GTO" is no range lock, so the set hashes as v1).
 */
export function rangeLocksOf(gto: Pair<ArrayLike<number>>, edited: Pair<ArrayLike<number>>, board: readonly number[]): RangeLock[] | undefined {
  const out: RangeLock[] = [];
  for (const p of [0, 1] as const) {
    if (rangesDiffer(gto[p], edited[p], board)) out.push({ player: p, weights: canonicalRange(edited[p], board) });
  }
  return out.length ? out : undefined;
}

/** GTO's ranges with a set's range locks in place (copies). */
export function rangesWith(gto: Pair<ArrayLike<number>>, locks: readonly RangeLock[] | null | undefined): Pair<Float64Array> {
  const out: Pair<Float64Array> = [Float64Array.from(gto[0]), Float64Array.from(gto[1])];
  for (const lock of locks ?? []) out[lock.player] = Float64Array.from(lock.weights);
  return out;
}

/** A solver's hand list and its weights (`SolveResult.hands[p]`, `.weights[p]`) as 1,326 weights (0 elsewhere). */
export function handsRange(hands: ArrayLike<number>, weights: ArrayLike<number>): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < hands.length; i += 1) out[hands[i]] = weights[i];
  return out;
}

/* --------------------------------------------------------------- numbers - */

export interface RangeSize {
  /** Weighted live combos. */
  combos: number;
  /** Share of the live combos (the board's out): how often the player has a hand here. */
  share: number;
}

export function rangeSize(weights: ArrayLike<number>, board: readonly number[]): RangeSize {
  const live = liveCombos(board);
  let combos = 0;
  let count = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!live[c]) continue;
    count += 1;
    combos += weights[c];
  }
  return { combos, share: count ? combos / count : 0 };
}

export interface RangeDiff {
  /** Weight gained and lost over the live combos, in combos. */
  added: number;
  removed: number;
  gto: RangeSize;
  edited: RangeSize;
}

export function rangeDiff(gto: ArrayLike<number>, edited: ArrayLike<number>, board: readonly number[]): RangeDiff {
  const live = liveCombos(board);
  let added = 0;
  let removed = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!live[c]) continue;
    const d = edited[c] - gto[c];
    if (d > 0) added += d;
    else removed -= d;
  }
  return { added, removed, gto: rangeSize(gto, board), edited: rangeSize(edited, board) };
}

/** Per hand class (grid order): the mean weight of its live combos, and how many are live. */
export function classWeights(weights: ArrayLike<number>, board: readonly number[]): { weight: Float64Array; live: Uint8Array } {
  const live = liveCombos(board);
  const sum = new Float64Array(NUM_CLASSES);
  const count = new Uint8Array(NUM_CLASSES);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (!live[c]) continue;
    sum[COMBO_CLASS[c]] += weights[c];
    count[COMBO_CLASS[c]] += 1;
  }
  return { weight: Float64Array.from(sum, (s, k) => (count[k] ? s / count[k] : 0)), live: count };
}

/* -------------------------------------------------------------- editing - */

/** `weights` with every live combo of the classes at `weight`. A copy. */
export function paintClasses(weights: ArrayLike<number>, classes: readonly number[], weight: number, board: readonly number[]): Float64Array {
  const live = liveCombos(board);
  const out = Float64Array.from(weights);
  const w = quantise(weight);
  for (const k of classes) {
    for (const c of combosOfClass(k)) if (live[c]) out[c] = w;
  }
  return out;
}

export type ClassSet = "pairs" | "suited" | "offsuit" | "broadways" | "axSuited" | "suitedConnectors";
export const CLASS_SETS: readonly ClassSet[] = ["pairs", "suited", "offsuit", "broadways", "axSuited", "suitedConnectors"];

/** The classes of a shortcut (grid order). Broadways: both cards T or higher; suited connectors: suited, ranks next to each other (AKs to 32s). */
export function classSet(set: ClassSet): number[] {
  return HAND_CLASSES.filter((c) => {
    switch (set) {
      case "pairs":
        return c.pair;
      case "suited":
        return c.suited;
      case "offsuit":
        return !c.pair && !c.suited;
      case "broadways":
        return c.lo >= 8;
      case "axSuited":
        return c.suited && c.hi === 12;
      case "suitedConnectors":
        return c.suited && c.hi - c.lo === 1;
    }
    return false;
  }).map((c) => c.index);
}

/**
 * Widens (`deltaPp` > 0) or tightens the range by `deltaPp` of the live
 * combos (0.05 = 5 percentage points), a whole class at a time; the last
 * class moves partly. Widening goes on from the range's edge: the
 * best-scoring classes not fully in **that score no better than the range's
 * best** first (a calling range's next calls, not the hands the line raised
 * with), then the stronger ones, closest first. Tightening empties the
 * worst-scoring classes in it first. `score`: per class (grid order), higher
 * is better. A copy, canonical.
 */
export function scaleRange(weights: ArrayLike<number>, deltaPp: number, score: ArrayLike<number>, board: readonly number[]): Float64Array {
  const { weight, live } = classWeights(weights, board);
  let totalLive = 0;
  live.forEach((n) => {
    totalLive += n;
  });
  let left = Math.abs(deltaPp) * totalLive;
  const widen = deltaPp > 0;
  let top = -Infinity;
  for (let k = 0; k < NUM_CLASSES; k += 1) if (live[k] > 0 && weight[k] > 0) top = Math.max(top, score[k]);
  // Widening: below the range's best, best first (0); above it, closest first (1).
  const band = (k: number) => (score[k] <= top || top === -Infinity ? 0 : 1);
  const order = Array.from({ length: NUM_CLASSES }, (_, k) => k)
    .filter((k) => live[k] > 0 && (widen ? weight[k] < 1 : weight[k] > 0))
    .sort((a, b) => (widen ? band(a) - band(b) || (band(a) ? score[a] - score[b] : score[b] - score[a]) : score[a] - score[b]) || a - b);
  const next = Float64Array.from(weight);
  for (const k of order) {
    if (left <= 1e-9) break;
    const room = (widen ? 1 - weight[k] : weight[k]) * live[k];
    const take = Math.min(room, left);
    next[k] = weight[k] + ((widen ? 1 : -1) * take) / live[k];
    left -= take;
  }
  const liveMask = liveCombos(board);
  const out = Float64Array.from(weights);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const k = COMBO_CLASS[c];
    if (!liveMask[c] || next[k] === weight[k]) continue;
    out[c] = next[k];
  }
  return Float64Array.from(canonicalRange(out, board));
}

let equityCache: Float64Array | null = null;

/** The 169×169 preflop equity the scale's order uses (seeded, 4,000 boards: ~1 s once). */
export function scaleEquityTable(): Float64Array {
  equityCache ??= preflopEquityTable({ boards: 4000 }).equity;
  return equityCache;
}

/**
 * Each class's preflop equity against the opponent's range (`opponent`,
 * 1,326 weights): the quick scale's order. The chart data has no preflop
 * EVs, so equity is the stand-in (§9.1). `table`: `scaleEquityTable()`.
 */
export function classScores(opponent: ArrayLike<number>, table: ArrayLike<number> = scaleEquityTable()): Float64Array {
  const mass = new Float64Array(NUM_CLASSES);
  for (let c = 0; c < NUM_COMBOS; c += 1) mass[COMBO_CLASS[c]] += opponent[c];
  let total = 0;
  mass.forEach((m) => {
    total += m;
  });
  return Float64Array.from({ length: NUM_CLASSES }, (_, i) => {
    if (!(total > 0)) return 0;
    let sum = 0;
    for (let j = 0; j < NUM_CLASSES; j += 1) sum += table[i * NUM_CLASSES + j] * mass[j];
    return sum / total;
  });
}

/* ----------------------------------------------------------------- text - */

/**
 * A range from text in the usual syntax (`AA,AKs,AQo:0.5,TT+,A2s-A5s,AsKs`),
 * commas or spaces between tokens; a weight above 1 reads as a percentage
 * (`:50`). A class not named is 0. Throws `SolverInputError` with the bad
 * token.
 */
export function parseRangeText(text: string): Float64Array {
  const tokens = text
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const colon = token.indexOf(":");
      if (colon < 0) return token;
      const value = Number(token.slice(colon + 1).replace("%", ""));
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new SolverInputError(`bad weight in range token: ${token}`);
      return `${token.slice(0, colon)}:${value > 1 ? value / 100 : value}`;
    });
  return parseRange(tokens.join(","));
}

const weightText = (w: number) => (w >= 1 ? "" : `:${Number(w.toFixed(4))}`);

/**
 * A range as text (`parseRangeText` reads it back): each class with weight
 * as the mean of its live combos, in grid order (`AA`, `AKs`, … `22`); a
 * class whose live combos differ is written combo by combo. `board`: the
 * combos holding its cards are left out (they are 0 in a lock).
 */
export function formatRange(weights: ArrayLike<number>, board: readonly number[] = []): string {
  const live = liveCombos(board);
  const parts: string[] = [];
  for (const cls of HAND_CLASSES) {
    const combos = combosOfClass(cls.index).filter((c) => live[c]);
    if (!combos.length) continue;
    const ws = combos.map((c) => quantise(weights[c]));
    if (ws.every((w) => w === 0)) continue;
    if (ws.every((w) => w === ws[0])) {
      parts.push(`${cls.name}${weightText(ws[0])}`);
      continue;
    }
    combos.forEach((c, k) => {
      if (ws[k] > 0) parts.push(`${comboCode(c)}${weightText(ws[k])}`);
    });
  }
  return parts.join(",");
}
