/**
 * Leaks and progress (phase A6, `docs/ANALYSIS-PLAN.md` §6.0 *Leaks*,
 * `frontend/src/lib/analysis/leaks.ts`).
 *
 * The database sums graded decisions per finest spot
 * (`20270201090000_analysis_leaks.sql`, pinned by pgTAP); everything that
 * decides what a leak is, when a thin spot merges up, how leaks rank and how
 * two periods compare is asserted here on hand-built rows, so every number
 * below can be checked by hand.
 */

import { describe, expect, it } from "vitest";

import {
  ANY,
  LEAK_LEVELS,
  MIN_SPOT_SAMPLE,
  NONE,
  Z_CLEAR,
  atLevel,
  comparePeriods,
  confidenceOf,
  groupLeaks,
  isLeakRow,
  leakConcepts,
  leakId,
  leakKind,
  meanZ,
  mergeRows,
  parseLeakId,
  periodWindows,
  rateZ,
  scenarioFamily,
  sortLeaks,
  spotAttrs,
  standardError,
  trendOf,
  trendSeries,
  type SpotRow,
  type TrendRow,
} from "../../frontend/src/lib/analysis/leaks.js";
import { CONCEPT_IDS } from "../../frontend/src/lib/learn/concepts.js";

/** A finest row; the key is built the way `analysis_spot_key` builds it. */
function row(
  street: string,
  scenario: string,
  line: string,
  position: string,
  taken: string,
  best: string,
  decisions: number,
  extra: Partial<SpotRow> = {},
): SpotRow {
  const nonPerfect = extra.nonPerfect ?? (taken === best ? 0 : decisions);
  return {
    key: [street, scenario, line, position, taken, best].join("|"),
    ...(extra.set !== undefined ? { set: extra.set } : {}),
    street,
    scenario,
    line,
    position,
    taken,
    best,
    decisions,
    hands: decisions,
    nonPerfect,
    mistakes: extra.mistakes ?? nonPerfect,
    evLossBb: extra.evLossBb ?? 0,
    evLossPot: extra.evLossPot ?? 0,
    scoreSum: extra.scoreSum ?? 100 * (decisions - nonPerfect),
    scoreSq: extra.scoreSq ?? 10000 * (decisions - nonPerfect),
  };
}

/** `n` Perfect decisions at a situation: frequency without a leak. */
const perfect = (street: string, scenario: string, line: string, position: string, action: string, n: number) =>
  row(street, scenario, line, position, action, action, n);

