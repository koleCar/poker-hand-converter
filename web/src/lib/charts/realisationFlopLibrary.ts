/**
 * Measuring equity realisation on the flop library (`charts/10` experiment).
 *
 * `realisation.ts` measures the realised share of each class on turn+river
 * solves with the flop checked through (docs/CHARTS.md §4.2): a street of
 * betting short, which §9 names as the reason the charts fold UTG's 55-22 and
 * A5s and barely flat in position. The flop library (A5b) has since solved
 * twelve heads-up lines of the 6-max 100bb set over 100 representative flops
 * with flop, turn and river betting, and every chunk keeps both players' root
 * EV per combo. This module turns those chunks into the same per-class sums
 * the fit reads (`RealisationSample`), so `fitRealisation` can fit the
 * realisation model on them unchanged:
 *
 *  - `weight`: the flop's coverage (how many of the 22,100 flops read this
 *    representative) x the combo's range weight x the opponent's compatible
 *    range mass, summed over the class's combos;
 *  - `share`: the same sum of `weight x root EV / pot`, scaled by the line's
 *    `1 / (share_0 + share_1)` so the two players' shares sum to one: the
 *    solves are raked, and the preflop model takes its rake from the pot
 *    before splitting it (`value = share x (pot - rake)`);
 *  - `equity`: the same sum of `weight x check-down equity` on that flop
 *    (every turn and river), so `share / equity` cancels most of the noise of
 *    a hundred flops, as it does for the turn deals.
 *
 * What it cannot measure: classes outside a range. The library solved the
 * charts' own ranges, so UTG's 55 (folded today) has no row; the fit reaches
 * it through the class features, as it reaches every class a spot lacks.
 *
 * Pure: the caller reads the chunks (`tests/scripts/preflop-charts/refitFlopLibrary.test.ts`).
 */

import { comboCards, parseCards } from "../solver/combos";
import { COMBO_CLASS, combosOfClass, NUM_CLASSES } from "../solver/handClasses";
import type { PotType, RealisationRole } from "../solver/preflopModel";
import { emptySample, type RealisationSample } from "../solver/preflopRealisation";
import type { SolveResult } from "../solver/solve";
import { strengths } from "../solver/subgame";
import type { PreparedSpot } from "./realisation";

const H = NUM_CLASSES;

/** One solved flop of a line and how much of the flop space it stands for. */
export interface WeightedFlop {
  result: SolveResult;
  /** Flops (of 22,100, suit-weighted) that read this representative. */
  coverage: number;
}

/**
 * Check-down equity of every hand of both players on a flop, over every turn
 * and river: per hand, the share of the opponent's compatible range mass it
 * beats (ties half), summed over runouts and divided by the mass it met.
 * `combos` are the hands' combo indices (to find the same combo on the other
 * side), `cards` their two cards.
 */
export function checkDownEquity(
  board: readonly number[],
  combos: readonly [ArrayLike<number>, ArrayLike<number>],
  cards: readonly [[number, number][], [number, number][]],
  weights: readonly [ArrayLike<number>, ArrayLike<number>],
): [Float64Array, Float64Array] {
  const sizes = [cards[0].length, cards[1].length];
  const won = sizes.map((n) => new Float64Array(n));
  const met = sizes.map((n) => new Float64Array(n));
  // The same combo held by the other player: the card sums subtract it twice.
  const twin = [0, 1].map((p) => {
    const at = new Map<number, number>();
    Array.from(combos[1 - p]).forEach((c, j) => at.set(c, j));
    return Int32Array.from(combos[p], (c) => at.get(c) ?? -1);
  });
  const rest: number[] = [];
  for (let c = 0; c < 52; c += 1) if (!board.includes(c)) rest.push(c);
  const order = sizes.map((n) => new Int32Array(n));
  const live = [0, 0];
  const less = new Float64Array(52);
  const upto = new Float64Array(52);
  const all = new Float64Array(52);
  for (let t = 0; t < rest.length; t += 1) {
    for (let r = t + 1; r < rest.length; r += 1) {
      const five = [...board, rest[t], rest[r]];
      const s = [strengths(cards[0], five), strengths(cards[1], five)];
      for (const p of [0, 1]) {
        let n = 0;
        for (let i = 0; i < sizes[p]; i += 1) if (!Number.isNaN(s[p][i])) order[p][n++] = i;
        const sp = s[p];
        order[p].subarray(0, n).sort((a, b) => sp[a] - sp[b]);
        live[p] = n;
      }
      for (const p of [0, 1]) {
        const o = 1 - p;
        const opp = order[o];
        const so = s[o];
        const wo = weights[o];
        less.fill(0);
        upto.fill(0);
        all.fill(0);
        let totLess = 0;
        let totUpto = 0;
        let tot = 0;
        for (let k = 0; k < live[o]; k += 1) {
          const j = opp[k];
          const [a, b] = cards[o][j];
          tot += wo[j];
          all[a] += wo[j];
          all[b] += wo[j];
        }
        let iLess = 0;
        let iUpto = 0;
        for (let k = 0; k < live[p]; k += 1) {
          const i = order[p][k];
          const v = s[p][i];
          while (iLess < live[o] && so[opp[iLess]] < v) {
            const j = opp[iLess++];
            const [a, b] = cards[o][j];
            totLess += wo[j];
            less[a] += wo[j];
            less[b] += wo[j];
          }
          while (iUpto < live[o] && so[opp[iUpto]] <= v) {
            const j = opp[iUpto++];
            const [a, b] = cards[o][j];
            totUpto += wo[j];
            upto[a] += wo[j];
            upto[b] += wo[j];
          }
          const [a, b] = cards[p][i];
          // The twin ties, so it is in `upto` and `all` but never in `less`.
          const j = twin[p][i];
          const same = j >= 0 && !Number.isNaN(so[j]) ? wo[j] : 0;
          won[p][i] += (totLess - less[a] - less[b] + totUpto - upto[a] - upto[b] + same) / 2;
          met[p][i] += tot - all[a] - all[b] + same;
        }
      }
    }
  }
  const out: [Float64Array, Float64Array] = [new Float64Array(sizes[0]), new Float64Array(sizes[1])];
  for (const p of [0, 1]) for (let i = 0; i < sizes[p]; i += 1) out[p][i] = met[p][i] > 0 ? won[p][i] / met[p][i] : 0;
  return out;
}

