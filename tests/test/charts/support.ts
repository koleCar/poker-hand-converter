/**
 * The chart sets, read from disk for the tests (the app imports them lazily,
 * one chunk per set; `lib/charts/registry.ts`).
 *
 * Since `charts/11` the committed sets are GTO Wizard transcriptions, and
 * only the ones captured so far ship (`CHART_SETS`). Tests of the analysis'
 * mechanics need classic tables too, so `test/fixtures/charts/` keeps three
 * earlier transcriptions as **test data** (6-max 100bb and heads-up 100bb at
 * NL500, 6-max 150bb chip EV - superseded by the NL100 captures, never
 * shipped): `chartSet(id)` reads a committed set first and a fixture only
 * where no set of that id is committed, and `TEST_CHART_SETS` is
 * `CHART_SETS` plus the fixtures not shadowed. Once a captured set of the
 * same id lands in `web/src/lib/charts/data/`, the tests read it instead.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHART_SETS,
  chartLibrary,
  loadCharts,
  type ChartLibrary,
  type ChartSet,
  type ChartSetSpec,
} from "../../../web/src/lib/charts/index.js";

export const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
export const FIXTURES = join(import.meta.dirname, "../fixtures/charts");

/** The committed file of a set, else its fixture. */
export const fileOf = (id: string) => (existsSync(join(DATA, `${id}.json`)) ? join(DATA, `${id}.json`) : join(FIXTURES, `${id}.json`));

const cache = new Map<string, ChartSet>();

/** One set by id: committed, else a test fixture. */
export function chartSet(id: string): ChartSet {
  let set = cache.get(id);
  if (!set) {
    set = loadCharts(JSON.parse(readFileSync(fileOf(id), "utf8")));
    cache.set(id, set);
  }
  return set;
}

/** The classic sets the fixtures stand in for until their captures ship: table and depth. */
const FIXTURE_SETS: readonly Pick<ChartSetSpec, "id" | "players" | "stackBb">[] = [
  { id: "nlhe-cash-6max-100bb", players: 6, stackBb: 100 },
  { id: "nlhe-cash-6max-150bb", players: 6, stackBb: 150 },
  { id: "nlhe-cash-hu-100bb", players: 2, stackBb: 100 },
];

/** `CHART_SETS` and the fixtures no committed set shadows: the specs a test library reads. */
export const TEST_CHART_SETS: readonly ChartSetSpec[] = [
  ...CHART_SETS,
  ...FIXTURE_SETS.filter((f) => !CHART_SETS.some((s) => s.id === f.id)).map((f) => ({
    ...f,
    load: () => Promise.resolve(JSON.parse(readFileSync(fileOf(f.id), "utf8")) as unknown),
  })),
];

/** The classic 6-max 100bb set: the one most tests deal on (a fixture until its capture ships). */
export const SIX_MAX_100 = "nlhe-cash-6max-100bb";

/** A library over `TEST_CHART_SETS` with every one loaded, the 6-max 100bb set first (the library's own fields). */
export function fullLibrary(): ChartLibrary {
  const ids = [SIX_MAX_100, ...TEST_CHART_SETS.map((s) => s.id).filter((id) => id !== SIX_MAX_100)];
  return chartLibrary(ids.map(chartSet), TEST_CHART_SETS);
}
