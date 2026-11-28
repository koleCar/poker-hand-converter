/**
 * The one pass (docs/POOL.md P1): a stored hand read once, on the server,
 * gives every product the web keeps of it, in the shapes the writers take:
 *
 * - the statistics rows (`handDerivation`: hero, and the opponents' when the
 *   account has them on), the builder facts and the hero's all-in EV row -
 *   what `/api/stats/rebuild` derived;
 * - the checker rows of an analysed hand (`analyticsRowsHand`, from its stored
 *   decisions) - what `backfillAnalyticsRows` derived in the browser;
 * - the opponents' part of the pool (`poolHand`) - what `backfillPool`
 *   counted in the browser.
 *
 * Pure: the drain (`drain.ts`) claims the hands, parses a text-only row and
 * saves what comes out. Every function here is the same one those paths
 * called, so a hand gives the rows it gave before, byte for byte.
 */

import type { PhfHand } from "../phf/types";
import { ANALYTICS_MEMBERSHIP_VERSION } from "../stats/analytics";
import { analyticsRows, type RowsDecisionIn } from "../stats/analyticsRows";
import { handDerivation, handEvRow, type HandEvInsert, type HandFactsInsert, type HandStatsInsert } from "../db/statsRows";
import { poolHand, type PoolSeat } from "../db/poolCounts";
import { handOfRow, type StoredHandRow } from "../db/storedHand";
import type { ParseText } from "../phf/storedText";

/** One hand as `analytics_rows_save` takes it. */
export interface AnalyticsRowsHand {
  hand_id: string;
  analysis_version: string;
  membership_version: string;
  rows: Array<{
    ord: number;
    stat: string;
    taken: boolean;
    ref_share: number | null;
    best_in: boolean | null;
    size: string;
    hand_class: string;
    spot: string;
    multiway: boolean;
  }>;
}

/** A hand's checker rows in the writer's shape. */
export function analyticsRowsHand(
  handId: string,
  analysisVersion: string,
  hand: PhfHand,
  decisions: readonly RowsDecisionIn[],
): AnalyticsRowsHand {
  return {
    hand_id: handId,
    analysis_version: analysisVersion,
    membership_version: ANALYTICS_MEMBERSHIP_VERSION,
    rows: analyticsRows(hand, decisions).map((row) => ({
      ord: row.ord,
      stat: row.stat,
      taken: row.taken,
      ref_share: row.refShare,
      best_in: row.bestIn,
      size: row.size,
      hand_class: row.handClass,
      spot: row.spot,
      multiway: row.multiway,
    })),
  };
}

/** A queued hand as `derive_claim` returns it. */
export interface ClaimedHand extends StoredHandRow {
  hand_id: string;
  owner_id: string;
  reason: string;
  /** The account's opponents' statistics are on (`derive_options`). */
  villains: boolean;
  /** Set when the hand is analysed at the claim's version and has no checker rows yet. */
  analysis_version: string | null;
  decisions: RowsDecisionIn[] | null;
}

/** Everything one hand gives, as `derive_save` takes it. */
export interface DerivedHand {
  hand_id: string;
  stats: HandStatsInsert[];
  ev: HandEvInsert[];
  facts: HandFactsInsert | null;
  checker: Omit<AnalyticsRowsHand, "hand_id"> | null;
  pool: { version: string; players: PoolSeat[] } | null;
}

/** A hand the pass could not work out, as `derive_fail` takes it. */
export interface FailedHand {
  hand_id: string;
  error: string;
  /** The hand cannot be read at all: no point trying again with this build. */
  final: boolean;
}

export interface PassOptions {
  includeVillains: boolean;
  /** The claim's analysis version and the hand's decisions, when it needs checker rows. */
  analysisVersion?: string | null;
  decisions?: readonly RowsDecisionIn[] | null;
}

/**
 * Every product of one parsed hand. A hand without a hero gives nothing but
 * an empty pool entry (it is counted, with no opponents, as before).
 *
 * The EV and the checker rows are best effort, as they were: the equity
 * engine refusing a hand must not cost its statistics, and the checker
 * failing leaves the hand for the next analysis.
 */
export function onePass(handId: string, hand: PhfHand, options: PassOptions): DerivedHand {
  const derivation = handDerivation(hand, { includeVillains: options.includeVillains });
  const hero = derivation.stats.find((row) => row.is_hero);
  let ev: HandEvInsert[] = [];
  if (hero) {
    try {
      ev = [handEvRow(hand, hero)];
    } catch {
      ev = [];
    }
  }
  let checker: DerivedHand["checker"] = null;
  if (options.analysisVersion && options.decisions) {
    try {
      const made = analyticsRowsHand(handId, options.analysisVersion, hand, options.decisions);
      checker = { analysis_version: made.analysis_version, membership_version: made.membership_version, rows: made.rows };
    } catch {
      checker = null;
    }
  }
  const pool = poolHand(handId, hand);
  return {
    hand_id: handId,
    stats: derivation.stats,
    ev,
    facts: derivation.facts,
    checker,
    pool: { version: ANALYTICS_MEMBERSHIP_VERSION, players: pool.players },
  };
}

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500) || "The hand could not be worked out.";

/**
 * A claimed page through the pass: each hand read from its stored document
 * (or parsed from its text with `parse`) and worked out. A hand that cannot
 * be read is a final failure; one whose derivation throws is tried again
 * later (a fix may be deployed by then).
 */
export async function passPage(
  page: readonly ClaimedHand[],
  parse: ParseText,
): Promise<{ derived: DerivedHand[]; failed: FailedHand[] }> {
  const derived: DerivedHand[] = [];
  const failed: FailedHand[] = [];
  for (const row of page) {
    let phf: PhfHand | null;
    try {
      phf = await handOfRow(row, parse);
    } catch (error) {
      failed.push({ hand_id: row.hand_id, error: messageOf(error), final: true });
      continue;
    }
    if (!phf) {
      failed.push({ hand_id: row.hand_id, error: "The stored hand could not be read.", final: true });
      continue;
    }
    try {
      derived.push(
        onePass(row.hand_id, phf, {
          includeVillains: row.villains,
          analysisVersion: row.analysis_version,
          decisions: row.decisions,
        }),
      );
    } catch (error) {
      failed.push({ hand_id: row.hand_id, error: messageOf(error), final: false });
    }
  }
  return { derived, failed };
}