describe("spot attributes", () => {
  it("takes both seats from the chart line preflop", () => {
    // UTG, HJ, CO fold, BTN opens, SB folds: the big blind faces the button's open.
    const attrs = spotAttrs(row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 1));
    expect(attrs).toMatchObject({ hero: "BB", villain: "BTN", family: "vs-raise" });
    // The opener facing the big blind's 3-bet: the villain is the last raiser.
    expect(spotAttrs(row("preflop", "vs-3bet", "rffffr", "UTG", "fold", "call", 1))).toMatchObject({
      hero: "UTG",
      villain: "BB",
      family: "vs-reraise",
    });
    // A short-handed seat is grouped at the node the chart graded it at.
    expect(spotAttrs(row("preflop", "vs-open", "fffrf", "LJ", "fold", "call", 1)).hero).toBe("BB");
  });

  it("reads the UTG open's empty line as a chart node with no villain", () => {
    expect(spotAttrs(row("preflop", "unopened", "", "UTG", "fold", "raise", 1))).toMatchObject({
      hero: "UTG",
      villain: NONE,
      family: "first-in",
    });
  });

  it("keeps the decision's seat postflop, and the role is the scenario", () => {
    expect(spotAttrs(row("river", "caller-oop-vs-bet", "", "BB", "fold", "call", 1))).toMatchObject({
      hero: "BB",
      villain: NONE,
      family: "vs-bet",
    });
  });

  it("names a family for every scenario the engine writes", () => {
    expect(scenarioFamily("preflop", "squeeze")).toBe("vs-raise");
    expect(scenarioFamily("preflop", "vs-4bet")).toBe("vs-reraise");
    expect(scenarioFamily("preflop", "bb-option")).toBe("first-in");
    expect(scenarioFamily("flop", "pfr-ip-first")).toBe("first");
    expect(scenarioFamily("turn", "limped-oop-vs-raise")).toBe("vs-raise");
  });

  it("drops parts level by level, and ids round-trip", () => {
    const attrs = spotAttrs(row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 1));
    expect(LEAK_LEVELS).toHaveLength(5);
    expect(atLevel(attrs, 1)).toMatchObject({ hero: "BB", villain: ANY });
    expect(atLevel(attrs, 2)).toMatchObject({ hero: ANY, scenario: "vs-open" });
    expect(atLevel(attrs, 3)).toMatchObject({ scenario: ANY, family: "vs-raise" });
    expect(atLevel(attrs, 4)).toMatchObject({ family: ANY, street: "preflop", taken: "fold", best: "call" });
    const id = leakId(atLevel(attrs, 1));
    expect(parseLeakId(id)).toEqual(atLevel(attrs, 1));
    expect(parseLeakId("preflop~vs-open")).toBeNull();
    expect(parseLeakId("a~b~c~d~e~f~<script>")).toBeNull();
  });

  it("names a full-ring spot on its own table and keeps it apart from 6-max's (A2d)", () => {
    const six = spotAttrs(row("preflop", "unopened", "", "UTG", "fold", "raise", 1, { set: "nlhe-cash-6max-100bb" }));
    const nine = spotAttrs(row("preflop", "unopened", "", "UTG", "fold", "raise", 1, { set: "nlhe-cash-9max-150bb" }));
    expect(six).toMatchObject({ hero: "UTG" });
    expect(six.table).toBeUndefined();
    expect(nine).toMatchObject({ hero: "UTG", table: "9max" });
    expect(leakId(six)).toBe("preflop~unopened~first-in~UTG~-~fold~raise");
    expect(leakId(nine)).toBe("preflop~unopened~first-in~UTG~-~fold~raise~9max");
    expect(parseLeakId(leakId(nine))).toEqual(nine);
    expect(parseLeakId(`${leakId(six)}~6max`)).toBeNull();
    // The table goes when the seat does.
    expect(atLevel(nine, 1).table).toBe("9max");
    expect(atLevel(nine, 2).table).toBeUndefined();
    // A 9-max line names 9-max seats: UTG+1, UTG+2 fold, the LJ opens, the HJ faces it.
    expect(spotAttrs(row("preflop", "vs-open", "fffr", "HJ", "fold", "call", 1, { set: "nlhe-cash-9max-100bb" }))).toMatchObject({
      hero: "HJ",
      villain: "LJ",
      table: "9max",
    });
  });

  it("faces the first limper in a limped pot, and nobody behind the small blind's completion (A2d)", () => {
    // UTG limps, HJ and CO fold: the button faces UTG's limp.
    expect(spotAttrs(row("preflop", "vs-limp", "cff", "BTN", "fold", "raise", 1, { set: "nlhe-cash-6max-100bb" }))).toMatchObject({
      hero: "BTN",
      villain: "UTG",
    });
    // The big blind's option after the small blind completes is blind vs blind: no villain, as before.
    expect(spotAttrs(row("preflop", "bb-option", "ffffc", "BB", "check", "raise", 1)).villain).toBe(NONE);
    // UTG limps, the button isolates: UTG faces the button's raise.
    expect(spotAttrs(row("preflop", "vs-open", "cffrff", "UTG", "fold", "call", 1)).villain).toBe("BTN");
  });

  it("splits a spot key met on two sets into two situations, and counts each leak's sets", () => {
    const rows = [
      row("preflop", "unopened", "", "UTG", "fold", "raise", 12, { set: "nlhe-cash-6max-100bb", evLossBb: 3 }),
      row("preflop", "unopened", "", "UTG", "fold", "raise", 15, { set: "nlhe-cash-9max-100bb", evLossBb: 2 }),
      row("preflop", "unopened", "", "UTG", "fold", "raise", 4, { set: "nlhe-cash-9max-150bb", evLossBb: 1 }),
    ];
    const leaks = groupLeaks(rows, { hands: 100 });
    expect(leaks.map((leak) => leak.id).sort()).toEqual([
      "preflop~unopened~first-in~UTG~-~fold~raise",
      "preflop~unopened~first-in~UTG~-~fold~raise~9max",
    ]);
    const nine = leaks.find((leak) => leak.attrs.table === "9max")!;
    expect(nine.decisions).toBe(19);
    expect(nine.sets).toEqual({ "nlhe-cash-9max-100bb": 15, "nlhe-cash-9max-150bb": 4 });
    expect(nine.keys).toEqual(["preflop|unopened||UTG|fold|raise"]);
    // Two periods merge equal keys per set, never across them.
    expect(mergeRows([...rows, ...rows]).map((r) => [r.set, r.decisions])).toEqual([
      ["nlhe-cash-6max-100bb", 24],
      ["nlhe-cash-9max-100bb", 30],
      ["nlhe-cash-9max-150bb", 8],
    ]);
  });

  it("calls a row a leak row when the move was not the best, or was at the wrong size", () => {
    expect(isLeakRow(row("river", "pfr-ip-first", "", "BTN", "check", "bet", 3))).toBe(true);
    expect(isLeakRow(row("river", "pfr-ip-first", "", "BTN", "bet", "bet", 3, { nonPerfect: 1 }))).toBe(true);
    expect(isLeakRow(perfect("river", "pfr-ip-first", "", "BTN", "bet", 3))).toBe(false);
  });
});

