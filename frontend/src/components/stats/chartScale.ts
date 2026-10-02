/**
 * Axis arithmetic shared by the hand-written SVG charts: the win-rate graph
 * (`WinrateGraph.tsx`) and the analysis progress charts
 * (`components/analysis/progress/TrendChart.tsx`).
 */

/** Round a span up to a readable step: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(span: number, targetTicks: number): number {
  if (span <= 0) {
    return 1;
  }
  const rough = span / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + 1e-9; value += step) {
    // Kill the -0 that falls out of the accumulation and prints as "-0".
    out.push(value === 0 ? 0 : value);
  }
  return out;
}