/** Per-class sums of one line over its solved flops (see the module header), and the rake its solves took as a fraction of the flop pot. */
export function flopLibrarySample(flops: readonly WeightedFlop[]): { sample: RealisationSample; rake: number } {
  const sample = emptySample();
  const total = [0, 0];
  for (const { result: r, coverage } of flops) {
    const board = parseCards(r.board);
    const cards: [[number, number][], [number, number][]] = [Array.from(r.hands[0], comboCards), Array.from(r.hands[1], comboCards)];
    const eq = checkDownEquity(board, r.hands, cards, r.weights);
    for (const p of [0, 1] as const) {
      const o = 1 - p;
      const cardSum = new Float64Array(52);
      const byCombo = new Map<number, number>();
      let tot = 0;
      for (let j = 0; j < cards[o].length; j += 1) {
        const w = r.weights[o][j];
        const [a, b] = cards[o][j];
        tot += w;
        cardSum[a] += w;
        cardSum[b] += w;
        byCombo.set(r.hands[o][j], w);
      }
      for (let i = 0; i < cards[p].length; i += 1) {
        const [a, b] = cards[p][i];
        const mass = tot - cardSum[a] - cardSum[b] + (byCombo.get(r.hands[p][i]) ?? 0);
        const w = coverage * r.weights[p][i] * mass;
        if (w <= 0) continue;
        const c = COMBO_CLASS[r.hands[p][i]];
        const share = (w * r.rootEv[p][i]) / r.pot;
        sample.weight[p][c] += w;
        sample.share[p][c] += share;
        sample.equity[p][c] += w * eq[p][i];
        total[p] += share;
      }
    }
  }
  // Rake back out: the two players' realised shares of the raked pot sum to one.
  const both = total[0] / sumOf(sample.weight[0]) + total[1] / sumOf(sample.weight[1]);
  for (const p of [0, 1]) for (let c = 0; c < H; c += 1) sample.share[p][c] /= both;
  return { sample, rake: 1 - both };
}

function sumOf(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i += 1) s += x[i];
  return s;
}

/**
 * A line's spot as the fit reads it: class ranges (each class's mean combo
 * weight before the board, from the solves' own range weights), roles, pot
 * and stack. `aggressor`: the out-of-position (0) or in-position (1) player
 * who raised last preflop, or -1 for a limped pot.
 */
export function flopLibrarySpot(
  line: string,
  potType: PotType,
  positions: [string, string],
  aggressor: -1 | 0 | 1,
  flops: readonly WeightedFlop[],
): PreparedSpot {
  const ranges: [Float64Array, Float64Array] = [new Float64Array(H), new Float64Array(H)];
  for (const p of [0, 1] as const) {
    const byCombo = new Map<number, number>();
    for (const { result } of flops) result.hands[p].forEach((h, i) => byCombo.set(h, result.weights[p][i]));
    for (const [h, w] of byCombo) ranges[p][COMBO_CLASS[h]] += w;
    for (let c = 0; c < H; c += 1) ranges[p][c] /= combosOfClass(c).length;
  }
  const combos = ranges.map((r) => r.reduce((s, v, c) => s + v * combosOfClass(c).length, 0)) as [number, number];
  const roles: [RealisationRole, RealisationRole] = [
    aggressor === 0 ? "oopAgg" : "oopCaller",
    aggressor === 1 ? "ipAgg" : "ipCaller",
  ];
  const first = flops[0].result;
  return { line, potType, roles, positions, ranges, pot: first.pot, stack: first.stack, combos };
}
