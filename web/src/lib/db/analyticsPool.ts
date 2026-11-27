/**
 * The Pool tab on the web (docs/ANALYTICS.md Step 10): each named opponent's
 * catalogue rates and results, counted on the server when a hand arrives
 * (docs/POOL.md P1: the one pass, `lib/derive/onePass.ts`, with
 * `lib/db/poolCounts.ts`'s counts, written by `derive_save`) and summed by
 * type by `analytics_pool` (`20271122100000_analytics_pool.sql`).
 *
 * - **Reads**: {@link webPool} (`AnalyticsPool` of `@rail/ui`): the tab's
 *   sums over the screen's filter (the kind or format and the rooms; the
 *   types read from `player_stats` at this build's statistics version), and
 *   `pending`: the caller's hands still being processed (a counter).
 *   No `backfill`: the browser no longer counts.
 */
import type { HandFilter } from "@rail/ui/hands/model";
import type { AnalyticsPool, PoolFilters, PoolStatSums, PoolSums, PoolTypeSums } from "@rail/ui/analytics/model";
import { poolFiltersOf } from "@rail/ui/analytics/poolView";

import { ANALYTICS_MEMBERSHIP_VERSION } from "../stats/analytics";
import { STATS_VERSION } from "../stats/types";
import { rpc } from "./client";

/* ---------------------------------------------------------------- reads - */

type Row = Record<string, unknown>;
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

function typeOf(value: unknown): PoolTypeSums {
  const row = (value && typeof value === "object" ? value : {}) as Row;
  return { players: num(row.players), hands: num(row.hands), netBb: num(row.netBb), netBbSq: num(row.netBbSq) };
}

function statOf(row: Row): PoolStatSums {
  return { stat: String(row.stat ?? ""), type: row.type === "fish" ? "fish" : "reg", made: num(row.made), opp: num(row.opp) };
}

/** The Pool tab's sums (`analytics_pool`). */
export async function fetchPool(filters: PoolFilters = {}): Promise<PoolSums | null> {
  const data = await rpc<Row | null>("analytics_pool", {
    p_filters: { membershipVersion: ANALYTICS_MEMBERSHIP_VERSION, statsVersion: STATS_VERSION, ...filters },
  });
  if (!data) return null;
  return {
    version: String(data.version ?? ANALYTICS_MEMBERSHIP_VERSION),
    pending: num(data.pending),
    reg: typeOf(data.reg),
    fish: typeOf(data.fish),
    stats: (Array.isArray(data.stats) ? (data.stats as Row[]) : []).map(statOf),
  };
}

/** The web's `AnalyticsPool`. */
export const webPool: AnalyticsPool = {
  sums: (query: HandFilter) => fetchPool(poolFiltersOf(query)),
};
