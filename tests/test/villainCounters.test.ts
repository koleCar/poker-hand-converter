/**
 * The opponents' counters an analysis run reads, by key and in batches
 * (`frontend/src/lib/db/villainCounters.ts`, analysis/20; ANALYSIS-PLAN §10
 * 2026-10-15): every opponent of the hands analysed, not only the 200 biggest
 * samples.
 *
 * - the opponents of a set of hands: named non-hero players, once each, keyed
 *   by room;
 * - calls of at most `VILLAIN_COUNTERS_BATCH` keys, each player asked once per
 *   run, a player in flight waited on rather than asked again;
 * - the snapshot shape `villain.ts` reads (`villainKey` -> counters), null when
 *   nobody has statistics;
 * - a failed call rejects and is forgotten, so the next chunk asks again.
 */

import { describe, expect, it } from "vitest";

import { villainKey } from "../../frontend/src/lib/analysis/villain.js";
import {
  opponentsOf,
  VILLAIN_COUNTERS_BATCH,
  VillainCounters,
  type VillainCountersRow,
  type VillainPlayer,
} from "../../frontend/src/lib/db/villainCounters.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";

/** Just the fields `opponentsOf` reads. */
function hand(site: string, hero: string, villains: string[]): PhfHand {
  const players = [hero, ...villains].map((name, i) => ({ seat: i + 1, name, isHero: i === 0 }));
  return { meta: { siteId: site }, players } as unknown as PhfHand;
}

/** A fetcher that records its calls and answers from a table of known players. */
function server(known: Record<string, [number, number, number]>, fail = 0) {
  const calls: VillainPlayer[][] = [];
  let failures = fail;
  const fetch = async (players: VillainPlayer[]): Promise<VillainCountersRow[]> => {
    calls.push(players);
    await Promise.resolve();
    if (failures > 0) {
      failures -= 1;
      throw new Error("network");
    }
    return players.flatMap((p) => {
      const row = known[villainKey(p.site, p.player)];
      return row ? [{ ...p, vpipOpp: row[0], vpip: row[1], pfr: row[2] }] : [];
    });
  };
  return { fetch, calls };
}

describe("opponentsOf", () => {
  it("lists the named non-hero players of the hands once each, keyed by room", () => {
    const hands = [hand("weplay", "Me", ["A", "B"]), hand("weplay", "Me", ["B", "C", ""]), hand("gg", "Me", ["A"])];
    expect(opponentsOf(hands)).toEqual([
      { site: "weplay", player: "A" },
      { site: "weplay", player: "B" },
      { site: "weplay", player: "C" },
      { site: "gg", player: "A" },
    ]);
  });
});

describe("VillainCounters", () => {
  it("builds the snapshot villain.ts reads, for exactly the hands' opponents", async () => {
    const { fetch, calls } = server({ "weplay:A": [40, 12, 4], "weplay:C": [31, 10, 9], "weplay:Z": [99, 9, 9] });
    const counters = new VillainCounters(fetch);
    const map = await counters.statsFor([hand("weplay", "Me", ["A", "B", "C"])]);
    expect(map).toEqual({ "weplay:A": { vpipOpp: 40, vpip: 12, pfr: 4 }, "weplay:C": { vpipOpp: 31, vpip: 10, pfr: 9 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].map((p) => p.player)).toEqual(["A", "B", "C"]);
  });

  it("is null when none of the opponents has statistics", async () => {
    const { fetch } = server({});
    expect(await new VillainCounters(fetch).statsFor([hand("weplay", "Me", ["A"])])).toBeNull();
    expect(await new VillainCounters(fetch).statsFor([])).toBeNull();
  });

  it("splits a large set of opponents into calls of at most the batch size", async () => {
    const names = Array.from({ length: 1234 }, (_, i) => `P${i}`);
    const known = Object.fromEntries(names.map((n, i) => [villainKey("weplay", n), [30 + i, 10, 5] as [number, number, number]]));
    const { fetch, calls } = server(known);
    const map = await new VillainCounters(fetch).statsFor([hand("weplay", "Me", names)]);
    expect(calls.map((c) => c.length)).toEqual([VILLAIN_COUNTERS_BATCH, VILLAIN_COUNTERS_BATCH, 1234 - 2 * VILLAIN_COUNTERS_BATCH]);
    // Every opponent gets their own statistics: no cap of 200.
    expect(Object.keys(map ?? {})).toHaveLength(1234);
    expect(map?.["weplay:P1233"]).toEqual({ vpipOpp: 1263, vpip: 10, pfr: 5 });
  });

  it("asks each player once per run, including one still in flight for another chunk", async () => {
    const { fetch, calls } = server({ "weplay:A": [40, 12, 4], "weplay:B": [50, 20, 10] });
    const counters = new VillainCounters(fetch, 2);
    const [first, second] = await Promise.all([
      counters.statsFor([hand("weplay", "Me", ["A", "B"])]),
      counters.statsFor([hand("weplay", "Me", ["B", "C"])]),
    ]);
    const third = await counters.statsFor([hand("weplay", "Me", ["A", "C", "D"])]);
    expect(calls.map((c) => c.map((p) => p.player))).toEqual([["A", "B"], ["C"], ["D"]]);
    expect(first).toEqual({ "weplay:A": { vpipOpp: 40, vpip: 12, pfr: 4 }, "weplay:B": { vpipOpp: 50, vpip: 20, pfr: 10 } });
    expect(second).toEqual({ "weplay:B": { vpipOpp: 50, vpip: 20, pfr: 10 } });
    expect(third).toEqual({ "weplay:A": { vpipOpp: 40, vpip: 12, pfr: 4 } });
    expect(counters.size).toBe(4);
  });

  it("rejects on a failed call and asks again next time", async () => {
    const { fetch, calls } = server({ "weplay:A": [40, 12, 4] }, 1);
    const counters = new VillainCounters(fetch);
    await expect(counters.statsFor([hand("weplay", "Me", ["A"])])).rejects.toThrow("network");
    expect(await counters.statsFor([hand("weplay", "Me", ["A"])])).toEqual({ "weplay:A": { vpipOpp: 40, vpip: 12, pfr: 4 } });
    expect(calls).toHaveLength(2);
  });
});
