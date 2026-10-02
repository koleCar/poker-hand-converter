/**
 * Heads-up preflop equity between the 169 hand classes, with card removal.
 *
 * `E[i][j]` is the all-in equity (wins plus half the ties) of a combo of class
 * `i` against a uniformly random combo of class `j` that shares no card with
 * it, over a uniformly random five-card board. By suit symmetry every combo of
 * `i` gives the same average, so one representative combo per class is enough
 * for the hero side; the opponent side runs over every compatible combo of
 * `j`, which is where card removal enters (`AKs` against `AKo` is mostly
 * chops, `AA` against `AKs` is the two combos that do not hold a hero ace).
 *
 * **Sampled, seeded, shared boards.** Each sampled board is evaluated once for
 * all 1326 combos and then scored for all 169 representatives against every
 * compatible opponent combo. That is ~180,000 comparisons per board and no
 * evaluation in the inner loop. Exhaustive enumeration (1.7M boards per pair)
 * is out of reach for 28,561 class pairs; a seeded `mulberry32` sample makes the
 * table reproducible to the bit, which is what the chart generator needs.
 * The standard error of an entry is reported (`standardError`): about 0.001
 * for the generator's 120,000 boards.
 *
 * **Symmetrised.** `E[i][j]` and `1 - E[j][i]` estimate the same number from
 * two different representatives; the table stores their average, so
 * `E[i][j] + E[j][i] = 1` exactly. The solver relies on that: a heads-up pot is
 * conserved (minus rake) because the two players' shares are complementary.
 */

import { evaluateMasks, mulberry32, STANDARD } from "../equity";
import { comboCards, NUM_COMBOS } from "./combos";
import { COMBO_CLASS, HAND_CLASSES, NUM_CLASSES } from "./handClasses";

export interface PreflopEquityOptions {
  /** Boards sampled. Default 120,000. */
  boards?: number;
  /** Seed for `mulberry32`. Default 0x5eed. */
  seed?: number;
}

export interface PreflopEquityTable {
  /** `equity[i * 169 + j]`, symmetrised so `equity[i,j] + equity[j,i] = 1`. */
  equity: Float64Array;
  boards: number;
  seed: number;
  /**
   * Mean over class pairs of a conservative standard error of an entry: one
   * binomial trial per board on which both representatives were live.
   */
  standardError: number;
}

export const DEFAULT_EQUITY_BOARDS = 120_000;
export const DEFAULT_EQUITY_SEED = 0x5eed;

/** Computes the 169x169 equity table. ~30 s for the default 120,000 boards. */
export function preflopEquityTable(options: PreflopEquityOptions = {}): PreflopEquityTable {
  const boards = options.boards ?? DEFAULT_EQUITY_BOARDS;
  const seed = options.seed ?? DEFAULT_EQUITY_SEED;
  const random = mulberry32(seed);
  const n = NUM_CLASSES;

  // Combo cards, once.
  const c1 = new Uint8Array(NUM_COMBOS);
  const c2 = new Uint8Array(NUM_COMBOS);
  const cls = new Uint8Array(NUM_COMBOS);
  for (let k = 0; k < NUM_COMBOS; k += 1) {
    const [a, b] = comboCards(k);
    c1[k] = a;
    c2[k] = b;
    cls[k] = COMBO_CLASS[k];
  }
  // Representative combo index per class.
  const repCombo = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const [a, b] = HAND_CLASSES[i].rep;
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    repCombo[i] = (hi * (hi - 1)) / 2 + lo;
  }

  // Wins in half-points and trials, per (rep i, opponent class j); boards
  // on which each representative was live, for the standard error.
  const repBoards = new Float64Array(n);
  const halfWins = new Float64Array(n * n);
  const trials = new Float64Array(n * n);
  const strength = new Int32Array(NUM_COMBOS);
  const valid = new Int32Array(NUM_COMBOS);
  const board = new Int32Array(5);
  const masks = new Int32Array(4);

  for (let t = 0; t < boards; t += 1) {
    // Five distinct cards.
    let used = 0n;
    for (let k = 0; k < 5; ) {
      const card = Math.floor(random() * 52);
      const bit = 1n << BigInt(card);
      if (used & bit) continue;
      used |= bit;
      board[k] = card;
      k += 1;
    }
    masks.fill(0);
    let boardLo = 0;
    let boardHi = 0;
    for (let k = 0; k < 5; k += 1) {
      const card = board[k];
      masks[card & 3] |= 1 << (card >> 2);
      if (card < 32) boardLo |= 1 << card;
      else boardHi |= 1 << (card - 32);
    }
    const onBoard = (card: number) => (card < 32 ? (boardLo >>> card) & 1 : (boardHi >>> (card - 32)) & 1);

    let count = 0;
    for (let k = 0; k < NUM_COMBOS; k += 1) {
      const a = c1[k];
      const b = c2[k];
      if (onBoard(a) || onBoard(b)) continue;
      let m0 = masks[0];
      let m1 = masks[1];
      let m2 = masks[2];
      let m3 = masks[3];
      for (let h = 0; h < 2; h += 1) {
        const card = h === 0 ? a : b;
        const bit = 1 << (card >> 2);
        const suit = card & 3;
        if (suit === 0) m0 |= bit;
        else if (suit === 1) m1 |= bit;
        else if (suit === 2) m2 |= bit;
        else m3 |= bit;
      }
      strength[k] = evaluateMasks(STANDARD, m0, m1, m2, m3);
      valid[count] = k;
      count += 1;
    }

    for (let i = 0; i < n; i += 1) {
      const rep = repCombo[i];
      const ra = c1[rep];
      const rb = c2[rep];
      if (onBoard(ra) || onBoard(rb)) continue;
      repBoards[i] += 1;
      const s = strength[rep];
      const row = i * n;
      for (let v = 0; v < count; v += 1) {
        const k = valid[v];
        const a = c1[k];
        const b = c2[k];
        if (a === ra || a === rb || b === ra || b === rb) continue;
        const o = strength[k];
        const cell = row + cls[k];
        trials[cell] += 1;
        halfWins[cell] += s > o ? 2 : s === o ? 1 : 0;
      }
    }
  }

  const raw = new Float64Array(n * n);
  for (let k = 0; k < n * n; k += 1) {
    raw[k] = trials[k] > 0 ? halfWins[k] / (2 * trials[k]) : 0.5;
  }
  const equity = new Float64Array(n * n);
  let seSum = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const a = i * n + j;
      const b = j * n + i;
      equity[a] = i === j ? 0.5 : (raw[a] + 1 - raw[b]) / 2;
      const e = equity[a];
      // Conservative: one independent trial per board, not per opponent combo
      // (the combos of one class on one board are strongly correlated).
      const live = repBoards[i] + repBoards[j];
      seSum += i !== j && live > 0 ? Math.sqrt((e * (1 - e)) / live) : 0;
    }
  }
  return { equity, boards, seed, standardError: seSum / (n * n) };
}
