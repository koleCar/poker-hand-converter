/**
 * The chart library (`charts/11`): every committed chart set, which one
 * answers a spot, and loading them one at a time.
 *
 * **Sets.** One JSON file per table, stack depth and kind (`data/<id>.json`,
 * see docs/CHARTS.md §6), each a GTO Wizard preflop solution transcribed by
 * `tests/scripts/preflop-charts/gtow.test.ts` - Rail's own generated sets are
 * gone. `CHART_SETS` lists the sets transcribed so far with their table,
 * depth and kind (classic, ante, straddle); a set not captured yet is simply
 * not in it, so a hand that would need it gets no chart. Adding one is its
 * JSON file plus its line here. The manifest is a few hundred bytes; each set
 * is its own dynamic import, so a bundler splits every set into its own chunk
 * and a page (or the analysis worker) downloads only the sets its hands need.
 *
 * **Which set** (`pickChartSet`):
 *
 * 0. **Kind.** A straddled hand reads a straddle set, a hand where every
 *    seat posts the same ante reads an ante set of that ante, any other hand
 *    a classic set (no straddle, no ante) - never a set of another kind. A
 *    hand with an ante no set models (a big-blind ante, uneven antes, another
 *    size) is refused (`ante`), as an unmodelled straddle is (`straddle`).
 * 1. **Table.** `k` players dealt in are read on the smallest set with at
 *    least `k` seats: 3-6 handed on a 6-max set, 7-9 handed on a 9-max set.
 *    Fewer players than seats is the `short-handed` approximation: the
 *    missing seats are the earliest ones, folded (`lookup.ts`). Heads-up
 *    (the button is the small blind and acts last after the flop) is read
 *    only on a heads-up set - never on a bigger table with its seats folded,
 *    whose blinds play the other way round after the flop - and a heads-up
 *    set answers nothing else. More players than the largest set's seats
 *    are refused (`players`).
 * 2. **Depth.** Among that table's sets, the one whose depth is nearest the
 *    effective stack (relative distance); further than `STACK_TOLERANCE`
 *    (20%) from every one is refused (`stack-depth`). Strategies are never
 *    interpolated between two depths: a mix of two solutions is a solution
 *    of neither. More than `STACK_NOTE_TOLERANCE` (5%) away is recorded as a
 *    `stack-depth` approximation with both depths.
 *
 * **The library is a chart set.** `ChartLibrary` extends `ChartSet`: its own
 * fields are its default set's (`DEFAULT_CHART_SET`), so code that reads one set's
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
  /** Seats of the set's table: 2 (heads-up), 6 or 9. */
  players: number;
  stackBb: number;
  /**
   * A straddle set (`charts/5`, A2e): the straddle it models - by the first
   * seat left of the big blind (the set's `UTG`), `bb` big blinds. Such a set
   * answers only hands with that straddle, and they only it.
   */
  straddle?: { position: "UTG"; bb: number };
  /**
   * An ante set: every seat posts this many big blinds before the deal (the
   * set's `game.ante`). Such a set answers only hands where every seat posts
   * that ante, and they only it (`anteMismatch`). `stackBb` is the depth
   * before the ante, as the hands' starting stacks are.
   */
  ante?: number;
  /** The set's JSON (a dynamic import: one chunk per set). */
  load: () => Promise<unknown>;
}

/** Effective stack band a set covers around its depth; beyond it, the next set or a refusal. */
export const STACK_TOLERANCE = 0.2;
/** Stack depth further than this from the set's still grades, with a note. */
export const STACK_NOTE_TOLERANCE = 0.05;

// Literal paths, so the bundler sees every set and gives each its own chunk.
// Only sets transcribed from GTO Wizard (`gtow.test.ts`, whose `SETS` lists
// every set Rail is to ship); one line per set captured so far.
export const CHART_SETS: readonly ChartSetSpec[] = [
  { id: "nlhe-cash-6max-100bb", players: 6, stackBb: 100, load: () => import("./data/nlhe-cash-6max-100bb.json") },
  { id: "nlhe-cash-6max-100bb-ante", players: 6, stackBb: 100, ante: 0.166, load: () => import("./data/nlhe-cash-6max-100bb-ante.json") },
];

/**
 * Every set Rail is to ship, by id (the owner's list, 2026-11-13): 6-max
 * classic and ante at 40-200bb, heads-up at 100 and 150bb, 9-max classic at
 * 100-200bb, 9-max ante at 60-200bb, and the 6-max straddle (GTO Wizard's
 * "Straddle + Ante"). `CHART_SETS` is the part transcribed so far; the
 * converter's `SETS` (`tests/scripts/preflop-charts/gtow.test.ts`) has a row
 * for each. Pages may name these ids before their data comes (a lesson's
 * table, a stored grade); nothing loads one that `CHART_SETS` lacks.
 */
export const PLANNED_CHART_SETS: readonly string[] = [
  ...[40, 60, 100, 150, 200].map((bb) => `nlhe-cash-6max-${bb}bb`),
  ...[40, 60, 100, 150, 200].map((bb) => `nlhe-cash-6max-${bb}bb-ante`),
  ...[100, 150].map((bb) => `nlhe-cash-hu-${bb}bb`),
  ...[100, 150, 200].map((bb) => `nlhe-cash-9max-${bb}bb`),
  ...[60, 100, 150, 200].map((bb) => `nlhe-cash-9max-${bb}bb-ante`),
  "nlhe-cash-6max-100bb-straddle",
];

