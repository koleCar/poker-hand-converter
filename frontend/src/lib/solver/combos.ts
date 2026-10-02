/**
 * Two-card combos and weighted ranges.
 *
 * **One index space, 1326 combos.** A combo is two distinct cards in the
 * evaluator's encoding (`rank * 4 + suit`, `lib/equity/evaluator.ts`), and its
 * index is `hi * (hi - 1) / 2 + lo` with `hi > lo`. That is a bijection onto
 * `0..1325` with no holes, so a range is a plain `Float64Array(1326)` of
 * weights, a range lookup is one array read, and two ranges compare
 * element-wise. Every other module here (the river builder, suit isomorphism,
 * the spot key, the stored blob) speaks this index and nothing else.
 *
 * **Why weights and not a set.** Ranges in a real hand are narrowed by a mixed
 * strategy at every node: "calls 40% of the time with this combo" leaves 0.4 of
 * it in the range. A boolean set cannot carry that, and rounding it away is
 * exactly the kind of quiet approximation a grade must not rest on.
 *
 * **Range text.** `parseRange` reads the notation every poker tool shares
 * (`"TT+, AKs, KQo:0.5, A5s-A2s, AhKh"`), so tests, benchmarks and the preflop
 * chart generator can write ranges the way people read them. Later tokens
 * override earlier ones, which is what makes `"AA-22, 72o:0"` mean what it says.
 */

import { cardCode, cardIndex } from "../equity";

export const NUM_COMBOS = 1326;

const RANK_CHARS = "23456789TJQKA";

/** High card of each combo index. */
const COMBO_HI = new Uint8Array(NUM_COMBOS);
/** Low card of each combo index. */
const COMBO_LO = new Uint8Array(NUM_COMBOS);
for (let hi = 1; hi < 52; hi += 1) {
  for (let lo = 0; lo < hi; lo += 1) {
    const index = (hi * (hi - 1)) / 2 + lo;
    COMBO_HI[index] = hi;
    COMBO_LO[index] = lo;
  }
}

/** Combo index of two distinct cards, in either order. */
export function comboIndex(a: number, b: number): number {
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  return (hi * (hi - 1)) / 2 + lo;
}

/** The two cards of a combo, higher card index first. */
export function comboCards(index: number): [number, number] {
  return [COMBO_HI[index], COMBO_LO[index]];
}

/** Higher card of a combo. */
export function comboHi(index: number): number {
  return COMBO_HI[index];
}

/** Lower card of a combo. */
export function comboLo(index: number): number {
  return COMBO_LO[index];
}

/** `"AhKd"`-style code of a combo, higher card first. */
export function comboCode(index: number): string {
  return cardCode(COMBO_HI[index]) + cardCode(COMBO_LO[index]);
}

/** Combo index of a four-character code like `"AhKd"`, or -1. */
export function parseCombo(code: string): number {
  const text = code.trim();
  if (text.length !== 4) {
    return -1;
  }
  const a = cardIndex(text.slice(0, 2));
  const b = cardIndex(text.slice(2, 4));
  if (a < 0 || b < 0 || a === b) {
    return -1;
  }
  return comboIndex(a, b);
}

/** Card indices of a list of codes; throws on junk or duplicates. */
export function parseCards(codes: readonly (string | number)[]): number[] {
  const out: number[] = [];
  for (const code of codes) {
    const index = typeof code === "number" ? code : cardIndex(code);
    if (!Number.isInteger(index) || index < 0 || index > 51) {
      throw new SolverInputError(`not a card: ${String(code)}`);
    }
    if (out.includes(index)) {
      throw new SolverInputError(`duplicate card: ${cardCode(index)}`);
    }
    out.push(index);
  }
  return out;
}

/** Thrown for any input the solver cannot make sense of. */
export class SolverInputError extends Error {}

/* --------------------------------------------------------------- ranges - */

/** A range as text, a 1326-weight vector, or a `{ "AhKd": 0.5 }` map. */
export type RangeInput = string | ArrayLike<number> | Readonly<Record<string, number>>;

/** Every combo of a hand class: `"AA"` (6), `"AKs"` (4), `"AKo"` (12), `"AK"` (16). */
function classCombos(hi: number, lo: number, kind: "s" | "o" | ""): number[] {
  const out: number[] = [];
  for (let s1 = 0; s1 < 4; s1 += 1) {
    for (let s2 = 0; s2 < 4; s2 += 1) {
      const a = hi * 4 + s1;
      const b = lo * 4 + s2;
      if (a === b) {
        continue;
      }
      if (hi === lo) {
        if (s1 < s2) {
          out.push(comboIndex(a, b));
        }
        continue;
      }
      if (kind === "s" && s1 !== s2) {
        continue;
      }
      if (kind === "o" && s1 === s2) {
        continue;
      }
      out.push(comboIndex(a, b));
    }
  }
  return out;
}

interface ClassToken {
  hi: number;
  lo: number;
  kind: "s" | "o" | "";
}

