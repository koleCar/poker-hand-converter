/**
 * Rail's own preflop sets, draft (`charts/12-draft`, docs/PREFLOP-PLAN.md §2):
 * the 11 sets the owner approved on 2026-11-19, as tree specs for Rail's
 * DCFR generator, and the depth-band rule that will pick one for a hand.
 *
 * **Nothing here ships.** The app and the web read the transcribed GTO
 * Wizard sets (`registry.ts`, `CHART_SETS`) until plan phase P5 replaces
 * them; no code outside the tests and the v0 runner
 * (`tests/scripts/preflop-v0/`) imports this file. The ids start with
 * `rail-`, so they can never name a transcribed set (`nlhe-cash-…`).
 *
 * **Fixed per format, not choices** (§2.1): one online rake for every set
 * (5% capped at 3bb, no flop no drop: `STANDARD_RAKE`); opens 2.5bb, the
 * small blind 3bb (heads-up, where it is the button, 2.5bb); 3-bets 3x in
 * position / 4x out of position (+1x per caller); 4-bets 2.2x in position /
 * 2.5x out of position; the 5-bet, and any raise past 40% of the stack,
 * all-in. Limps only where a solver keeps them: the small blind's completion
 * (and heads-up, the button's limp) - no open limps (`maxLimpers` 0). Cold
 * calls of an open are kept; cold calls of a 3-bet are cut, as in every Rail
 * tree (docs/CHARTS.md §1.2). The straddle set's sizes are the same
 * multiples of its 2bb straddle (`charts/5`'s: open 5bb, a blind's raise
 * first in 6bb).
 *
 * **Picking a set** (`pickRailSet`, for P5; not wired in): kind first (a
 * straddled hand reads the straddle set, an anted hand an ante set, any other
 * a classic set - never across), then the table (2 players heads-up, 3-6 on
 * a 6-max set, 7-9 on a 9-max set), then the depth band that holds the
 * effective stack (§2.2): each table's bands tile every depth, so within a
 * kind and table a hand always gets a set; there is no nearest-depth
 * tolerance and no refusal by depth.
 */

import { STANDARD_RAKE, type RakeProfile } from "../solver/preflopModel";
import {
  DEFAULT_SIZING,
  NINE_MAX,
  SIX_MAX,
  type PreflopPosition,
  type PreflopSizing,
  type PreflopStraddle,
} from "../solver/preflopTree";

/** The chart version Rail's own sets will carry until they are frozen (P5 makes it `charts/12`). */
export const RAIL_CHARTS_DRAFT_VERSION = "charts/12-draft";

/** What kind of game a set models (as `registry.ts`'s `ChartSetKind`). */
export type RailSetKind = "classic" | "ante" | "straddle";

/**
 * Effective stacks a set answers, in bb: `minBb` inclusive, `maxBb`
 * exclusive; null is open-ended.
 */
export interface RailDepthBand {
  minBb: number | null;
  maxBb: number | null;
}

export interface RailSetSpec {
  /** `rail-<hu|6max|9max>-<depth>bb[-ante|-straddle]`. */
  id: string;
  version: typeof RAIL_CHARTS_DRAFT_VERSION;
  kind: RailSetKind;
  /** Seats of the table: 2 (heads-up), 6 or 9. */
  table: 2 | 6 | 9;
  /** The seats in table order (`buildPreflopTree`'s `players`). */
  seats: readonly PreflopPosition[];
  /** The stack every seat has behind (once an ante is in), bb. */
  stackBb: number;
  /** Every seat's ante, bb; 0 without. */
  ante: number;
  straddle: Readonly<PreflopStraddle> | null;
  /** The small blind is the button and acts last after the flop. */
  headsUp: boolean;
  /** Every size, in full. */
  sizing: Readonly<PreflopSizing>;
  rake: Readonly<RakeProfile>;
  /** 0: only the small blind limps (completes). */
  maxLimpers: 0;
  /** Most players who may put money in voluntarily. */
  maxEntrants: number;
  band: Readonly<RailDepthBand>;
}

/** A raise that would put more than this share of the stack in is all-in (as every `charts/3`+ set). */
export const RAIL_ALL_IN_ABOVE = 0.4;
/** The ante of the ante sets, bb from every seat: the 1/6 bb the transcribed ante sets model. */
export const RAIL_ANTE_BB = 0.166;

const STANDARD_SIZING: Readonly<PreflopSizing> = { ...DEFAULT_SIZING, allInAbove: RAIL_ALL_IN_ABOVE };
/** Heads-up: the button (small blind) opens 2.5bb; the big blind is always out of position, so no iso extra. */
const HEADS_UP_SIZING: Readonly<PreflopSizing> = { ...STANDARD_SIZING, sbOpen: 2.5, isoOop: 0 };
/** A 2bb straddle: every size the big blind sets, doubled (`charts/5`). */
const STRADDLE_SIZING: Readonly<PreflopSizing> = {
  ...STANDARD_SIZING,
  open: 5,
  sbOpen: 6,
  isoVsLimp: 8,
  isoPerLimper: 2,
  isoOop: 2,
};

