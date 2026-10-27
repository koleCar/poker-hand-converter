/**
 * R5.5: the ICM engine (`lib/analysis/icm.ts`) and the tournament model
 * (`lib/analysis/tournament.ts`).
 *
 * The expectations are our own: Harville's formula (JASA 68, 1973) worked by
 * hand for small cases - every number below is derived in the comment next
 * to it - and an independent brute force over every finishing order for the
 * rest. No number is taken from a commercial ICM tool.
 */

import { describe, expect, it } from "vitest";

import {
  allInPrice,
  chipEquity,
  chipsForEquity,
  exactCost,
  icm,
  transfer,
  DEFAULT_ICM_SAMPLES,
  EXACT_BUDGET,
} from "../../web/src/lib/analysis/icm.js";
import {
  MTT_ICM_MAX_LEFT,
  mttPayouts,
  remainingPrizes,
  settingsProblem,
  standardPayouts,
  tableStacks,
  tournamentKey,
  tournamentKind,
  tournamentModel,
} from "../../web/src/lib/analysis/tournament.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";

/** Harville by brute force: every finishing order, the product of `s_i / (what is left)`. */
function bruteForce(stacks: number[], prizes: number[]): number[] {
  const n = stacks.length;
  const out = new Array<number>(n).fill(0);
  const alive = stacks.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0);
  const dead = stacks.map((s, i) => (s > 0 ? -1 : i)).filter((i) => i >= 0);
  const prize = (p: number) => prizes[p] ?? 0;
  const walk = (left: number[], placed: number, prob: number) => {
    if (left.length === 0) return;
    const total = left.reduce((sum, i) => sum + stacks[i], 0);
    for (const i of left) {
      const p = (prob * stacks[i]) / total;
      out[i] += p * prize(placed);
      walk(
        left.filter((j) => j !== i),
        placed + 1,
        p,
      );
    }
  };
  walk(alive, 0, 1);
  if (dead.length > 0) {
    let share = 0;
    for (let p = alive.length; p < n; p += 1) share += prize(p);
    for (const i of dead) out[i] = share / dead.length;
  }
  return out;
}

describe("icm(): Malmuth-Harville, exact", () => {
  it("values 5000 / 3000 / 2000 at 50 / 30 / 20 as Harville's formula does by hand", () => {
    // B (3000 of 10 000): first 0.3; second 0.5 · 3/5 + 0.2 · 3/8 = 0.375; third 0.325.
    // E_B = 0.3 · 50 + 0.375 · 30 + 0.325 · 20 = 15 + 11.25 + 6.5 = 32.75.
    // A (5000): first 0.5; second 0.3 · 5/7 + 0.2 · 5/8 = 0.339286; E_A = 25 + 30 · 0.339286 + 20 · 0.160714 = 38.392857.
    // C: 100 − 32.75 − 38.392857 = 28.857143.
    const result = icm([5000, 3000, 2000], [50, 30, 20]);
    expect(result.method).toBe("exact");
    expect(result.equity[1]).toBeCloseTo(32.75, 12);
    expect(result.equity[0]).toBeCloseTo(25 + 30 * (0.3 * (5 / 7) + 0.2 * (5 / 8)) + 20 * (1 - 0.5 - (0.3 * (5 / 7) + 0.2 * (5 / 8))), 12);
    expect(result.equity[2]).toBeCloseTo(100 - 32.75 - result.equity[0], 12);
    expect(result.equity[0]).toBeCloseTo(38.392857, 6);
    expect(result.equity[2]).toBeCloseTo(28.857143, 6);
  });

  it("gives two players the first prize by chips and the second to the other", () => {
    // 7000 v 3000 at 65 / 35: 0.7 · 65 + 0.3 · 35 = 56; 0.3 · 65 + 0.7 · 35 = 44.
    expect(icm([7000, 3000], [65, 35]).equity).toEqual([expect.closeTo(56, 12), expect.closeTo(44, 12)]);
  });

  it("splits equal stacks equally and a winner-take-all prize by chips", () => {
    const equal = icm([1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500], [50, 30, 20]).equity;
    for (const e of equal) expect(e).toBeCloseTo(100 / 9, 12);
    const wta = icm([4000, 2500, 1000, 500], [100]).equity;
    expect(wta).toEqual(chipEquity([4000, 2500, 1000, 500], [100]).map((v) => expect.closeTo(v, 12)));
  });

  it("equals the brute force over every finishing order", () => {
    const cases: Array<[number[], number[]]> = [
      [[1200, 3400, 800, 2600, 2000], [50, 30, 20]],
      [[1200, 3400, 800, 2600, 2000, 150, 9000], [40, 25, 15, 10, 6, 4]],
      [[13500, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], [50, 30, 20]],
      [[300, 700, 0, 4000, 1000], [50, 30, 20]],
      [[300, 700, 0, 4000, 0], [40, 30, 20, 10]],
    ];
    for (const [stacks, prizes] of cases) {
      const fast = icm(stacks, prizes).equity;
      const slow = bruteForce(stacks, prizes);
      fast.forEach((value, i) => expect(value).toBeCloseTo(slow[i], 12));
      // The pool is conserved: every paid place goes to someone.
      expect(fast.reduce((a, b) => a + b, 0)).toBeCloseTo(prizes.slice(0, stacks.length).reduce((a, b) => a + b, 0), 10);
    }
  });

  it("gives the busted the lowest places among the field", () => {
    // Two left of four, the other two out in this hand: they share 3rd and 4th (20 + 0) / 2.
    const result = icm([6000, 4000, 0, 0], [50, 30, 20]).equity;
    expect(result[2]).toBeCloseTo(10, 12);
    expect(result[3]).toBeCloseTo(10, 12);
    expect(result[0]).toBeCloseTo(0.6 * 50 + 0.4 * 30, 12);
  });

  it("is deterministic and counts its own work", () => {
    expect(exactCost(9, 3)).toBe(9 + 9 * 8 + 36 * 7);
    expect(exactCost(9, 9)).toBe(9 * 2 ** 8);
    const stacks = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => x * 1000);
    expect(icm(stacks, [50, 30, 20])).toEqual(icm(stacks, [50, 30, 20]));
  });

  it("refuses what is not a stack or a prize", () => {
    expect(() => icm([], [100])).toThrow();
    expect(() => icm([100, -1], [100])).toThrow();
    expect(() => icm([100, Number.NaN], [100])).toThrow();
    expect(() => icm([100, 100], [Infinity])).toThrow();
  });
});