function parseClass(text: string): ClassToken | null {
  const match = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/i.exec(text);
  if (!match) {
    return null;
  }
  const a = RANK_CHARS.indexOf(match[1].toUpperCase());
  const b = RANK_CHARS.indexOf(match[2].toUpperCase());
  const kind = match[3].toLowerCase() as "s" | "o" | "";
  if (a === b && kind) {
    return null;
  }
  return { hi: Math.max(a, b), lo: Math.min(a, b), kind };
}

/** Expands one token body (no weight) into combo indices. */
function expandToken(body: string): number[] {
  const exact = parseCombo(body);
  if (exact >= 0) {
    return [exact];
  }
  const plus = body.endsWith("+");
  const dash = body.indexOf("-");
  if (dash > 0) {
    const from = parseClass(body.slice(0, dash));
    const to = parseClass(body.slice(dash + 1));
    if (!from || !to || from.kind !== to.kind) {
      throw new SolverInputError(`bad range token: ${body}`);
    }
    const out: number[] = [];
    if (from.hi === from.lo && to.hi === to.lo) {
      // "22-55": pairs between the two, either order.
      for (let r = Math.min(from.hi, to.hi); r <= Math.max(from.hi, to.hi); r += 1) {
        out.push(...classCombos(r, r, ""));
      }
      return out;
    }
    if (from.hi !== to.hi) {
      // "T9s-54s": connectors (or one-gappers...) with the same gap, stepping down together.
      const gap = from.hi - from.lo;
      if (gap !== to.hi - to.lo) {
        throw new SolverInputError(`bad range token: ${body}`);
      }
      for (let hi = Math.min(from.hi, to.hi); hi <= Math.max(from.hi, to.hi); hi += 1) {
        out.push(...classCombos(hi, hi - gap, from.kind));
      }
      return out;
    }
    // "A5s-A2s": fixed top card, kicker between the two.
    for (let k = Math.min(from.lo, to.lo); k <= Math.max(from.lo, to.lo); k += 1) {
      out.push(...classCombos(from.hi, k, from.kind));
    }
    return out;
  }
  const cls = parseClass(plus ? body.slice(0, -1) : body);
  if (!cls) {
    throw new SolverInputError(`bad range token: ${body}`);
  }
  if (!plus) {
    return classCombos(cls.hi, cls.lo, cls.kind);
  }
  const out: number[] = [];
  if (cls.hi === cls.lo) {
    // "TT+": this pair and every higher one.
    for (let r = cls.hi; r <= 12; r += 1) {
      out.push(...classCombos(r, r, ""));
    }
    return out;
  }
  // "A9s+": kicker from this one up to one below the top card.
  for (let k = cls.lo; k < cls.hi; k += 1) {
    out.push(...classCombos(cls.hi, k, cls.kind));
  }
  return out;
}

/**
 * Parses range text into 1326 weights.
 *
 * Tokens are separated by commas or whitespace; each is a class (`AA`, `AKs`,
 * `AKo`, `AK`), a class with `+`, a dash range (`22-55`, `A5s-A2s`) or an exact
 * combo (`AhKh`), optionally followed by `:weight` in `[0, 1]`. A later token
 * overrides an earlier one on the combos they share.
 */
export function parseRange(text: string): Float64Array {
  const weights = new Float64Array(NUM_COMBOS);
  for (const raw of text.split(/[\s,]+/)) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    const colon = token.indexOf(":");
    const body = colon >= 0 ? token.slice(0, colon) : token;
    const weight = colon >= 0 ? Number(token.slice(colon + 1)) : 1;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new SolverInputError(`bad weight in range token: ${token}`);
    }
    for (const combo of expandToken(body)) {
      weights[combo] = weight;
    }
  }
  return weights;
}

/** Normalises any `RangeInput` to 1326 weights. A copy, never the caller's array. */
export function toRange(input: RangeInput): Float64Array {
  if (typeof input === "string") {
    return parseRange(input);
  }
  if (typeof (input as ArrayLike<number>).length === "number") {
    const array = input as ArrayLike<number>;
    if (array.length !== NUM_COMBOS) {
      throw new SolverInputError(`a range vector has ${NUM_COMBOS} weights, got ${array.length}`);
    }
    const out = Float64Array.from(array);
    for (const w of out) {
      if (!(w >= 0 && w <= 1)) {
        throw new SolverInputError("range weights must be within [0, 1]");
      }
    }
    return out;
  }
  const out = new Float64Array(NUM_COMBOS);
  for (const [code, weight] of Object.entries(input as Record<string, number>)) {
    const combo = parseCombo(code);
    if (combo < 0) {
      throw new SolverInputError(`not a combo: ${code}`);
    }
    if (!(weight >= 0 && weight <= 1)) {
      throw new SolverInputError(`bad weight for ${code}: ${weight}`);
    }
    out[combo] = weight;
  }
  return out;
}

/** Number of combos (sum of weights) in a range, optionally excluding cards. */
export function rangeSize(range: ArrayLike<number>, dead: readonly number[] = []): number {
  let total = 0;
  for (let i = 0; i < NUM_COMBOS; i += 1) {
    if (range[i] > 0 && !dead.includes(COMBO_HI[i]) && !dead.includes(COMBO_LO[i])) {
      total += range[i];
    }
  }
  return total;
}
