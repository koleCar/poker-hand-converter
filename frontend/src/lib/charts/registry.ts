/**
 * The chart library (`charts/3`, phase A2c): every committed chart set, which
 * one answers a spot, and loading them one at a time.
 *
 * **Sets.** One JSON file per table and stack depth (`data/<id>.json`, see
 * docs/CHARTS.md §6): 6-max at 40 / 60 / 100 / 150 / 200bb and 9-max at
 * 100 / 150 / 200bb. `CHART_SETS` lists them with their table and depth -
 * the manifest is a few hundred bytes; each set is its own dynamic import,
 * so a bundler splits every set into its own chunk and a page (or the
 * analysis worker) downloads only the sets its hands need.
 *
 * **Which set** (`pickChartSet`):
 *
 * 1. **Table.** `k` players dealt in are read on the smallest set with at
 *    least `k` seats: 3-6 handed on a 6-max set, 7-9 handed on a 9-max set.
 *    Fewer players than seats is the `short-handed` approximation: the
 *    missing seats are the earliest ones, folded (`lookup.ts`). Heads-up
 *    (the button is the small blind and acts last after the flop) and ten
 *    or more players are refused (`players`).
 * 2. **Depth.** Among that table's sets, the one whose depth is nearest the
 *    effective stack (relative distance); further than `STACK_TOLERANCE`
 *    (20%) from every one is refused (`stack-depth`). Strategies are never
 *    interpolated between two depths: a mix of two solutions is a solution
 *    of neither. More than `STACK_NOTE_TOLERANCE` (5%) away is recorded as a
 *    `stack-depth` approximation with both depths.
 *
 * **The library is a chart set.** `ChartLibrary` extends `ChartSet`: its own
 * fields are its default set's (6-max 100bb), so code that reads one set's
 * nodes - reports, the chart browser - keeps working unchanged, while
 * `lookupPreflop` sees a library and answers from the set the spot needs.
 * A set that is not loaded yet is `unavailable`: callers load what their
 * hands need first (`requiredChartSets`, `ensureChartSets`).
 */

import { positionRing, type Position } from "../phf/types";
import { loadCharts, type ChartSet } from "./format";
import type { PreflopSpot } from "./lookup";

/** One committed set: its table, its depth, and how to load it. */
export interface ChartSetSpec {
  id: string;
  /** Seats of the set's table: 6 or 9. */
  players: number;
  stackBb: number;
  /**
   * A straddle set (`charts/5`, A2e): the straddle it models - by the first
   * seat left of the big blind (the set's `UTG`), `bb` big blinds. Such a set
   * answers only hands with that straddle, and they only it.
   */
  straddle?: { position: "UTG"; bb: number };
  /** The set's JSON (a dynamic import: one chunk per set). */
  load: () => Promise<unknown>;
}

/** The set a library's own fields describe, and the one with the most coverage. */
export const DEFAULT_CHART_SET = "nlhe-cash-6max-100bb";

/** Effective stack band a set covers around its depth; beyond it, the next set or a refusal. */
export const STACK_TOLERANCE = 0.2;
/** Stack depth further than this from the set's still grades, with a note. */
export const STACK_NOTE_TOLERANCE = 0.05;

// Literal paths, so the bundler sees every set and gives each its own chunk.
export const CHART_SETS: readonly ChartSetSpec[] = [
  { id: "nlhe-cash-6max-40bb", players: 6, stackBb: 40, load: () => import("./data/nlhe-cash-6max-40bb.json") },
  { id: "nlhe-cash-6max-60bb", players: 6, stackBb: 60, load: () => import("./data/nlhe-cash-6max-60bb.json") },
  { id: "nlhe-cash-6max-100bb", players: 6, stackBb: 100, load: () => import("./data/nlhe-cash-6max-100bb.json") },
  { id: "nlhe-cash-6max-150bb", players: 6, stackBb: 150, load: () => import("./data/nlhe-cash-6max-150bb.json") },
  { id: "nlhe-cash-6max-200bb", players: 6, stackBb: 200, load: () => import("./data/nlhe-cash-6max-200bb.json") },
  { id: "nlhe-cash-9max-100bb", players: 9, stackBb: 100, load: () => import("./data/nlhe-cash-9max-100bb.json") },
  { id: "nlhe-cash-9max-150bb", players: 9, stackBb: 150, load: () => import("./data/nlhe-cash-9max-150bb.json") },
  { id: "nlhe-cash-9max-200bb", players: 9, stackBb: 200, load: () => import("./data/nlhe-cash-9max-200bb.json") },
  {
    id: "nlhe-cash-6max-100bb-straddle",
    players: 6,
    stackBb: 100,
    straddle: { position: "UTG", bb: 2 },
    load: () => import("./data/nlhe-cash-6max-100bb-straddle.json"),
  },
];

