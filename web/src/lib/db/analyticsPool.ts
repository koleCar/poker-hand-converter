/**
 * The Pool tab on the web (docs/ANALYTICS.md Step 10): each named opponent's
 * catalogue rates and results, counted on the server when a hand arrives
 * (docs/POOL.md P1: the one pass, `lib/derive/onePass.ts`, with
 * `lib/db/poolCounts.ts`'s counts, written by `derive_save`) and summed by
 * type by `analytics_pool` (`20271122100000_analytics_pool.sql`).
 *
 * - **Reads**: {@link webPool} (`AnalyticsPool` of `@rail/ui`): the tab's
 *   sums over the fields the screen's filter names (docs/POOL.md P2: rooms,
 *   formats, games, limits, table sizes and stakes - `hands.field_key`; the
 *   types read from `player_stats` at this build's statistics version), and
 *   `pending`: the caller's hands still being processed (a counter).
 *   No `backfill`: the browser no longer counts. The types are
 *   `player_types` (P3: kept on the server as opponents' statistics change).
 * - **The two "You" figures** ({@link fetchPoolYou}, `analytics_pool_you`):
 *   the player's results with a fish in the pot and with regs and no fish,
 *   over the screen's whole filter, from each hero hand's tag (`opp_mix`,
 *   docs/POOL.md P3) - no `report_open` over the "vs type".
 * - **Writes** happen on the server only: the one pass keeps each hand's
 *   opponents with its field (`pool_hand_seats`) and adds them up; a deleted
 *   hand's seats are taken out again (P2).
 */
import type { HandFilter } from "@rail/ui/hands/model";
import type {
  AnalyticsPool,
  PoolFilters,
  PoolStatSums,
  PoolSums,
  PoolTypeSums,
  PoolYou,
  PoolYouSums,
} from "@rail/ui/analytics/model";
import { poolFiltersOf } from "@rail/ui/analytics/poolView";

import { ANALYTICS_MEMBERSHIP_VERSION } from "../stats/analytics";
import { STATS_VERSION } from "../stats/types";
import { rpc } from "./client";
import { libraryFilter } from "./handsSource";

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

function youSide(value: unknown): PoolYouSums {
  const row = (value && typeof value === "object" ? value : {}) as Row;
  return {
    hands: num(row.hands),
    moneyHands: num(row.moneyHands),
    netBbMilli: row.netBbMilli === null || row.netBbMilli === undefined ? null : num(row.netBbMilli),
  };
}

/**
 * The player's results with a fish in the pot and with regs and no fish
 * (`analytics_pool_you`), over the Hands list's filter as the reports read it.
 */
export async function fetchPoolYou(query: HandFilter): Promise<PoolYou | null> {
  const data = await rpc<Row | null>("analytics_pool_you", { p_filter: libraryFilter(query) });
  if (!data) return null;
  return { fish: youSide(data.fish), regsOnly: youSide(data.regsOnly) };
}

/** The web's `AnalyticsPool`. */
export const webPool: AnalyticsPool = {
  sums: (query: HandFilter) => fetchPool(poolFiltersOf(query)),
  you: (query: HandFilter) => fetchPoolYou(query),
};