const ALL: RailDepthBand = { minBb: null, maxBb: null };

function spec(
  table: 2 | 6 | 9,
  stackBb: number,
  band: RailDepthBand,
  kind: RailSetKind = "classic",
): RailSetSpec {
  const name = table === 2 ? "hu" : `${table}max`;
  return {
    id: `rail-${name}-${stackBb}bb${kind === "classic" ? "" : `-${kind}`}`,
    version: RAIL_CHARTS_DRAFT_VERSION,
    kind,
    table,
    seats: table === 2 ? ["SB", "BB"] : table === 6 ? SIX_MAX : NINE_MAX,
    stackBb,
    ante: kind === "ante" ? RAIL_ANTE_BB : 0,
    straddle: kind === "straddle" ? { position: "UTG", bb: 2 } : null,
    headsUp: table === 2,
    sizing: table === 2 ? HEADS_UP_SIZING : kind === "straddle" ? STRADDLE_SIZING : STANDARD_SIZING,
    rake: STANDARD_RAKE,
    maxLimpers: 0,
    maxEntrants: 4,
    band,
  };
}

/** The 11 approved sets (docs/PREFLOP-PLAN.md §2.2), in the plan's order. */
export const RAIL_SETS: readonly RailSetSpec[] = [
  spec(2, 100, { minBb: null, maxBb: 125 }),
  spec(2, 150, { minBb: 125, maxBb: null }),
  spec(6, 50, { minBb: null, maxBb: 75 }),
  spec(6, 100, { minBb: 75, maxBb: 125 }),
  spec(6, 150, { minBb: 125, maxBb: 175 }),
  spec(6, 200, { minBb: 175, maxBb: null }),
  spec(6, 100, ALL, "ante"),
  spec(9, 100, { minBb: null, maxBb: 125 }),
  spec(9, 150, { minBb: 125, maxBb: null }),
  spec(9, 100, ALL, "ante"),
  spec(6, 100, ALL, "straddle"),
];

export function railSet(id: string): RailSetSpec {
  const found = RAIL_SETS.find((s) => s.id === id);
  if (!found) throw new Error(`no Rail set ${id}; known: ${RAIL_SETS.map((s) => s.id).join(", ")}`);
  return found;
}

/** Whether `bb` lies in the band (`minBb` inclusive, `maxBb` exclusive). */
export function inBand(band: Readonly<RailDepthBand>, bb: number): boolean {
  return (band.minBb === null || bb >= band.minBb) && (band.maxBb === null || bb < band.maxBb);
}

/** The table a hand with `players` dealt in is read on: 2 heads-up, 3-6 on 6-max, 7-9 on 9-max; null beyond. */
export function railTableFor(players: number): 2 | 6 | 9 | null {
  if (!Number.isInteger(players) || players < 2 || players > 9) return null;
  return players === 2 ? 2 : players <= 6 ? 6 : 9;
}

/** What `pickRailSet` needs of a hand: its kind, the players dealt in, the effective stack (bb). */
export interface RailSpot {
  kind: RailSetKind;
  players: number;
  effectiveBb: number;
}

export type RailSetPick =
  | { ok: true; spec: RailSetSpec }
  | { ok: false; reason: "players" | "stack-depth" | "ante" | "straddle"; detail: string };

/**
 * The set that answers a hand (see the header), or why none does: a table
 * no set models (`players`), a kind with no set at that table (`ante`,
 * `straddle`), a stack that is not a positive number (`stack-depth`).
 * Whether a hand's straddle or ante is the one a set models (seat, size) is
 * `registry.ts`'s `straddleMismatch` / `anteMismatch`, checked before this.
 */
export function pickRailSet(spot: RailSpot, specs: readonly RailSetSpec[] = RAIL_SETS): RailSetPick {
  const table = railTableFor(spot.players);
  if (table === null) {
    return { ok: false, reason: "players", detail: `${spot.players} players dealt in; Rail's sets are heads-up, 6-max and 9-max` };
  }
  if (!(spot.effectiveBb > 0) || !Number.isFinite(spot.effectiveBb)) {
    return { ok: false, reason: "stack-depth", detail: `effective stack ${spot.effectiveBb}bb` };
  }
  const tableName = table === 2 ? "heads-up" : `${table}-max`;
  const ofKind = specs.filter((s) => s.kind === spot.kind && s.table === table);
  if (!ofKind.length) {
    const reason = spot.kind === "classic" ? "players" : spot.kind;
    return { ok: false, reason, detail: `no ${spot.kind} set ${tableName}` };
  }
  const hit = ofKind.find((s) => inBand(s.band, spot.effectiveBb));
  if (!hit) {
    return { ok: false, reason: "stack-depth", detail: `effective stack ${spot.effectiveBb}bb is in no ${tableName} ${spot.kind} band` };
  }
  return { ok: true, spec: hit };
}
