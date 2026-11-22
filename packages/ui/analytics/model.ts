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