describe("icm(): Monte-Carlo beyond the exact budget", () => {
  // 40 players paying 10: past the budget, so sampled.
  const stacks = Array.from({ length: 40 }, (_, i) => 1000 + ((i * 7919) % 23) * 400);
  const prizes = mttPayouts(67).slice(0, 10);

  it("switches to sampling past EXACT_BUDGET and reports its error bound", () => {
    expect(exactCost(40, 10)).toBeGreaterThan(EXACT_BUDGET);
    const result = icm(stacks, prizes);
    expect(result.method).toBe("monte-carlo");
    expect(result.samples).toBe(DEFAULT_ICM_SAMPLES);
    // z_1 / (2 √n) and the empirical error under it.
    expect(result.errorBound).toBeCloseTo(prizes[0] / (2 * Math.sqrt(DEFAULT_ICM_SAMPLES)), 12);
    expect(result.standardError).toBeLessThanOrEqual(result.errorBound);
    expect(result.equity.reduce((a, b) => a + b, 0)).toBeCloseTo(prizes.reduce((a, b) => a + b, 0), 9);
  });

  it("agrees with the exact answer within four standard errors where both run", () => {
    const small = [4000, 2500, 1800, 1200, 900, 600, 400, 300, 200, 100];
    const pay = [40, 25, 15, 10, 6, 4];
    const exact = icm(small, pay).equity;
    const sampled = icm(small, pay, { method: "monte-carlo" });
    sampled.equity.forEach((value, i) => expect(Math.abs(value - exact[i])).toBeLessThan(4 * sampled.errorBound));
  });

  it("estimates a difference with common random numbers far tighter than either value", () => {
    const small = [4000, 2500, 1800, 1200, 900, 600, 400, 300, 200, 100];
    const pay = [40, 25, 15, 10, 6, 4];
    const after = transfer(small, 3, 5, 600);
    const exact = icm(after, pay).equity[3] - icm(small, pay).equity[3];
    const opts = { method: "monte-carlo" as const, samples: 4000 };
    const sampled = icm(after, pay, opts).equity[3] - icm(small, pay, opts).equity[3];
    const bound = icm(small, pay, opts).errorBound;
    expect(Math.abs(sampled - exact)).toBeLessThan(bound);
  });

  it("is deterministic for a seed and moves with it", () => {
    expect(icm(stacks, prizes)).toEqual(icm(stacks, prizes));
    expect(icm(stacks, prizes, { seed: 7 }).equity).not.toEqual(icm(stacks, prizes).equity);
  });
});

