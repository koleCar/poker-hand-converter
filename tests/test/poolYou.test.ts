/**
 * The Pool tab's two "You" figures on the web (docs/POOL.md P3): the web's
 * `AnalyticsPool.you` reads `analytics_pool_you` - each hero hand tagged by
 * its opponents' types on the server - with the Hands list's filter as the
 * reports read it, instead of two `report_open` calls over the "vs type".
 * Against a faked `rpc`: the call, the wire filter, the mapping (big blinds
 * withheld when chips and cash mix), and the rates the tab shows from it.
 */
import { describe, expect, it, vi } from "vitest";

import { youRates } from "@rail/ui/analytics/poolView";

const rpc = vi.fn();
vi.mock("../../web/src/lib/db/client.js", () => ({
  rpc: (...args: unknown[]) => rpc(...args),
}));

const { fetchPoolYou, webPool } = await import("../../web/src/lib/db/analyticsPool.js");
const { STATS_VERSION } = await import("../../web/src/lib/stats/types.js");
const { FACTS_VERSION } = await import("../../web/src/lib/stats/builderFacts.js");

describe("the web's Pool figures (analytics_pool_you)", () => {
  it("one call with the Hands filter as the reports send it, no report_open", async () => {
    rpc.mockReset();
    rpc.mockResolvedValueOnce({
      statsVersion: STATS_VERSION,
      fish: { hands: 5_000, moneyHands: 5_000, netBbMilli: 740_000 },
      regsOnly: { hands: 13_000, moneyHands: 12_900, netBbMilli: 52_000 },
    });
    const you = await webPool.you!({ formats: ["cash"], positions: ["BTN"], playerName: "RegRita" });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, { p_filter: Record<string, unknown> }];
    expect(name).toBe("analytics_pool_you");
    expect(args.p_filter).toMatchObject({
      formats: ["cash"],
      positions: ["BTN"],
      player: "RegRita",
      statsVersion: STATS_VERSION,
      factsVersion: FACTS_VERSION,
    });
    expect(args.p_filter.playerName).toBeUndefined();
    expect(you).toEqual({
      fish: { hands: 5_000, moneyHands: 5_000, netBbMilli: 740_000 },
      regsOnly: { hands: 13_000, moneyHands: 12_900, netBbMilli: 52_000 },
    });
    const rates = youRates(you);
    expect(rates.fish).toEqual({ hands: 5_000, bb100: 14.8 });
    expect(rates.regsOnly?.bb100).toBeCloseTo((52 * 100) / 12_900, 9);
  });

  it("big blinds withheld (chips with cash) stay null; nothing from the server is null", async () => {
    rpc.mockReset();
    rpc.mockResolvedValueOnce({
      fish: { hands: 3, moneyHands: 3, netBbMilli: null },
      regsOnly: { hands: "2", moneyHands: "1", netBbMilli: null },
    });
    const you = await fetchPoolYou({});
    expect(you).toEqual({
      fish: { hands: 3, moneyHands: 3, netBbMilli: null },
      regsOnly: { hands: 2, moneyHands: 1, netBbMilli: null },
    });
    expect(youRates(you)).toEqual({ fish: { hands: 3, bb100: null }, regsOnly: { hands: 2, bb100: null } });
    rpc.mockResolvedValueOnce(null);
    expect(await fetchPoolYou({})).toBeNull();
  });
});