/** Every set of the library, chosen per spot; usable wherever one `ChartSet` is (its own fields are the default set's). */
export interface ChartLibrary extends ChartSet {
  readonly library: true;
  readonly specs: readonly ChartSetSpec[];
  /** Sets loaded so far, by id. */
  readonly sets: ReadonlyMap<string, ChartSet>;
}

export function isChartLibrary(charts: ChartSet): charts is ChartLibrary {
  return (charts as Partial<ChartLibrary>).library === true;
}

/** The effective stack the lookup judges depth by: the hero against the deepest opponent still in. */
export function effectiveStackBb(spot: PreflopSpot, missing = 100): number {
  const stackOf = (p: Position) => spot.stacksBb?.[p] ?? missing;
  const folded = new Set(spot.actions.filter((a) => a.type === "fold").map((a) => a.position));
  const opponents = spot.positions.filter((p) => p !== spot.hero && !folded.has(p));
  const deepest = opponents.length ? Math.max(...opponents.map(stackOf)) : stackOf(spot.hero);
  return Math.min(stackOf(spot.hero), deepest);
}

export type ChartSetPick =
  | { ok: true; spec: ChartSetSpec; effectiveBb: number }
  | { ok: false; reason: "players" | "stack-depth" | "straddle"; detail: string };

const round2 = (x: number) => Math.round(x * 100) / 100;

/** A straddle's size matches a set's within this (relative): a 2bb straddle is 2bb. */
export const STRADDLE_SIZE_TOLERANCE = 0.01;

/**
 * Why a set that models `straddle` (or none, when null) cannot answer the
 * spot's straddle, or null when it can: a set without one answers only
 * unstraddled hands; a straddle set answers exactly one straddle, of its
 * size, posted by the first seat left of the big blind, at a table of 4 to
 * its seats (3-handed, that seat is the button).
 */
export function straddleMismatch(
  straddle: { position: string; bb: number } | null,
  seats: number,
  spot: PreflopSpot,
): string | null {
  if (!spot.straddle) return straddle ? "the set models a straddle; this hand has none" : null;
  if (!straddle) return "a straddle changes every price; this set has none";
  const k = spot.positions.length;
  const posted = spot.straddles ?? [];
  if (posted.length !== 1) {
    return posted.length > 1
      ? `${posted.length} straddles (a re-straddle); only a single ${straddle.bb}bb straddle from the first seat left of the big blind is charted`
      : "the straddle could not be read";
  }
  const [one] = posted;
  if (k < 4 || k > seats) {
    return `a straddle ${k}-handed; the straddle set covers 4 to ${seats} players`;
  }
  const ring = positionRing(k);
  if (one.position !== ring[2]) {
    return `${one.position} straddled; only a straddle from the first seat left of the big blind (${ring[2]}) is charted`;
  }
  if (Math.abs(one.toBb - straddle.bb) > STRADDLE_SIZE_TOLERANCE * straddle.bb) {
    return `a ${round2(one.toBb)}bb straddle; the straddle set models ${straddle.bb}bb`;
  }
  return null;
}