describe("the price of an all-in: bubble factor and risk premium", () => {
  it("is even money winner-take-all", () => {
    const price = allInPrice([3000, 2000, 5000], [100], 0, 1)!;
    expect(price.bubbleFactor).toBeCloseTo(1, 12);
    expect(price.riskPremium).toBeCloseTo(0, 12);
  });

  it("costs more than it gains on a sit-and-go bubble", () => {
    // Four equal stacks, three paid 50 / 30 / 20: now 25 each.
    // Lose: out in 4th with nothing.
    const stacks = [2500, 2500, 2500, 2500];
    const price = allInPrice(stacks, [50, 30, 20], 0, 1)!;
    const win = bruteForce([5000, 0, 2500, 2500], [50, 30, 20])[0];
    expect(price.now).toBeCloseTo(25, 12);
    expect(price.lose).toBeCloseTo(0, 12);
    expect(price.win).toBeCloseTo(win, 12);
    // Win: 5000 of 10 000 against two of 2500. First 0.5; second 2 · 0.25 · 5000/7500 = 1/3; third 1/6.
    // 25 + 10 + 3.333 = 38.333; the bubble factor 25 / 13.333 = 1.875, the equity needed 15/8 / 23/8 = 65.2 %.
    expect(win).toBeCloseTo(25 + 10 + 20 / 6, 12);
    expect(price.bubbleFactor).toBeCloseTo(1.875, 12);
    expect(price.riskPremium).toBeCloseTo(15 / 23 - 0.5, 12);
    expect(price.required).toBeCloseTo(price.bubbleFactor / (1 + price.bubbleFactor), 12);
  });

  it("is null without chips on both sides", () => {
    expect(allInPrice([0, 100], [100], 0, 1)).toBeNull();
    expect(allInPrice([100, 100], [100], 0, 0)).toBeNull();
  });
});

describe("chip EV and $EV", () => {
  it("inverts ICM: the stack worth a given equity", () => {
    const stacks = [5000, 3000, 2000];
    const prizes = [50, 30, 20];
    const target = 35;
    const chips = chipsForEquity(stacks, prizes, 1, target);
    const scale = (10_000 - chips) / 7000;
    const equity = icm([5000 * scale, chips, 2000 * scale], prizes).equity[1];
    expect(equity).toBeCloseTo(target, 6);
    // Winner-take-all is linear: 35 % of the pool is 35 % of the chips.
    expect(chipsForEquity(stacks, [100], 1, 35)).toBeCloseTo(3500, 4);
  });

  it("clamps to the stacks' range", () => {
    expect(chipsForEquity([100, 100], [65, 35], 0, 0)).toBe(0);
    expect(chipsForEquity([100, 100], [65, 35], 0, 100)).toBe(200);
  });
});

/* ------------------------------------------------------------ the model - */

function tournamentHand(opts: { name?: string | null; format?: "tournament" | "sng" | "spin"; maxSeats?: number; stacks: number[]; id?: string; playedAt?: string; prizePool?: number; buyIn?: number }): PhfHand {
  const players = opts.stacks.map((stack, i) => ({
    seat: i + 1,
    name: `P${i + 1}`,
    startingStack: stack,
    isHero: i === 0,
    holeCards: [],
    dealtAnnounced: false,
    dealtCards: [],
    bounty: null,
    sittingOut: false,
    position: null,
  }));
  return {
    meta: { siteId: "WePlay", siteName: "WePlay", handId: "1", handKey: "1" },
    game: { format: opts.format ?? "tournament", bigBlind: 100, smallBlind: 50 },
    table: { maxSeats: opts.maxSeats ?? 9, name: "T", buttonSeat: 1 },
    tournament: {
      id: opts.id ?? "123",
      name: opts.name ?? null,
      buyIn: opts.buyIn ?? 500,
      fee: 50,
      buyInUnit: { kind: "money", currency: "USD", minorUnits: 100 },
      levelLabel: null,
      levelNumber: null,
      levelSmallBlind: 50,
      levelBigBlind: 100,
      levelAnte: 0,
      bounties: [],
      ...(opts.prizePool ? { prizePool: opts.prizePool } : {}),
    },
    players,
    playedAt: opts.playedAt ?? "2026-02-10T17:00:00Z",
  } as unknown as PhfHand;
}