describe("grouping and ranking", () => {
  it("groups a spot's decisions, counts the whole situation as its frequency, and does the arithmetic", () => {
    const rows = [
      row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 6, { evLossBb: 3, mistakes: 2 }),
      perfect("preflop", "vs-open", "fffrf", "BB", "call", 10),
      perfect("preflop", "vs-open", "fffrf", "BB", "fold", 8),
      // A short-handed seat at the same node: the same situation and leak.
      row("preflop", "vs-open", "fffrf", "LJ", "fold", "call", 2, { evLossBb: 1 }),
    ];
    const [leak, ...rest] = groupLeaks(rows, { hands: 200 });
    expect(rest).toHaveLength(0);
    expect(leak).toMatchObject({
      id: "preflop~vs-open~vs-raise~BB~BTN~fold~call",
      level: 0,
      partial: false,
      decisions: 8,
      mistakes: 8,
      serious: 4,
      evLossBb: 4,
      spotDecisions: 26,
      per100: 2,
      perMistake: 0.5,
    });
    expect(leak.perSpot).toBeCloseTo(4 / 26, 4);
    expect(leak.keys).toEqual([rows[0].key, rows[3].key].sort());
    // What was done there, and what the reference's best move was, per decision.
    expect(leak.taken).toMatchObject({ fold: 16, call: 10 });
    expect(leak.best).toMatchObject({ fold: 8, call: 18 });
  });

  it("merges thin spots up a level, keeping a sibling that stands on its own", () => {
    const rows = [
      // BB vs UTG and vs HJ: 4 + 6 decisions, thin.
      row("preflop", "vs-open", "rffff", "BB", "fold", "call", 2, { evLossBb: 1 }),
      perfect("preflop", "vs-open", "rffff", "BB", "fold", 2),
      row("preflop", "vs-open", "frfff", "BB", "fold", "call", 3, { evLossBb: 2 }),
      perfect("preflop", "vs-open", "frfff", "BB", "fold", 3),
      // BB vs BTN: 30 decisions, its own row.
      row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 5, { evLossBb: 2.5 }),
      perfect("preflop", "vs-open", "fffrf", "BB", "call", 25),
    ];
    const leaks = groupLeaks(rows, { hands: 100 });
    expect(leaks.map((leak) => leak.id)).toEqual([
      "preflop~vs-open~vs-raise~BB~*~fold~call",
      "preflop~vs-open~vs-raise~BB~BTN~fold~call",
    ]);
    const merged = leaks[0];
    expect(merged).toMatchObject({ level: 1, partial: true, spotDecisions: 10, decisions: 5, evLossBb: 3 });
    expect(merged.situationKeys).toHaveLength(2);
    expect(leaks[1]).toMatchObject({ level: 0, partial: false, spotDecisions: 30 });
  });

  it("merges all the way up when every level is thin, and marks it low confidence", () => {
    const rows = [
      row("river", "pfr-ip-first", "", "BTN", "check", "bet", 1, { evLossBb: 4 }),
      row("river", "caller-oop-vs-bet", "", "BB", "check", "bet", 1, { evLossBb: 1 }),
      perfect("river", "pfr-ip-first", "", "CO", "check", 2),
    ];
    const leaks = groupLeaks(rows, { hands: 50 });
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({
      id: `river~${ANY}~${ANY}~${ANY}~${ANY}~check~bet`,
      level: LEAK_LEVELS.length - 1,
      spotDecisions: 2,
      confidence: "low",
    });
    expect(MIN_SPOT_SAMPLE).toBeGreaterThan(2);
  });

  it("leaves out mixed play that cost nothing and losses below the floor", () => {
    const rows = [
      // The reference mixes: a Perfect fold where calling is marginally better.
      row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 12, { nonPerfect: 0, evLossBb: 0.01 }),
      // A real but negligible loss.
      row("preflop", "vs-open", "fffrf", "BB", "raise", "call", 12, { evLossBb: 0.02 }),
    ];
    expect(groupLeaks(rows, { hands: 100 })).toHaveLength(0);
  });

  it("keeps a sizing leak (right action, wrong size)", () => {
    const rows = [row("river", "pfr-ip-first", "", "BTN", "bet", "bet", 12, { nonPerfect: 3, evLossBb: 2 })];
    const [leak] = groupLeaks(rows, { hands: 100 });
    expect(leak.mistakes).toBe(3);
    expect(leakKind(leak.attrs.taken, leak.attrs.best)).toBe("wrong-size");
  });

  it("ranks by total EV, per time in the spot, or mistakes, deterministically", () => {
    const rows = [
      row("preflop", "unopened", "fff", "BTN", "fold", "raise", 4, { evLossBb: 6 }),
      perfect("preflop", "unopened", "fff", "BTN", "raise", 56),
      row("preflop", "unopened", "ff", "CO", "raise", "fold", 9, { evLossBb: 2 }),
      perfect("preflop", "unopened", "ff", "CO", "fold", 1),
    ];
    const byEv = groupLeaks(rows, { hands: 100 });
    expect(byEv.map((leak) => leak.attrs.hero)).toEqual(["BTN", "CO"]);
    expect(sortLeaks(byEv, "per-spot").map((leak) => leak.attrs.hero)).toEqual(["CO", "BTN"]);
    expect(sortLeaks(byEv, "mistakes").map((leak) => leak.attrs.hero)).toEqual(["CO", "BTN"]);
    const shuffled = groupLeaks([rows[3], rows[1], rows[0], rows[2]], { hands: 100 });
    expect(shuffled).toEqual(byEv);
  });

  it("grades confidence by the spot's sample and the mistakes seen", () => {
    expect(confidenceOf(50, 5)).toBe("high");
    expect(confidenceOf(200, 4)).toBe("medium");
    expect(confidenceOf(20, 2)).toBe("medium");
    expect(confidenceOf(19, 10)).toBe("low");
  });

  it("names the wrong turn and links a concept that exists", () => {
    expect(leakKind("fold", "call")).toBe("fold-too-much");
    expect(leakKind("call", "fold")).toBe("call-too-wide");
    expect(leakKind("call", "raise")).toBe("call-not-raise");
    expect(leakKind("raise", "fold")).toBe("raise-too-wide");
    expect(leakKind("bet", "check")).toBe("bet-not-check");
    expect(leakKind("check", "bet")).toBe("check-not-bet");
    expect(leakKind("fold", "check")).toBe("fold-free-check");
    const cases: Array<[string, string, string, string, string]> = [
      ["preflop", "vs-open", "fffrf", "BB", "fold|call"],
      ["preflop", "vs-open", "rf", "CO", "fold|raise"],
      ["preflop", "unopened", "fff", "BTN", "fold|raise"],
      ["preflop", "unopened", "", "UTG", "raise|fold"],
      ["preflop", "squeeze", "rc", "CO", "call|raise"],
      ["preflop", "vs-3bet", "rffffr", "UTG", "fold|call"],
      ["river", "caller-oop-vs-bet", "", "BB", "fold|call"],
      ["river", "pfr-ip-first", "", "BTN", "check|bet"],
      ["flop", "pfr-ip-first", "", "BTN", "check|bet"],
      ["flop", "caller-oop-first", "", "BB", "bet|check"],
      ["turn", "pfr-oop-vs-raise", "", "SB", "call|fold"],
    ];
    expect(leakConcepts(spotAttrs(row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 1)))).toEqual(["blind-defence"]);
    expect(leakConcepts(spotAttrs(row("river", "caller-oop-vs-bet", "", "BB", "fold", "call", 1)))[0]).toBe("bluff-catching");
    for (const [street, scenario, line, seat, pair] of cases) {
      const [taken, best] = pair.split("|");
      const concepts = leakConcepts(spotAttrs(row(street, scenario, line, seat, taken, best, 1)));
      expect(concepts.length).toBeGreaterThan(0);
      for (const id of concepts) expect(CONCEPT_IDS).toContain(id);
    }
  });
});

