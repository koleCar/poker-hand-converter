/**
 * The 169 preflop hand classes and the card-removal arithmetic between them.
 *
 * **Why 169 and not 1326.** Before the flop every suit is equivalent, so
 * `AsKs` and `AhKh` are the same decision: 1326 combos collapse to 13 pairs, 78
 * suited and 78 offsuit hands. A preflop strategy is one number per class per
 * action, and a chart is a 13x13 grid. The reduction is exact for the strategy
 * of the hand itself; what it loses is the suit relation *between* two hands
 * (`AhKh` against `QhQd` is not `AKs` against `QQ` on average), which is why
 * equities are averaged over every compatible combo pair (`preflopEquity.ts`)
 * and opponents are weighted by the combos they can actually hold (below).
 *
 * **Grid layout.** Class index `row * 13 + col`, with row and column `0` for the
 * ace down to `12` for the deuce: pairs on the diagonal, suited hands above it
 * (row = the higher card), offsuit hands below it (column = the higher card).
 * That is the chart everyone draws, so index `k` is cell `k` of the 13x13
 * viewer.
 *
 * **Card removal between classes.** Given one specific combo of class `i`, the
 * number of combos of class `j` that share no card with it is
 *
 *     m[i][j] = combos(j) - inc(j, r1) - inc(j, r2) + [j == i]
 *
 * where `inc(j, r)` is how many combos of `j` contain one particular card of
 * rank `r` (3 for a pair of `r`, 1 for a suited hand with an `r`, 3 for an
 * offsuit one) - inclusion-exclusion, with the hero's own combo added back
 * because it was subtracted twice. It depends on ranks only, so it is the same
 * for every combo of `i`; the solver uses it as `P(opponent holds j | hero
 * holds i) = m[i][j] / 1225`. `massVector` computes `Σ_j m[i][j] x[j]` for all
 * `i` in O(169) from per-rank sums instead of a 169x169 product.
 */

import { comboCards, comboIndex, NUM_COMBOS } from "./combos";

export const NUM_CLASSES = 169;
/** Opponent combos left once two cards are known: C(50, 2). */
export const COMBOS_AFTER_HAND = 1225;

const RANKS_HIGH_FIRST = "AKQJT98765432";

/** Evaluator rank (0 = deuce .. 12 = ace) to grid row/column (0 = ace). */
function gridOf(rank: number): number {
  return 12 - rank;
}

/** Class index of two ranks (evaluator encoding) and suitedness. */
export function classIndex(rankA: number, rankB: number, suited: boolean): number {
  const hi = Math.max(rankA, rankB);
  const lo = Math.min(rankA, rankB);
  const a = gridOf(hi);
  const b = gridOf(lo);
  if (hi === lo) {
    return a * 13 + a;
  }
  return suited ? a * 13 + b : b * 13 + a;
}

/** Class of two cards in the evaluator's encoding (`rank * 4 + suit`). */
export function classOfCards(c1: number, c2: number): number {
  return classIndex(c1 >> 2, c2 >> 2, (c1 & 3) === (c2 & 3));
}

/** Class of a combo index (`combos.ts`). */
export function classOfCombo(combo: number): number {
  const [a, b] = comboCards(combo);
  return classOfCards(a, b);
}

export interface HandClass {
  index: number;
  /** `"AA"`, `"AKs"`, `"AKo"`. */
  name: string;
  /** Higher and lower rank, evaluator encoding (12 = ace). */
  hi: number;
  lo: number;
  pair: boolean;
  suited: boolean;
  /** 6, 4 or 12. */
  combos: number;
  /** One combo of the class, as the evaluator's two cards (higher first). */
  rep: [number, number];
}

function buildClasses(): HandClass[] {
  const out: HandClass[] = new Array(NUM_CLASSES);
  for (let row = 0; row < 13; row += 1) {
    for (let col = 0; col < 13; col += 1) {
      const index = row * 13 + col;
      const pair = row === col;
      const suited = row < col;
      const hiGrid = Math.min(row, col);
      const loGrid = Math.max(row, col);
      const hi = 12 - hiGrid;
      const lo = 12 - loGrid;
      const name = pair
        ? RANKS_HIGH_FIRST[hiGrid] + RANKS_HIGH_FIRST[hiGrid]
        : RANKS_HIGH_FIRST[hiGrid] + RANKS_HIGH_FIRST[loGrid] + (suited ? "s" : "o");
      // Representative: spades for the high card, spades (suited) or hearts.
      const rep: [number, number] = [hi * 4, lo * 4 + (suited ? 0 : 1)];
      out[index] = { index, name, hi, lo, pair, suited, combos: pair ? 6 : suited ? 4 : 12, rep };
    }
  }
  return out;
}

/** The 169 classes in grid order. */
export const HAND_CLASSES: readonly HandClass[] = buildClasses();

/** Combos per class, as a typed array for hot loops. */
export const CLASS_COMBOS: Float64Array = Float64Array.from(HAND_CLASSES, (c) => c.combos);

