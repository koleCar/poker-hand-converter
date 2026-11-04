/**
 * The win-rate graph's arithmetic (`WinrateGraph.tsx`, `WinratePlot.tsx`):
 * finding a point, reading a line between its points, the y range of a zoomed
 * window, the window's zoom and pan, and a line's SVG path at the resolution
 * the screen can show. Pure functions over typed arrays, so a graph of a
 * thousand points re-draws inside one animation frame.
 *
 * Every line is a pair of arrays: `xs`, the cumulative hands (ascending, from
 * 0), and `ys`, the line's value at each.
 */

import { niceStep } from "./chartScale";

/** A window of the x-axis, in hands. */
export interface HandsWindow {
  from: number;
  to: number;
}

/** The index of the first `x >= value` (`xs.length` when there is none). */
export function lowerBound(xs: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** The index of the point nearest to `value` (the earlier one on a tie). */
export function nearestIndex(xs: ArrayLike<number>, value: number): number {
  if (xs.length === 0) {
    return -1;
  }
  const at = lowerBound(xs, value);
  if (at <= 0) {
    return 0;
  }
  if (at >= xs.length) {
    return xs.length - 1;
  }
  return value - xs[at - 1] <= xs[at] - value ? at - 1 : at;
}

/** A line's value at `x`: straight between its points, its end's value past either end. */
export function valueAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) {
    return 0;
  }
  if (x <= xs[0]) {
    return ys[0];
  }
  if (x >= xs[n - 1]) {
    return ys[n - 1];
  }
  const at = lowerBound(xs, x);
  const x0 = xs[at - 1];
  const x1 = xs[at];
  const share = x1 === x0 ? 1 : (x - x0) / (x1 - x0);
  return ys[at - 1] + (ys[at] - ys[at - 1]) * share;
}

/** A line read at other points (`valueAt` at each of `targetXs`). */
export function resample(xs: ArrayLike<number>, ys: ArrayLike<number>, targetXs: ArrayLike<number>): Float64Array {
  const out = new Float64Array(targetXs.length);
  for (let i = 0; i < targetXs.length; i += 1) {
    out[i] = valueAt(xs, ys, targetXs[i]);
  }
  return out;
}

/** The lowest and highest value of the lines over `[from, to]`, the lines' values at the window's edges included. */
export function extentIn(
  xs: ArrayLike<number>,
  lines: readonly ArrayLike<number>[],
  from: number,
  to: number,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const first = lowerBound(xs, from);
  const last = lowerBound(xs, to);
  for (const ys of lines) {
    for (const edge of [valueAt(xs, ys, from), valueAt(xs, ys, to)]) {
      min = Math.min(min, edge);
      max = Math.max(max, edge);
    }
    for (let i = first; i < last && i < xs.length; i += 1) {
      min = Math.min(min, ys[i]);
      max = Math.max(max, ys[i]);
    }
  }
  return Number.isFinite(min) ? [min, max] : [0, 0];
}

/**
 * A readable y range around `[min, max]`: whole steps of `niceStep`, zero
 * included when `withZero` (the whole sample's graph; a zoomed window spends
 * its height on the window's own swings).
 */
export function niceRange(min: number, max: number, withZero: boolean): { y0: number; y1: number; step: number } {
  const lo = withZero ? Math.min(0, min) : min;
  const hi = withZero ? Math.max(0, max) : max;
  // A dead-flat window would otherwise divide by zero; give it a unit range.
  const span = hi - lo || 2;
  const step = niceStep(span, 5);
  let y0 = Math.floor(lo / step) * step;
  let y1 = Math.ceil(hi / step) * step;
  if (y1 - y0 < step) {
    y0 -= step;
    y1 += step;
  }
  return { y0, y1, step };
}

/**
 * The window `factor` times as wide (under 1 zooms in), keeping `center`
 * where it is on screen. Null once it covers the whole sample.
 */
export function zoomWindow(
  window: HandsWindow | null,
  factor: number,
  center: number,
  total: number,
  minSpan: number,
): HandsWindow | null {
  const current = window ?? { from: 0, to: total };
  const span = current.to - current.from;
  const next = Math.min(total, Math.max(minSpan, span * factor));
  if (next >= total - 1e-9) {
    return null;
  }
  const share = span > 0 ? (center - current.from) / span : 0.5;
  const from = clamp(center - share * next, 0, total - next);
  return { from, to: from + next };
}

/** The window moved by `delta` hands, kept inside the sample. */
export function panWindow(window: HandsWindow | null, delta: number, total: number): HandsWindow | null {
  if (!window) {
    return null;
  }
  const span = window.to - window.from;
  const from = clamp(window.from + delta, 0, total - span);
  return { from, to: from + span };
}

/** A window from two hands in any order, at least `minSpan` wide and inside the sample. */
export function windowBetween(a: number, b: number, total: number, minSpan: number): HandsWindow | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const span = Math.max(minSpan, hi - lo);
  if (span >= total - 1e-9) {
    return null;
  }
  const from = clamp((lo + hi) / 2 - span / 2, 0, total - span);
  return { from, to: from + span };
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

const fixed = (value: number) => Math.round(value * 10) / 10;

/**
 * A line's SVG path over `[from, to]` (one point either side, so it runs to
 * the edges), in screen coordinates. Where there are more points than pixel
 * columns it keeps, per column, the first, the lowest, the highest and the
 * last point (M4): exactly the pixels the full line would light, at a few
 * points per column however long the sample.
 */
export function linePath(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  from: number,
  to: number,
  toX: (x: number) => number,
  toY: (y: number) => number,
): string {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) {
    return "";
  }
  const first = Math.max(0, lowerBound(xs, from) - 1);
  const last = Math.min(n - 1, lowerBound(xs, to));
  const parts: string[] = [];
  const push = (i: number) => {
    parts.push(`${parts.length === 0 ? "M" : "L"}${fixed(toX(xs[i]))},${fixed(toY(ys[i]))}`);
  };
  const columns = Math.abs(toX(to) - toX(from));
  if (last - first + 1 <= columns * 2) {
    for (let i = first; i <= last; i += 1) {
      push(i);
    }
    return parts.join("");
  }
  let column = Math.floor(toX(xs[first]));
  let start = first;
  let low = first;
  let high = first;
  let end = first;
  const flush = () => {
    const picked = [start, low, high, end].sort((a, b) => a - b);
    let previous = -1;
    for (const i of picked) {
      if (i !== previous) {
        push(i);
        previous = i;
      }
    }
  };
  for (let i = first + 1; i <= last; i += 1) {
    const at = Math.floor(toX(xs[i]));
    if (at !== column) {
      flush();
      column = at;
      start = i;
      low = i;
      high = i;
    } else {
      if (ys[i] < ys[low]) low = i;
      if (ys[i] > ys[high]) high = i;
    }
    end = i;
  }
  flush();
  return parts.join("");
}
