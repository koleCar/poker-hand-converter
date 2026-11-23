/**
 * The Pool tab on the web (docs/ANALYTICS.md Step 10): each named opponent's
 * catalogue rates and results, counted in the browser (`lib/db/poolCounts.ts`),
 * written by `analytics_pool_save` and summed by type by `analytics_pool`
 * (`20271122100000_analytics_pool.sql`).
 *
 * - **Backfill** ({@link backfillPool}): the hands not counted at the
 *   catalogue's version (`analytics_pool_pending`, a keyset page at a time),
 *   each parsed back from its stored row and counted - run by the Pool tab
 *   while it is open and hands are pending. Idempotent: a hand counted twice
 *   adds once, and a hand the browser cannot read is marked with no players,
 *   so the list runs dry.
 * - **Reads**: {@link webPool} (`AnalyticsPool` of `@rail/ui`): the tab's
 *   sums over the screen's filter (the kind or format and the rooms; the
 *   types read from `player_stats` at this build's statistics version).
 */
import type { HandFilter } from "@rail/ui/hands/model";
import type { AnalyticsPool, PoolFilters, PoolProgress, PoolStatSums, PoolSums, PoolTypeSums } from "@rail/ui/analytics/model";
import { poolFiltersOf } from "@rail/ui/analytics/poolView";

import { ANALYTICS_MEMBERSHIP_VERSION } from "../stats/analytics";
import { poolHand, type PoolHand } from "./poolCounts";
import { STATS_VERSION } from "../stats/types";
import { rpc } from "./client";
import { handOfRow, type StoredHandRow } from "./storedHand";

/** Hands per `analytics_pool_save` call (it takes 200) and per backfill page. */
const PAGE = 100;

/** Saves counted hands. How many were newly counted. */
export async function savePool(hands: readonly PoolHand[]): Promise<number> {
  let saved = 0;
  for (let i = 0; i < hands.length; i += PAGE) {
    const result = await rpc<{ saved?: number } | null>("analytics_pool_save", {
      p_version: ANALYTICS_MEMBERSHIP_VERSION,
      p_hands: hands.slice(i, i + PAGE),
    });
    saved += result?.saved ?? 0;
  }
  return saved;
}

type PendingRow = StoredHandRow & { id: string };

/**
 * Counts every hand not counted at the catalogue's version, a page at a
 * time, until the list is walked or `signal` stops it.
 */
export async function backfillPool(
  signal?: AbortSignal,
  onProgress?: (progress: PoolProgress) => void,
): Promise<PoolProgress> {
  const total: PoolProgress = { processed: 0, saved: 0 };
  const fetchPage = async (after: string | null): Promise<PendingRow[]> =>
    (await rpc<PendingRow[] | null>("analytics_pool_pending", {
      p_version: ANALYTICS_MEMBERSHIP_VERSION,
      p_after: after ?? undefined,
      p_limit: PAGE,
    })) ?? [];
  let next: Promise<PendingRow[]> | null = fetchPage(null);
  // Bounded so a server that never runs dry cannot spin a tab forever.
  for (let guard = 0; next !== null && guard < 100_000 && !signal?.aborted; guard += 1) {
    const page: PendingRow[] = await next;
    if (page.length === 0) break;
    // The next page is on its way while this one is read and saved (keyset
    // order: this page's rows are never in it).
    next = page.length < PAGE ? null : fetchPage(page[page.length - 1].id);
    const hands: PoolHand[] = await Promise.all(
      page.map(async (row) => {
        let phf = null;
        try {
          phf = await handOfRow(row);
        } catch {
          phf = null;
        }
        return poolHand(row.id, phf);
      }),
    );
    if (signal?.aborted) break;
    total.saved += await savePool(hands);
    total.processed += page.length;
    onProgress?.({ ...total });
  }
  // A page fetched ahead and not needed (stopped): nothing waits on it.
  next?.catch(() => undefined);
  return total;
}

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
  backfill: (signal, onProgress) => backfillPool(signal, onProgress),
};
