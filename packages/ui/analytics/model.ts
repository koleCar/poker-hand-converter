/**
 * The Analytics stat checker's data, as both surfaces hand it over
 * (docs/ANALYTICS.md Step 2). The web reads it from `analytics_checker` /
 * `analytics_checker_examples` (`web/src/lib/db/analyticsRows.ts`), the
 * desktop app from the async Tauri commands of the same names
 * (`app/src-tauri/src/analytics.rs`, over `rail_store::checker`): the same
 * shapes, the same sums over the same decisions (the fixture in
 * `core/rail-stats/tests/data/analytics/rows/`).
 *
 * The sums are per (stat, spot, size bucket, hand class), over the
 * analysed decisions of the catalogue's rates (`config/stats/analytics.json`):
 *
 * - `opps` / `oppsTaken`: every member decision with a stored row, and those
 *   that took the stat's action class;
 * - `n` / `taken`: of them, the analysed ones (the reference had options) -
 *   the player's number and the target come from these;
 * - `refShare`: Σ of the reference's share of the class over the `n`
 *   (target = refShare / n);
 * - `evHigh`: Σ EV loss (bb) of the `n` that took the class ("too much");
 *   `evLow`: of the `n` that did not although the reference's best option is
 *   in the class ("too little");
 * - `hands`: distinct hands in the group.
 */

import type { HandFilter } from "../hands/model";

/** The filters the checker reads: the analysis readers' (`analysis_filter_of`) plus a pot kind. */
export interface CheckerFilters {
  analysisVersion?: string;
  /** Default `analytics/1` (`ANALYTICS_MEMBERSHIP_VERSION`). */
  membershipVersion?: string;
  /** ISO times, `from` inclusive, `to` exclusive. */
  from?: string;
  to?: string;
  site?: string;
  gameFormat?: string;
  gameKind?: string;
  currency?: string;
  bigBlind?: number;
  position?: string;
  potType?: string;
  /** `hu`, `mw` (by the decision's scenario) or `bomb`. */
  potKind?: "hu" | "mw" | "bomb";
  /**
   * The hero's effective stack at its first preflop action: ids of the
   * stack buckets (docs/ANALYTICS.md Step 11). The desktop's store reads it
   * (`hand_list.eff_stack_tenths`); the web reads it from `hands`.
   */
  effStacks?: string[];
  /**
   * The web's only: the Hands list's filter (`library_where`'s shape), for
   * the groups the keys above cannot say (`analysis_hand_ids`).
   */
  hands?: Record<string, unknown>;
}

export interface CheckerGroup {
  stat: string;
  /** `pot|role|hero|opponent` ({@link parseSpot}). */
  spot: string;
  /** A catalogue size bucket id; '' preflop or with no bet faced. */
  size: string;
  /** A catalogue hand class id; '' preflop. */
  handClass: string;
  opps: number;
  oppsTaken: number;
  n: number;
  taken: number;
  refShare: number;
  evHigh: number;
  evLow: number;
  hands: number;
}

export interface CheckerSums {
  analysisVersion: string;
  membershipVersion: string;
  /** Hands in scope with stored rows: the bb/100 cost's denominator. */
  hands: number;
  /** Hands analysed at the version still without rows (the backfill's work). */
  pending: number;
  /** Ordered by (stat, spot, size, handClass), byte order. */
  groups: CheckerGroup[];
}

/** Which decisions an example list shows. */
export type CheckerSide = "high" | "low" | "any";

/** One decision behind a group, the costliest first. */
export interface CheckerExample {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  site: string;
  stat: string;
  spot: string;
  size: string;
  handClass: string;
  taken: boolean;
  bestIn: boolean;
  refShare: number;
  evLossBb: number;
  /** The bet faced, a fraction of the pot; null with none. */
  facingPot: number | null;
  cards: string[];
  board: string[];
}

export interface CheckerExampleQuery {
  stat: string;
  spot?: string | null;
  size?: string | null;
  handClass?: string | null;
  /** Default `high`. */
  side?: CheckerSide;
  /** 1..100, default 20. */
  limit?: number;
}

/** What each surface implements over its own data layer. */
export interface CheckerSource {
  checker(filters: CheckerFilters): Promise<CheckerSums | null>;
  examples(filters: CheckerFilters, query: CheckerExampleQuery): Promise<CheckerExample[]>;
}

