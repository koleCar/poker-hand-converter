/**
 * Statistics rows in the shape `save_hand_stats` takes them.
 *
 * Split out of `stats.ts` so the server can use it: that module imports the
 * browser client, and `app/api/stats/rebuild/route.ts` must not. Everything in
 * here is pure -- `lib/stats` for the derivation, `detectAnonymization` for the
 * one property of a room that `lib/stats` has no business knowing.
 */

import { handFacts, statsRows, type StatsRow } from "../stats";
import type { PhfHand } from "../phf/types";
import { detectAnonymization } from "./anonymization";
import type { SiteAnonymization } from "./types";

/* ------------------------------------------------------------- the wire - */

/**
 * One row as `save_hand_stats` takes it.
 *
 * Almost exactly a `StatsRow`: the two differences are `hand_id`, which in a
 * derived row is the *site's* hand id and in the table is the `hands.id` uuid
 * the server resolves, and `site_anonymization`, which is a property of how the
 * room publishes names rather than of the hand's play and therefore is not
 * something `lib/stats` has any business knowing about.
 */
export type HandStatsInsert = Omit<StatsRow, "hand_id"> & {
  site_hand_id: string;
  site_anonymization: SiteAnonymization;
};

/**
 * Whether villain rows are written.
 *
 * The schema has carried a row per dealt-in seat since the first migration, on
 * purpose: hero-only would be a one-way door on opponent statistics, and a
 * table that cannot grow into a HUD would have to be rewritten to get one. But
 * per-player multiplies the row count by about six, and at 500k hands that is
 * ~3M rows, which does not fit the free tier. So the schema is ready and the
 * writer is not — turning villains on is this flag, not a migration.
 *
 * Read through a `try` because Safari in private browsing throws on
 * `localStorage`, and a storage quirk must not be able to stop a save.
 */
const VILLAIN_ROWS_KEY = "pokerconverter.statsVillains";

export function villainRowsEnabled(): boolean {
  try {
    return localStorage.getItem(VILLAIN_ROWS_KEY) === "on";
  } catch {
    return false;
  }
}

/** Flips the setting. Returns whether it stuck (private mode can refuse). */
export function setVillainRowsEnabled(on: boolean): boolean {
  try {
    if (on) {
      localStorage.setItem(VILLAIN_ROWS_KEY, "on");
    } else {
      localStorage.removeItem(VILLAIN_ROWS_KEY);
    }
    return villainRowsEnabled() === on;
  } catch {
    return false;
  }
}

export interface DeriveOptions {
  /** Defaults to {@link villainRowsEnabled}. */
  includeVillains?: boolean;
}

/**
 * Derives the rows for one hand, in the shape the writer sends.
 *
 * **Villain rows are never emitted for a positionally anonymised room.** An
 * Ignition "UTG+1" is a different human every hand, so a per-player row keyed on
 * that name would quietly average strangers together and look exactly like a
 * real opponent report while doing it. That rule is enforced here *and* by
 * `hand_stats_positional_anonymity` in the migration: this is the copy that
 * keeps a batch from being rejected, the constraint is the copy that makes the
 * mistake impossible.
 */
export function handStatsRows(hand: PhfHand, options: DeriveOptions = {}): HandStatsInsert[] {
  const anonymization = detectAnonymization(hand);
  const villains =
    (options.includeVillains ?? villainRowsEnabled()) && anonymization !== "positional";

  return statsRows(handFacts(hand))
    .filter((row) => row.is_hero || villains)
    .map(({ hand_id: siteHandId, ...row }) => ({
      ...row,
      site_hand_id: siteHandId,
      site_anonymization: anonymization,
    }));
}