describe("statistics", () => {
  it("two-proportion z: positive when the mistake rate fell", () => {
    // 20/100 before, 10/100 now: pooled 0.15, se √(0.15·0.85·0.02) = 0.0505.
    const z = rateZ(10, 100, 20, 100)!;
    expect(z).toBeCloseTo(0.1 / Math.sqrt(0.15 * 0.85 * 0.02), 6);
    expect(trendOf(z, true)).toBe("better");
    expect(rateZ(20, 100, 10, 100)!).toBeCloseTo(-z, 9);
    expect(rateZ(0, 50, 0, 50)).toBe(0);
    expect(rateZ(1, 0, 1, 10)).toBeNull();
  });

  it("score means: standard error from sums, Welch z positive when the score rose", () => {
    // Scores 90, 100, 80: mean 90, sample variance 100, se 10/√3.
    const a = { n: 3, sum: 270, sq: 8100 + 10000 + 6400 };
    expect(standardError(a)).toBeCloseTo(10 / Math.sqrt(3), 9);
    // Scores 70, 80, 60: mean 70, the same spread.
    const b = { n: 3, sum: 210, sq: 4900 + 6400 + 3600 };
    expect(meanZ(a, b)).toBeCloseTo(20 / Math.sqrt(2 * (100 / 3)), 9);
    expect(standardError({ n: 1, sum: 90, sq: 8100 })).toBeNull();
  });

  it("words |z| in tiers, and says too few rather than guess", () => {
    expect(trendOf(Z_CLEAR, true)).toBe("better");
    expect(trendOf(1.5, true)).toBe("leaning-better");
    expect(trendOf(0.5, true)).toBe("steady");
    expect(trendOf(-1.2, true)).toBe("leaning-worse");
    expect(trendOf(-3, true)).toBe("worse");
    expect(trendOf(5, false)).toBe("too-few");
    expect(trendOf(null, true)).toBe("too-few");
  });
});

