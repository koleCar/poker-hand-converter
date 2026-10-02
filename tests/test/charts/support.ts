/**
 * The committed chart sets, read from disk for the tests (the app imports
 * them lazily, one chunk per set; `lib/charts/registry.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  loadCharts,
  type ChartLibrary,
  type ChartSet,
} from "../../../frontend/src/lib/charts/index.js";

export const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");

export const fileOf = (id: string) => join(DATA, `${id}.json`);

const cache = new Map<string, ChartSet>();

/** One committed set by id. */
export function chartSet(id: string): ChartSet {
  let set = cache.get(id);
  if (!set) {
    set = loadCharts(JSON.parse(readFileSync(fileOf(id), "utf8")));
    cache.set(id, set);
  }
  return set;
}

/** A library with every committed set loaded (the default set first: the library's own fields). */
export function fullLibrary(): ChartLibrary {
  const ids = [DEFAULT_CHART_SET, ...CHART_SETS.map((s) => s.id).filter((id) => id !== DEFAULT_CHART_SET)];
  return chartLibrary(ids.map(chartSet));
}
