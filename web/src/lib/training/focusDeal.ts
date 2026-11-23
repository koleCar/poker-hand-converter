/**
 * Dealing a spot Analytics asked for (docs/ANALYTICS.md Step 9): only bets
 * of one size bucket, only hero hands of chosen hand classes. The buckets
 * and the classes are the catalogue's (`config/stats/analytics.json`), read
 * exactly as the checker rows read a played decision (`analyticsRows.ts`):
 *
 * - a bet's bucket from what the hero faces, `toCall / (pot − toCall)` with
 *   the pot holding the bet (`facts.facingPot`);
 * - a hand's class from its made hand and draws on the board
 *   (`ANALYTICS.handClass(madeHand.class, draws)`, first match wins).
 *
 * So a spot dealt here lands in the same row of the checker as a real hand
 * with that bet and those cards would. Pure; the generators (`flop.ts`,
 * `turn.ts`, `river.ts`) call it where they draw the villain's bet and the
 * hero's combo.
 */

import { draws, madeHand } from "../analysis/texture";
import { comboHi, comboLo } from "../solver";
import { ANALYTICS } from "../stats/analytics";

/** What Analytics narrows a deal to; absent fields narrow nothing. */
export interface DealFocus {
  /** A size bucket id (`20-40`, …): the bet the hero faces. */
  size?: string | null;
  /** Hand class ids: the hero's hand is one of them. */
  classes?: readonly string[] | null;
}

/** The size bucket of the bet faced at a node whose pot already holds it; null when nothing is faced. */
export function facingBucket(pot: number, toCall: number): string | null {
  if (!(toCall > 0) || !(pot - toCall > 0)) return null;
  return ANALYTICS.sizeBucket(Math.round((toCall / (pot - toCall)) * 1000) / 1000)?.id ?? null;
}

/** The size bucket of a bet of `sizePot` (its amount over the pot before it). */
export function betBucket(sizePot: number): string | null {
  return ANALYTICS.sizeBucket(Math.round(sizePot * 1000) / 1000)?.id ?? null;
}

/** The catalogue's hand class of two hole cards on a board (card indices); null preflop. */
export function handClassOf(hole: readonly number[], board: readonly number[]): string | null {
  if (board.length < 3) return null;
  const made = madeHand(hole, board);
  return ANALYTICS.handClass(made?.class ?? null, draws(hole, board))?.id ?? null;
}

/** Whether a focus narrows the hero's hands. */
export function narrowsClasses(focus: DealFocus | null | undefined): focus is DealFocus & { classes: readonly string[] } {
  return Boolean(focus?.classes && focus.classes.length > 0);
}

/**
 * Dealing weights kept only for the hero's combos in one of the classes
 * (`hands[i]` is the combo of weight `i`); the others weigh 0. The weights
 * are changed in place and returned. No classes: unchanged.
 */
export function keepClasses(weights: Float64Array, hands: ArrayLike<number>, board: readonly number[], focus: DealFocus | null | undefined): Float64Array {
  if (!narrowsClasses(focus)) return weights;
  const wanted = new Set(focus.classes);
  for (let i = 0; i < weights.length; i += 1) {
    if (!(weights[i] > 0)) continue;
    const combo = hands[i];
    const cls = handClassOf([comboHi(combo), comboLo(combo)], board);
    if (cls === null || !wanted.has(cls)) weights[i] = 0;
  }
  return weights;
}
