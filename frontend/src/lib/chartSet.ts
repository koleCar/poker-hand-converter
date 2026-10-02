/**
 * The preflop chart set in the browser, loaded once per page load.
 *
 * `lib/charts` exposes `loadDefaultCharts()`, a dynamic import of ~630 KB of
 * JSON that the bundler splits into its own chunk. Three places want it — the
 * main-thread fallback of the analysis rebuild, the hand view's fresh
 * analysis, and the chart viewers — and none of them should pay for it twice
 * or before they need it. (The Web Worker loads its own copy: a worker has
 * its own module graph.)
 *
 * A failed load is forgotten, so the next caller retries instead of being
 * handed the same rejection forever.
 */

import { loadDefaultCharts, type ChartSet } from "./charts";

let loading: Promise<ChartSet> | null = null;

export function preflopCharts(): Promise<ChartSet> {
  loading ??= loadDefaultCharts().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
