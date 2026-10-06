/**
 * The formulas behind the numbers lessons state (`MathCheck`), by name: the
 * concept library's own (`lib/learn/math.ts`) plus plain products, sums and
 * ratios. `tests/test/course.test.ts` recomputes every check.
 */

import {
  allFold,
  alpha,
  bluffCatcherEv,
  bluffEv,
  bluffShare,
  callEv,
  geometricBet,
  mdf,
  mdfSplit,
  potOddsRatio,
  requiredEquity,
  spr,
  valuePerBluff,
} from "../math";
import type { MathCheck, MathFn } from "./types";

export const MATH: Readonly<Record<MathFn, (...args: number[]) => number>> = {
  requiredEquity: (pot, call) => requiredEquity(pot, call),
  potOddsRatio: (pot, call) => potOddsRatio(pot, call),
  callEv: (pot, call, equity) => callEv(pot, call, equity),
  alpha: (pot, bet) => alpha(pot, bet),
  mdf: (pot, bet) => mdf(pot, bet),
  bluffShare: (pot, bet) => bluffShare(pot, bet),
  valuePerBluff: (pot, bet) => valuePerBluff(pot, bet),
  bluffEv: (pot, risk, folds) => bluffEv(pot, risk, folds),
  bluffCatcherEv: (pot, bet, bluffs) => bluffCatcherEv(pot, bet, bluffs),
  spr: (stack, pot) => spr(stack, pot),
  geometricBet: (pot, stack, streets) => geometricBet(pot, stack, streets),
  allFold: (foldEach, opponents) => allFold(foldEach, opponents),
  mdfSplit: (pot, bet, defenders) => mdfSplit(pot, bet, defenders),
  product: (...xs) => xs.reduce((a, b) => a * b, 1),
  sum: (...xs) => xs.reduce((a, b) => a + b, 0),
  ratio: (a, b) => (b !== 0 ? a / b : Number.NaN),
};

/** The tolerance a check is held to: its own, or half the last written digit of `value` (at least 0.0005). */
export function checkTolerance(check: MathCheck): number {
  if (check.tolerance !== undefined) return check.tolerance;
  const text = String(check.value);
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  return Math.max(0.0005, 0.5 * 10 ** -decimals);
}

/** Whether a check holds. */
export function checkHolds(check: MathCheck): boolean {
  const fn = MATH[check.fn];
  const got = fn(...check.args);
  return Number.isFinite(got) && Math.abs(got - check.value) <= checkTolerance(check) + 1e-12;
}