describe("two periods", () => {
  const prior = [
    row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 30, { evLossBb: 15, scoreSum: 30 * 40, scoreSq: 30 * 1600 }),
    perfect("preflop", "vs-open", "fffrf", "BB", "call", 70),
  ];
  const current = [
    row("preflop", "vs-open", "fffrf", "BB", "fold", "call", 5, { evLossBb: 2, scoreSum: 5 * 40, scoreSq: 5 * 1600 }),
    perfect("preflop", "vs-open", "fffrf", "BB", "call", 95),
    // A new leak only this period, too thin to compare.
    row("river", "pfr-ip-first", "", "BTN", "check", "bet", 2, { evLossBb: 6 }),
  ];

  it("compares leaks on the union's grouping, overall and per street by score", () => {
    const result = comparePeriods(current, prior, { currentHands: 100, priorHands: 100 });
    const blind = result.leaks.find((change) => change.leak.attrs.hero === "BB")!;
    expect(blind.current).toMatchObject({ spot: 100, mistakes: 5, evLossBb: 2, rate: 0.05 });
    expect(blind.prior).toMatchObject({ spot: 100, mistakes: 30, evLossBb: 15, rate: 0.3 });
    expect(blind.trend).toBe("better");
    expect(result.improved.map((change) => change.leak.id)).toEqual([blind.leak.id]);
    // What to work on: this period's costliest, however thin (the card words the sample).
    expect(result.focus[0].leak.attrs.street).toBe("river");
    expect(result.focus[0].trend).toBe("too-few");
    expect(result.overall.trend).toBe("better");
    expect(result.streets.map((change) => change.key)).toEqual(["preflop", "river"]);
    expect(result.streets[1].trend).toBe("too-few");
  });

  it("sums equal keys when it merges two periods", () => {
    const merged = mergeRows([...current, ...prior]);
    const fold = merged.find((entry) => entry.taken === "fold")!;
    expect(fold).toMatchObject({ decisions: 35, nonPerfect: 35, evLossBb: 17 });
    expect(merged).toHaveLength(3);
  });

  it("anchors the windows on the last day played, not on today", () => {
    expect(periodWindows("2026-02-21T22:04:07+00:00", 7)).toEqual({
      current: { from: "2026-02-15T00:00:00.000Z", to: "2026-02-22T00:00:00.000Z" },
      prior: { from: "2026-02-08T00:00:00.000Z", to: "2026-02-15T00:00:00.000Z" },
    });
  });
});

