/**
 * The preflop chart library in the browser, loaded once per page load.
 *
 * `lib/charts` keeps one JSON file per table and stack depth (`charts/3`,
 * `registry.ts`), each a dynamic import the bundler splits into its own
 * chunk (0.25-2 MB of JSON each). Several places want them — the main-thread
 * fallback of the analysis rebuild, the hand view's fresh analysis, and the
 * chart viewers — and none of them should pay for a set twice or for a set
 * its hands do not need. (The Web Worker loads its own copies: a worker has
 * its own module graph.)
 *
 * - `preflopCharts()`: the library with its default set (6-max 100bb) loaded.
 *   It is a `ChartSet` itself - its own fields are the default set's - so
 *   the reports and the chart browser read it as before.
 * - `preflopChartsFor(hands)`: the same library with every set those hands
 *   need loaded, for `analyzeHand` (whose lookup is synchronous).
 * - `preflopChartSet(id)`: one set by id, for a viewer drawing a node a
 *   stored grade names.
 *
 * A failed load is forgotten, so the next caller retries instead of being
 * handed the same rejection forever.
 */

import { ensureChartSets, loadChartLibrary, rareLineChartSets, requiredChartSets, type ChartLibrary, type ChartSet } from "./charts";
import type { PhfHand } from "./phf/types";

let loading: Promise<ChartLibrary> | null = null;

export function preflopCharts(): Promise<ChartLibrary> {
  loading ??= loadChartLibrary().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** The library with every set these hands' preflop lookups need. */
export async function preflopChartsFor(hands: readonly PhfHand[]): Promise<ChartLibrary> {
  const library = await preflopCharts();
  await ensureChartSets(library, hands.flatMap((hand) => requiredChartSets(hand, library.specs)));
  // A rare line is read on a neighbouring depth when graded (analysis/13); known once the sets above are in.
  await ensureChartSets(library, hands.flatMap((hand) => rareLineChartSets(hand, library)));
  return library;
}

/** One set by id (null for an id the library does not list). */
export async function preflopChartSet(id: string): Promise<ChartSet | null> {
  const library = await preflopCharts();
  if (!library.specs.some((spec) => spec.id === id)) return null;
  await ensureChartSets(library, [id]);
  return library.sets.get(id) ?? null;
}