/** The set the library prefers as its own fields and the pages open on: 6-max 100bb, classic. */
export const PREFERRED_CHART_SET = "nlhe-cash-6max-100bb";

/**
 * The set a library's own fields describe and the pages open on: the
 * preferred one (6-max 100bb) once it is transcribed, until then the first
 * set `CHART_SETS` lists.
 */
export const DEFAULT_CHART_SET: string = CHART_SETS.some((s) => s.id === PREFERRED_CHART_SET) ? PREFERRED_CHART_SET : CHART_SETS[0].id;

/** What kind of game a set models: no blind but the two, a straddle, or an ante from every seat. */
export type ChartSetKind = "classic" | "straddle" | "ante";

export function chartSetKind(spec: Pick<ChartSetSpec, "straddle" | "ante">): ChartSetKind {
  // A straddle set may carry an ante too (GTO Wizard's 6-max "Straddle + Ante"): it is a straddle set.
  return spec.straddle ? "straddle" : spec.ante ? "ante" : "classic";
}

/** The sets of a kind (classic: neither a straddle nor an ante). */
export function setsOfKind(specs: readonly ChartSetSpec[], kind: ChartSetKind): ChartSetSpec[] {
  return specs.filter((spec) => chartSetKind(spec) === kind);
}

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
  | { ok: false; reason: "players" | "stack-depth" | "straddle" | "ante"; detail: string };

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

/**
 * An ante's size matches a set's within this (relative): the 1/6 bb ante
 * GTO Wizard solves (0.166) answers antes of 0.125-0.21 bb - a site's
 * $0.16 ante at $1 and $0.36 at $2 alike. Dead money that close moves no
 * preflop decision a grade can see; a different structure (a big-blind
 * ante, an ante of a third of a blind) is another game.
 */
export const ANTE_SIZE_TOLERANCE = 0.25;

/**
 * Why a set that models `ante` (every seat's, bb; or none, when null)
 * cannot answer the spot's ante, or null when it can: a set without one
 * answers only hands without antes; an ante set answers only hands where
 * every seat posted its ante (`PreflopSpot.anteBb`), within
 * `ANTE_SIZE_TOLERANCE`.
 */
export function anteMismatch(ante: number | null, spot: PreflopSpot): string | null {
  if (!spot.ante) return ante ? "the set models an ante; this hand has none" : null;
  if (!ante) return "an ante changes every price; this set has none";
  if (spot.anteBb === undefined) return `only an ante from every seat is charted (${round2(ante)}bb each); this hand's is a big-blind ante or uneven`;
  if (Math.abs(spot.anteBb - ante) > ANTE_SIZE_TOLERANCE * ante + 1e-9) {
    return `a ${round2(spot.anteBb)}bb ante; the ante set models ${round2(ante)}bb`;
  }
  return null;
}

/** The set that answers a spot (see the header), or why none does. */
export function pickChartSet(specs: readonly ChartSetSpec[], spot: PreflopSpot): ChartSetPick {
  if (spot.straddle) {
    // Straddled hands are read on a straddle set or not at all (`straddle`),
    // with or without an ante of their own: the 6-max straddle set is GTO
    // Wizard's "Straddle + Ante", read for both (the owner's call, 2026-11-13).
    const straddled = setsOfKind(specs, "straddle");
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
  if (spot.ante) {
    // A hand with antes is read on an ante set of its ante or not at all (`ante`).
    const anted = setsOfKind(specs, "ante");
    if (!anted.length) return { ok: false, reason: "ante", detail: "an ante changes every price; no chart set models one yet" };
    const why = anted.map((s) => anteMismatch(s.ante ?? null, spot));
    const fits = anted.filter((_, i) => why[i] === null);
    if (!fits.length) return { ok: false, reason: "ante", detail: why[0] ?? "" };
    const pick = pickByDepth(fits, spot);
    if (!pick.ok && pick.reason === "stack-depth") {
      return { ok: false, reason: "stack-depth", detail: `${pick.detail} (ante sets)` };
    }
    return pick;
  }
  return pickByDepth(setsOfKind(specs, "classic"), spot);
}

/** Among `specs` (one kind: classic, straddle or ante), the table and the depth. */
function pickByDepth(specs: readonly ChartSetSpec[], spot: PreflopSpot): ChartSetPick {
  const k = spot.positions.length;
  if (k < 2) return { ok: false, reason: "players", detail: `${k} players dealt in` };
  // Heads-up reads only a heads-up set, and a heads-up set only heads-up (see the header).
  const seats = specs.map((s) => s.players).filter((n) => (k === 2 ? n === 2 : n >= k && n > 2));
  if (k === 2 && !seats.length) {
    return { ok: false, reason: "players", detail: "heads-up: the small blind is the button; no chart set models it" };
  }
  if (!seats.length) {
    return {
      ok: false,
      reason: "players",
      detail: specs.some((s) => s.players > 2)
        ? `${k} players dealt in; the largest chart set is ${Math.max(...specs.map((s) => s.players))}-max`
        : `${k} players dealt in; no chart set models that table`,
    };
  }
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
      detail: `effective stack ${round2(effectiveBb)}bb is more than ${STACK_TOLERANCE * 100}% from every ${table === 2 ? "heads-up" : `${table}-max`} set (${depths}bb)`,
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
  const own = specs.some((s) => s.id === DEFAULT_CHART_SET) ? DEFAULT_CHART_SET : specs[0]?.id;
  if (!own) throw new Error("a chart library needs at least one set");
  return chartLibrary([await loadChartSet(own, specs)], specs);
}