describe("trend series", () => {
  const bucket = (start: string, key: string, graded: number, hands: number, bucketHands: number, ev: number, scores: number[]): TrendRow => ({
    start,
    end: start,
    first: start,
    last: start,
    key,
    bucketHands,
    hands,
    graded,
    nonPerfect: scores.filter((score) => score < 100).length,
    mistakes: 0,
    evLossBb: ev,
    evLossPot: 0,
    scoreSum: scores.reduce((sum, score) => sum + score, 0),
    scoreSq: scores.reduce((sum, score) => sum + score * score, 0),
  });

  it("orders buckets, means the score with a 95% margin, and divides per 100 hands by the right hands", () => {
    const rows = [
      bucket("2026-02-09T00:00:00Z", "preflop", 2, 2, 4, 1, [100, 80]),
      bucket("2026-02-02T00:00:00Z", "preflop", 1, 1, 2, 0, [100]),
      bucket("2026-02-09T00:00:00Z", "river", 2, 2, 4, 3, [50, 70]),
    ];
    const [pre, river] = trendSeries(rows, "street");
    expect(pre.key).toBe("preflop");
    expect(pre.points.map((point) => point.start)).toEqual(["2026-02-02T00:00:00Z", "2026-02-09T00:00:00Z"]);
    // By street, a hand plays several streets: per 100 hands divides by the bucket's hands.
    expect(pre.points[1]).toMatchObject({ score: 90, hands: 4, evPer100: 25, offRate: 0.5 });
    expect(pre.points[1].scoreMargin).toBeCloseTo(Z_CLEAR * Math.sqrt(200 / 2), 2);
    expect(pre.points[0].scoreMargin).toBeNull();
    expect(river.points[0].evPer100).toBe(75);
    // Any other group partitions hands: its own hands.
    const [seat] = trendSeries([bucket("2026-02-09T00:00:00Z", "BB", 2, 2, 4, 1, [100, 80])], "position");
    expect(seat.points[0].evPer100).toBe(50);
  });
});