/** Class index by name (`"AKs"`), or -1. */
export function classByName(name: string): number {
  const found = HAND_CLASSES.find((c) => c.name === name.trim());
  return found ? found.index : -1;
}

/** Combo indices of a class. */
export function combosOfClass(index: number): number[] {
  const c = HAND_CLASSES[index];
  const out: number[] = [];
  for (let s1 = 0; s1 < 4; s1 += 1) {
    for (let s2 = 0; s2 < 4; s2 += 1) {
      const a = c.hi * 4 + s1;
      const b = c.lo * 4 + s2;
      if (a === b) continue;
      if (c.pair ? s1 < s2 : c.suited ? s1 === s2 : s1 !== s2) {
        out.push(comboIndex(a, b));
      }
    }
  }
  return out;
}

/** Class of every combo index, `0..1325`. */
export const COMBO_CLASS: Uint8Array = (() => {
  const out = new Uint8Array(NUM_COMBOS);
  for (let k = 0; k < NUM_COMBOS; k += 1) {
    out[k] = classOfCombo(k);
  }
  return out;
})();

/** Combos of class `j` containing one particular card of rank `r`. */
export function incidence(j: number, rank: number): number {
  const c = HAND_CLASSES[j];
  if (c.pair) {
    return c.hi === rank ? 3 : 0;
  }
  if (c.hi !== rank && c.lo !== rank) {
    return 0;
  }
  return c.suited ? 1 : 3;
}

/** `m[i * 169 + j]`: combos of `j` compatible with one combo of `i` (see header). */
export const COMPAT: Float64Array = (() => {
  const out = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i += 1) {
    const { hi, lo } = HAND_CLASSES[i];
    for (let j = 0; j < NUM_CLASSES; j += 1) {
      out[i * NUM_CLASSES + j] =
        HAND_CLASSES[j].combos - incidence(j, hi) - incidence(j, lo) + (i === j ? 1 : 0);
    }
  }
  return out;
})();

/** Per class: its two ranks, for `massVector`'s per-rank sums. */
const CLASS_HI = Uint8Array.from(HAND_CLASSES, (c) => c.hi);
const CLASS_LO = Uint8Array.from(HAND_CLASSES, (c) => c.lo);
/** Per class: incidence of one card of its high rank / its low rank. */
const INC_HI = Float64Array.from(HAND_CLASSES, (c) => (c.pair ? 3 : c.suited ? 1 : 3));
const INC_LO = Float64Array.from(HAND_CLASSES, (c) => (c.pair ? 0 : c.suited ? 1 : 3));

/**
 * `out[i] = Σ_j m[i][j] x[j] / 1225` for every class `i`: the probability that
 * an opponent whose per-class weights are `x` is consistent with the hero
 * holding `i`. With `x` all ones it is exactly 1.
 *
 * `rankSum` is caller-provided scratch of length 13.
 */
export function massVector(x: ArrayLike<number>, out: Float64Array, rankSum: Float64Array): void {
  rankSum.fill(0);
  let total = 0;
  for (let j = 0; j < NUM_CLASSES; j += 1) {
    const v = x[j];
    if (v === 0) continue;
    total += CLASS_COMBOS[j] * v;
    rankSum[CLASS_HI[j]] += INC_HI[j] * v;
    // A pair's second card is the same rank; INC_LO is 0 for pairs, so the
    // pair's 3 per card sits in INC_HI alone.
    rankSum[CLASS_LO[j]] += INC_LO[j] * v;
  }
  for (let i = 0; i < NUM_CLASSES; i += 1) {
    out[i] = (total - rankSum[CLASS_HI[i]] - rankSum[CLASS_LO[i]] + x[i]) / COMBOS_AFTER_HAND;
  }
}

/**
 * `massVector` without card removal: `out[i] = Σ_j combos(j) x[j] / 1326` for
 * every `i` - the opponent's class drawn independently of the hero's.
 */
export function independentMass(x: ArrayLike<number>, out: Float64Array): void {
  let total = 0;
  for (let j = 0; j < NUM_CLASSES; j += 1) {
    total += CLASS_COMBOS[j] * x[j];
  }
  out.fill(total / NUM_COMBOS);
}

/** A 169-weight vector from range text-like `{ AA: 1, AKs: 0.5 }`. */
export function classVector(weights: Readonly<Record<string, number>>): Float64Array {
  const out = new Float64Array(NUM_CLASSES);
  for (const [name, w] of Object.entries(weights)) {
    const k = classByName(name);
    if (k < 0) {
      throw new Error(`not a hand class: ${name}`);
    }
    out[k] = w;
  }
  return out;
}

/** Share of all 1326 combos in a per-class weight vector (0..1). */
export function comboShare(x: ArrayLike<number>): number {
  let sum = 0;
  for (let j = 0; j < NUM_CLASSES; j += 1) {
    sum += CLASS_COMBOS[j] * x[j];
  }
  return sum / NUM_COMBOS;
}