/**
 * What the Analytics screen asks a surface for (Step 4): the checker's sums
 * over the screen's filter. Each surface maps the filter onto its own
 * `CheckerFilters` (`checkerFiltersOf` in `view.ts`, the web adding the
 * Hands list's filter) and says when it had to leave groups out.
 */
export interface AnalyticsChecker {
  sums(query: HandFilter): Promise<CheckerSums | null>;
  /** The filter sets groups the checker does not follow (they are left out). */
  partial(query: HandFilter): boolean;
  /**
   * The drill-down's hands (Step 8): the decisions behind a stat's spot,
   * size or class over the same filter, the costliest first. Absent: the
   * drill-down shows no hands.
   */
  examples?(query: HandFilter, example: CheckerExampleQuery): Promise<CheckerExample[]>;
  // No backfill: every surface fills the rows itself, away from the screen
  // (the desktop's background pass; the web's server, docs/POOL.md P1).
}

/* --------------------------------------------------------------- Pool -- */

/**
 * The Pool tab's data (docs/ANALYTICS.md Step 10): the web reads it from
 * `analytics_pool` (`web/src/lib/db/analyticsPool.ts`), the desktop from the
 * async Tauri command of the same name (`rail_store::pool`). Opponents are
 * typed by Rail's rule (the Hands filter's "vs type": 30+ hands; fish VPIP ≥
 * 40; reg VPIP 15–30 and PFR ≥ 0.6·VPIP) over every hand of theirs; their
 * results and rates count the hands they played with the hero.
 */
export type PoolType = "reg" | "fish";

/**
 * What the pool is read over. The desktop reads the kind or one format and
 * the rooms (`rail_store::pool`; its field split is docs/POOL.md P6). The
 * web reads fields (P2): every group below narrows it, each "any" when
 * absent, with the Hands filter's values.
 */
export interface PoolFilters {
  gameFormat?: string;
  gameKind?: string;
  sites?: string[];
  /** The formats chosen (`cash`, `tournament`, ...); the web prefers it to `gameFormat` / `gameKind`. */
  formats?: string[];
  variants?: string[];
  limits?: string[];
  /** `hu`, `6max`, `full`. */
  sizes?: string[];
  /** `USD:50`, `chips`. */
  stakes?: string[];
}

/** One player type's results. */
export interface PoolTypeSums {
  players: number;
  /** Their seat rows in hands with the hero. */
  hands: number;
  /** Σ result and Σ result², big blinds. */
  netBb: number;
  netBbSq: number;
}

/** One catalogue rate's counts for one type. */
export interface PoolStatSums {
  stat: string;
  type: PoolType;
  made: number;
  opp: number;
}

export interface PoolSums {
  /** The catalogue version the rates were counted at (`analytics/1`). */
  version: string;
  /** Hands not counted for the pool yet (the web: its hands still being processed). */
  pending: number;
  reg: PoolTypeSums;
  fish: PoolTypeSums;
  stats: PoolStatSums[];
}

/** The player's hands and result over one side of the "vs type" split. */
export interface PoolYouSums {
  hands: number;
  /** Hands whose money counts (an EV cashout's does not, unless the filter takes them in). */
  moneyHands: number;
  /** Σ result in milli big blinds; null when chips and cash mix. */
  netBbMilli: number | null;
}

/**
 * The player's results with a fish in the pot, and with regs and no fish
 * (the Pool tab's two "You" figures, over the screen's whole filter).
 */
export interface PoolYou {
  fish: PoolYouSums;
  regsOnly: PoolYouSums;
}

/**
 * What the Analytics screen asks a surface for on the Pool tab. The surface
 * counts the pool itself, away from the screen (the desktop's background
 * pass; the web's server, docs/POOL.md P1).
 */
export interface AnalyticsPool {
  sums(query: HandFilter): Promise<PoolSums | null>;
  /**
   * The two "You" figures, precomputed by the surface (the web: each hero
   * hand tagged by its opponents' types, docs/POOL.md P3). Without it the
   * screen runs two reports over the Hands filter's "vs type" (the desktop).
   */
  you?(query: HandFilter): Promise<PoolYou | null>;
}