describe("payout models", () => {
  it("pays the generic multi-table curve: the top 15 %, place p weighted 1/p", () => {
    const thousand = mttPayouts(1000);
    expect(thousand).toHaveLength(150);
    expect(thousand.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    // H_150 = 5.5910...: first 17.886 %, the 150th 0.119 % of the pool = 1.19 buy-ins of 1000.
    expect(thousand[0]).toBeCloseTo(17.886, 2);
    expect(thousand[149] * 10).toBeCloseTo(1.19, 2);
    // 20 entrants: three paid, 6/11, 3/11, 2/11.
    expect(mttPayouts(20)).toEqual([600 / 11, 300 / 11, 200 / 11].map((x) => expect.closeTo(x, 10)));
    expect(mttPayouts(3)).toEqual([100]);
  });

  it("assumes the standard sit-and-go and spin structures", () => {
    expect(standardPayouts("sng", 9, null)).toEqual([50, 30, 20]);
    expect(standardPayouts("sng", 10, null)).toEqual([50, 30, 20]);
    expect(standardPayouts("sng", 6, null)).toEqual([65, 35]);
    expect(standardPayouts("sng", 2, null)).toEqual([100]);
    expect(standardPayouts("spin", 3, null)).toEqual([100]);
    expect(standardPayouts("mtt", 9, null)).toBeNull();
    expect(standardPayouts("mtt", 9, 20)).toEqual(mttPayouts(20));
  });

  it("reads the kind from the format, then the name, else a multi-table", () => {
    const kind = (name: string | null, format: "tournament" | "sng" | "spin" = "tournament", maxSeats = 9) =>
      tournamentKind(tournamentHand({ name, format, maxSeats, stacks: [1, 1] })).kind;
    expect(kind(null, "sng")).toBe("sng");
    expect(kind(null, "spin")).toBe("spin");
    expect(kind("$5 Regular 9-Max")).toBe("sng");
    expect(kind("$2.40 Hyper Turbo Heads-up", "tournament", 2)).toBe("sng");
    expect(kind("Spin & Gold")).toBe("spin");
    expect(kind("ILWP series - Chocolate Box Deepstack")).toBe("mtt");
    expect(kind("$5,000 GTD")).toBe("mtt");
    expect(kind("Daily Special $250")).toBe("mtt");
    expect(kind(null)).toBe("mtt");
    expect(tournamentKind(tournamentHand({ name: "$5 Regular 9-Max", stacks: [1, 1] }), { kind: "mtt" })).toEqual({ kind: "mtt", source: "user" });
  });

  it("keys settings by room and tournament id", () => {
    expect(tournamentKey(tournamentHand({ stacks: [1, 1], id: " 11275291 " }))).toBe("weplay:11275291");
    expect(tournamentKey(tournamentHand({ stacks: [1, 1], id: "" }))).toBeNull();
  });
});

describe("the tournament model of a hand", () => {
  it("is ICM at a sit-and-go: everyone left is at the table", () => {
    const hand = tournamentHand({ name: "$5 Regular 9-Max", stacks: [3000, 2000, 0, 5000] });
    const model = tournamentModel(hand);
    expect(model).toMatchObject({
      kind: "sng",
      kindSource: "name",
      model: "icm",
      payouts: [50, 30, 20],
      payoutsSource: "standard",
      playersLeft: 3,
      playersLeftSource: "table",
      entrants: 9,
      entrantsSource: "assumed",
      prizePool: { amount: 4500, source: "buy-ins" },
    });
    expect(remainingPrizes(model)).toEqual([0.5, 0.3, 0.2]);
    expect(tableStacks(hand).map((p) => p.seat)).toEqual([1, 2, 4]);
  });

  it("is chips at a multi-table tournament nobody described", () => {
    const model = tournamentModel(tournamentHand({ name: "ILWP series", stacks: [3000, 2000] }));
    expect(model).toMatchObject({ kind: "mtt", model: "chips", chipsReason: "players-left-unknown", payouts: null, playersLeft: null });
    expect(remainingPrizes(model)).toEqual([]);
  });

  it("takes the user's players left, payouts and field, the latest point at or before the hand", () => {
    const hand = tournamentHand({ name: "ILWP series", stacks: [3000, 2000, 1000], playedAt: "2026-02-10T17:00:00Z" });
    const settings = {
      payouts: [40, 30, 20, 10],
      entrants: 50,
      startingStack: 1000,
      playersLeft: [
        { at: "2026-02-10T16:00:00Z", left: 12 },
        { at: "2026-02-10T16:50:00Z", left: 7 },
        { at: "2026-02-10T17:30:00Z", left: 4 },
      ],
    };
    const model = tournamentModel(hand, settings);
    expect(model).toMatchObject({ model: "icm", playersLeft: 7, playersLeftSource: "user", payoutsSource: "user", entrantsSource: "user" });
    // 50 000 chips in play, 6 000 at this table: the four away hold 11 000 each.
    expect(model.others).toEqual({ count: 4, stack: 11_000, source: "field" });
    expect(remainingPrizes(model)).toEqual([0.4, 0.3, 0.2, 0.1]);
    // Without the field, the away players are this table's average.
    expect(tournamentModel(hand, { ...settings, startingStack: null }).others).toEqual({ count: 4, stack: 2000, source: "table" });
    // Before the first point nothing is known.
    expect(tournamentModel({ ...hand, playedAt: "2026-02-10T15:00:00Z" }, settings).model).toBe("chips");
    // Never fewer than the table holds.
    expect(tournamentModel(hand, { ...settings, playersLeft: [{ at: "2026-02-10T16:00:00Z", left: 2 }] }).playersLeft).toBe(3);
  });

  it("assumes the generic curve from a field size, and stays in chips far from the final table", () => {
    const hand = tournamentHand({ name: "Daily Special", stacks: [3000, 2000] });
    const near = tournamentModel(hand, { entrants: 200, playersLeft: [{ at: "2026-01-01T00:00:00Z", left: 9 }] });
    expect(near).toMatchObject({ model: "icm", payoutsSource: "standard" });
    expect(near.payouts).toEqual(mttPayouts(200));
    const far = tournamentModel(hand, { entrants: 200, playersLeft: [{ at: "2026-01-01T00:00:00Z", left: MTT_ICM_MAX_LEFT + 1 }] });
    expect(far).toMatchObject({ model: "chips", chipsReason: "far-field" });
    const noPayouts = tournamentModel(hand, { playersLeft: [{ at: "2026-01-01T00:00:00Z", left: 9 }] });
    expect(noPayouts).toMatchObject({ model: "chips", chipsReason: "payouts-unknown" });
  });

  it("uses a stated prize pool over the buy-ins", () => {
    const model = tournamentModel(tournamentHand({ format: "sng", maxSeats: 3, stacks: [500, 500, 500], prizePool: 400 }));
    expect(model.prizePool).toEqual({ amount: 400, source: "phf" });
    expect(model.payouts).toEqual([100]);
  });

  it("refuses settings that cannot be right, and ignores them as a whole", () => {
    expect(settingsProblem({})).toBeNull();
    expect(settingsProblem({ kind: "sng", payouts: [50, 30, 20], entrants: 9, startingStack: 1500 })).toBeNull();
    expect(settingsProblem({ kind: "cash" as never })).toBe("kind");
    expect(settingsProblem({ payouts: [] })).toBe("payouts");
    expect(settingsProblem({ payouts: [30, 50] })).toBe("payouts-order");
    expect(settingsProblem({ payouts: [60, 50] })).toBe("payouts-sum");
    expect(settingsProblem({ payouts: [0] })).toBe("payouts");
    expect(settingsProblem({ entrants: 1 })).toBe("entrants");
    expect(settingsProblem({ entrants: 2.5 })).toBe("entrants");
    expect(settingsProblem({ startingStack: 0 })).toBe("starting-stack");
    expect(settingsProblem({ playersLeft: [{ at: "yesterday", left: 5 }] })).toBe("players-left");
    expect(settingsProblem({ entrants: 9, playersLeft: [{ at: "2026-01-01T00:00:00Z", left: 10 }] })).toBe("players-left");
    expect(settingsProblem({ entrants: 2, payouts: [50, 30, 20] })).toBe("payouts-places");
    const hand = tournamentHand({ name: "$5 Regular 9-Max", stacks: [3000, 2000] });
    expect(tournamentModel(hand, { kind: "mtt", payouts: [30, 50] }).kind).toBe("sng");
  });
});
