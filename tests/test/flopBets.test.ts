/**
 * The raiser's flop bets by board group (Learn L2, `web/src/lib/learn/flopBets.ts`).
 * Since `analysis/41` there is no committed data: the rows were Rail's flop
 * library on Rail's own preflop ranges, gone for GTO Wizard's, so
 * `FLOP_BET_DATA` is null and the widget says so. What stays checked is the
 * pure part the widget will read again once a library on the current ranges
 * exists: every flop in one group, and each group's rows averaged.
 */

import { describe, expect, it } from "vitest";

import { FLOP_BET_DATA, FLOP_GROUPS, flopGroup, groupRows, type FlopBetRow } from "../../web/src/lib/learn/flopBets.js";

describe("the raiser's flop bets by board group (L2)", () => {
  it("have no data while no flop library is solved on the current ranges", () => {
    expect(FLOP_BET_DATA).toBeNull();
  });

  it("group every flop once, and average each group's rows", () => {
    expect(flopGroup("AsKh7d")).toBe("ace-high");
    expect(flopGroup("Ks6s3s")).toBe("monotone");
    expect(flopGroup("KhKs9d")).toBe("paired");
    expect(flopGroup("4d4h4s")).toBe("trips");
    expect(flopGroup("7s5h3d")).toBe("low");
    expect(flopGroup("Ts7h4d")).toBe("middle");
    expect(flopGroup("Qs8s4h")).toBe("king-queen-high");
    const rows: FlopBetRow[] = [
      { flop: "AsKh7d", bet: 0.8, big: 0.2 },
      { flop: "Ah9c3d", bet: 0.6, big: 0.4 },
      { flop: "Ks6s3s", bet: 0.3, big: 0.1 },
      { flop: "KhKs9d", bet: 0.9, big: 0 },
      { flop: "7s5h3d", bet: 0.4, big: 0.3 },
      { flop: "Ts7h4d", bet: 0.5, big: 0.25 },
    ];
    const groups = groupRows(rows);
    expect(groups.reduce((n, g) => n + g.flops, 0)).toBe(rows.length);
    expect(groups.map((g) => g.group)).toEqual(FLOP_GROUPS.filter((g) => groups.some((x) => x.group === g)));
    for (const g of groups) {
      const inGroup = rows.filter((r) => flopGroup(r.flop) === g.group);
      expect(g.bet).toBeCloseTo(inGroup.reduce((s, r) => s + r.bet, 0) / inGroup.length, 4);
      expect(g.big).toBeCloseTo(inGroup.reduce((s, r) => s + r.big, 0) / inGroup.length, 4);
    }
    expect(groups.find((g) => g.group === "ace-high")).toMatchObject({ flops: 2, bet: 0.7, big: 0.3 });
  });
});
