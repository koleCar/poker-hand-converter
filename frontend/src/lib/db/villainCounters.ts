/**
 * The opponents' statistics an analysis run reads, fetched for exactly the
 * players in the hands being analysed (analysis/20, `lib/analysis/villain.ts`;
 * `docs/ANALYSIS-PLAN.md` §10 2026-10-15).
 *
 * Until then the run read one snapshot of `stats_opponents`, the opponents
 * panel's report, which returns the 200 biggest samples: a learner with more
 * than 200 opponents of `VILLAIN_MIN_HANDS`+ hands got the population range
 * for everybody past the cap. Here the run names the opponents of each chunk
 * of hands and asks `villain_counters` (an invoker read under RLS, rooms with
 * persistent names only, `20270526090000_villain_counters.sql`) for theirs, in
 * calls of at most {@link VILLAIN_COUNTERS_BATCH} keys, each player asked once
 * per run.
 *
 * The pure half: no Supabase here. The fetcher is handed in
 * (`lib/db/analysis.ts` passes the RPC), so the batching and the cache are
 * unit-tested on their own (`tests/test/villainCounters.test.ts`).
 */

import { villainKey, type VillainStats, type VillainStatsMap } from "../analysis/villain";
import type { PhfHand } from "../phf/types";

/** Keys per `villain_counters` call; the server refuses more than 500. */
export const VILLAIN_COUNTERS_BATCH = 500;

/** An opponent as `villain_counters` takes it: the room's id and the name, as stored. */
export interface VillainPlayer {
  site: string;
  player: string;
}

/** One row of `villain_counters`, the counters `villain.ts` reads. */
export interface VillainCountersRow extends VillainPlayer {
  vpipOpp: number;
  vpip: number;
  pfr: number;
}

/** Asks the server for some players' counters (at most `VILLAIN_COUNTERS_BATCH` per call). */
export type VillainCountersFetch = (players: VillainPlayer[]) => Promise<VillainCountersRow[]>;

/**
 * Every named non-hero player of the hands, once each, in first-seen order.
 * The hero is left out: the hero's own rows are never villain rows.
 */
export function opponentsOf(hands: readonly PhfHand[]): VillainPlayer[] {
  const seen = new Set<string>();
  const out: VillainPlayer[] = [];
  for (const hand of hands) {
    const site = hand.meta?.siteId;
    if (!site) continue;
    for (const player of hand.players ?? []) {
      if (player.isHero || !player.name) continue;
      const key = villainKey(site, player.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ site, player: player.name });
    }
  }
  return out;
}

/**
 * The run's cache of opponents' counters. `statsFor(hands)` resolves to the
 * counters of every opponent of those hands the learner has statistics for
 * (null when none has), fetching only players not asked about before in this
 * run; a player in flight for another chunk is waited on, not asked again.
 *
 * A failed call rejects `statsFor` and forgets the players it carried, so the
 * caller can decide what to fall back to and a later chunk asks again.
 */
export class VillainCounters {
  private readonly cache = new Map<string, Promise<VillainStats | null>>();
  private readonly fetch: VillainCountersFetch;
  private readonly batch: number;

  constructor(fetch: VillainCountersFetch, batch: number = VILLAIN_COUNTERS_BATCH) {
    this.fetch = fetch;
    this.batch = Math.max(1, Math.min(VILLAIN_COUNTERS_BATCH, Math.floor(batch)));
  }

  /** Players asked about so far (answered or in flight). */
  get size(): number {
    return this.cache.size;
  }

  async statsFor(hands: readonly PhfHand[]): Promise<VillainStatsMap | null> {
    const players = opponentsOf(hands);
    const missing = players.filter((p) => !this.cache.has(villainKey(p.site, p.player)));
    for (let i = 0; i < missing.length; i += this.batch) {
      const slice = missing.slice(i, i + this.batch);
      const keys = slice.map((p) => villainKey(p.site, p.player));
      const call = this.fetch(slice).then(
        (rows) => {
          const found = new Map<string, VillainStats>();
          for (const row of rows) found.set(villainKey(row.site, row.player), { vpipOpp: row.vpipOpp, vpip: row.vpip, pfr: row.pfr });
          return found;
        },
        (error: unknown) => {
          for (const key of keys) this.cache.delete(key);
          throw error;
        },
      );
      for (const key of keys) this.cache.set(key, call.then((found) => found.get(key) ?? null));
    }
    const out: Record<string, VillainStats> = {};
    const answers = await Promise.all(
      players.map(async (p) => {
        const key = villainKey(p.site, p.player);
        return [key, await this.cache.get(key)!] as const;
      }),
    );
    for (const [key, stats] of answers) if (stats) out[key] = stats;
    return Object.keys(out).length > 0 ? out : null;
  }
}