/** The set that answers a spot (see the header), or why none does. */
export function pickChartSet(specs: readonly ChartSetSpec[], spot: PreflopSpot): ChartSetPick {
  if (spot.straddle) {
    // Straddled hands are read on a straddle set or not at all (`straddle`).
    const straddled = specs.filter((s) => s.straddle);
    if (!straddled.length) return { ok: false, reason: "straddle", detail: "a straddle changes every price; no chart set models one" };
    const why = straddled.map((s) => straddleMismatch(s.straddle ?? null, s.players, spot));
    const fits = straddled.filter((_, i) => why[i] === null);
    if (!fits.length) return { ok: false, reason: "straddle", detail: why[0] ?? "" };
    const pick = pickByDepth(fits, spot);
    if (!pick.ok) {
      const depths = fits.map((s) => `${s.stackBb}bb`).join(" / ");
      return {
        ok: false,
        reason: "straddle",
        detail: `a straddle at ${round2(effectiveStackBb(spot))}bb effective; the straddle sets cover ${depths} ±${STACK_TOLERANCE * 100}%`,
      };
    }
    return pick;
  }
  return pickByDepth(
    specs.filter((s) => !s.straddle),
    spot,
  );
}

/** Among `specs` (one kind: with or without a straddle), the table and the depth. */
function pickByDepth(specs: readonly ChartSetSpec[], spot: PreflopSpot): ChartSetPick {
  const k = spot.positions.length;
  if (k < 3) {
    return { ok: false, reason: "players", detail: "heads-up: the small blind is the button; no chart set models it" };
  }
  const seats = specs.map((s) => s.players).filter((n) => n >= k);
  if (!seats.length) return { ok: false, reason: "players", detail: `${k} players dealt in; the largest chart set is ${Math.max(...specs.map((s) => s.players))}-max` };
  const table = Math.min(...seats);
  const effectiveBb = effectiveStackBb(spot);
  let best: ChartSetSpec | null = null;
  let bestDistance = Infinity;
  for (const spec of specs) {
    if (spec.players !== table) continue;
    const distance = Math.abs(effectiveBb - spec.stackBb) / spec.stackBb;
    if (distance < bestDistance - 1e-12) {
      best = spec;
      bestDistance = distance;
    }
  }
  if (!best || bestDistance > STACK_TOLERANCE + 1e-9) {
    const depths = specs.filter((s) => s.players === table).map((s) => s.stackBb).join(" / ");
    return {
      ok: false,
      reason: "stack-depth",
      detail: `effective stack ${round2(effectiveBb)}bb is more than ${STACK_TOLERANCE * 100}% from every ${table}-max set (${depths}bb)`,
    };
  }
  return { ok: true, spec: best, effectiveBb };
}

/** A library over `specs` with the given sets loaded; the first is its own fields (normally the default set). */
export function chartLibrary(loaded: readonly ChartSet[], specs: readonly ChartSetSpec[] = CHART_SETS): ChartLibrary {
  if (!loaded.length) throw new Error("a chart library needs at least its default set");
  const sets = new Map<string, ChartSet>();
  for (const set of loaded) sets.set(set.id, set);
  const own = loaded[0];
  return { ...own, library: true, specs, sets };
}

/** Loads one set by id. */
export async function loadChartSet(id: string, specs: readonly ChartSetSpec[] = CHART_SETS): Promise<ChartSet> {
  const spec = specs.find((s) => s.id === id);
  if (!spec) throw new Error(`no chart set ${id}`);
  const data = (await spec.load()) as { default?: unknown };
  return loadCharts(data.default ?? data);
}

/** Loads the sets with these ids into the library (those not loaded yet). */
export async function ensureChartSets(library: ChartLibrary, ids: Iterable<string>): Promise<void> {
  const sets = library.sets as Map<string, ChartSet>;
  const missing = [...new Set(ids)].filter((id) => !sets.has(id));
  const loaded = await Promise.all(missing.map((id) => loadChartSet(id, library.specs)));
  for (const set of loaded) sets.set(set.id, set);
}

/** A library with its default set loaded; other sets load on demand (`ensureChartSets`). */
export async function loadChartLibrary(specs: readonly ChartSetSpec[] = CHART_SETS): Promise<ChartLibrary> {
  return chartLibrary([await loadChartSet(DEFAULT_CHART_SET, specs)], specs);
}
