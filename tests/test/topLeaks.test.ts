/**
 * The leak finder's top three (R5.2, `frontend/src/lib/analysis/topLeaks.ts`,
 * the overview card `components/analysis/leaks/TopLeaks.tsx`).
 *
 * - Ranking: EV lost in total, confident leaks (A6's medium or high) before
 *   any thin one, a thin one only with two mistakes and only to fill a place
 *   (marked tentative), ties by the bigger sample, then mistakes, then id.
 * - Uncertainty: the Wilson interval of the mistake rate and the EV per 100
 *   hands it gives.
 * - Was / now: A6's two-proportion comparison over a leak's own spots.
 * - Example hands: one per hand, the costliest of each finer spot first, at
 *   most five, opening at the decision.
 * - The web's source (`lib/db/topLeaks.ts`) against a faked `rpc`, and the
 *   card's body rendered to markup in English and Croatian.
 *
 * The sums themselves are the database's (pgTAP `leak_summaries`, held to
 * `analysis_leaks`).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confidenceOf, groupLeaks, type Leak, type SpotRow } from "../../frontend/src/lib/analysis/leaks.js";
import {
  EXAMPLES_MAX,
  TOP_LEAKS,
  TOP_MIN_MISTAKES,
  compareImportance,
  leakPeriod,
  leakSize,
  leakTrend,
  parseTopPeriod,
  pickExamples,
  rankTopLeaks,
  topEligible,
  wilson,
  type ExampleCandidate,
} from "../../frontend/src/lib/analysis/topLeaks.js";
import { TENTATIVE_MIN_MISTAKES } from "../../frontend/src/lib/training/plan.js";

const rpc = vi.fn();
vi.mock("../../frontend/src/lib/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rpc: (...args: unknown[]) => rpc(...args),
  currentUserId: () => Promise.resolve("00000000-0000-0000-0000-0000000000a1"),
}));

const {
  examplesFromPayload,
  fetchLeakExamples,
  fetchTopLeaks,
  topLeaksFilters,
  topLeaksFromPayload,
} = await import("../../frontend/src/lib/db/topLeaks.js");
const { TopLeaks, TopLeaksBody, topOf } = await import("../../frontend/src/components/analysis/leaks/TopLeaks.js");
const { I18nProvider } = await import("../../frontend/src/lib/i18n/client.js");
const { topLeaksEn } = await import("../../frontend/src/lib/i18n/ns/analysisLeaks.en.js");
const { topLeaksHr } = await import("../../frontend/src/lib/i18n/ns/analysisLeaks.hr.js");

/* ------------------------------------------------------------- fixtures - */

/** A leak as `groupLeaks` makes one; the numbers that matter here are explicit. */
function leak(id: string, evLossBb: number, spotDecisions: number, mistakes: number, extra: Partial<Leak> = {}): Leak {
  const [street, scenario, family, hero, villain, taken, best] = id.split("~");
  return {
    id,
    attrs: { street, scenario, family, hero, villain, taken, best },
    level: 0,
    partial: false,
    keys: [`${street}|${scenario}||${hero}|${taken}|${best}`],
    sets: {},
    situationKeys: [[street, scenario, family, hero, villain].join("~")],
    decisions: mistakes,
    mistakes,
    serious: mistakes,
    evLossBb,
    evLossPot: 0,
    spotDecisions,
    taken: { fold: 0, check: 0, call: 0, bet: 0, raise: 0 },
    best: { fold: 0, check: 0, call: 0, bet: 0, raise: 0 },
    per100: evLossBb,
    perSpot: evLossBb / spotDecisions,
    perMistake: evLossBb / mistakes,
    confidence: confidenceOf(spotDecisions, mistakes),
    ...extra,
  };
}

const A = "preflop~vs-open~vs-raise~BB~BTN~fold~call";
const B = "river~pfr-oop-first~first~CO~-~check~bet";
const C = "preflop~unopened~first-in~CO~-~fold~raise";
const D = "preflop~vs-3bet~vs-reraise~BTN~SB~fold~call";
const E = "river~caller-ip-vs-bet~vs-bet~BTN~-~call~fold";

/** A finest spot row (the key built the way `analysis_spot_key` builds it). */
function row(street: string, scenario: string, line: string, position: string, taken: string, best: string, decisions: number, nonPerfect: number, ev: number): SpotRow {
  return {
    key: [street, scenario, line, position, taken, best].join("|"),
    street,
    scenario,
    line,
    position,
    taken,
    best,
    decisions,
    hands: decisions,
    nonPerfect,
    mistakes: nonPerfect,
    evLossBb: ev,
    evLossPot: 0,
    scoreSum: 100 * (decisions - nonPerfect),
    scoreSq: 10000 * (decisions - nonPerfect),
  };
}

/* -------------------------------------------------------------- ranking - */

describe("which three", () => {
  it("is the study plan's rule: two mistakes before a thin leak can count", () => {
    expect(TOP_MIN_MISTAKES).toBe(TENTATIVE_MIN_MISTAKES);
    expect(TOP_LEAKS).toBe(3);
  });

  it("ranks by EV lost in total", () => {
    const ranked = rankTopLeaks([leak(A, 3, 40, 4), leak(B, 9, 30, 3), leak(C, 6, 60, 6), leak(D, 1, 25, 2)]);
    expect(ranked.map((entry) => entry.leak.id)).toEqual([B, C, A]);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(ranked.every((entry) => !entry.tentative)).toBe(true);
  });

  it("puts every leak the sample can vouch for before a costlier thin one", () => {
    // E: 30 bb but one spot of 6 decisions (low confidence); A, B and C are all sure.
    const ranked = rankTopLeaks([leak(E, 30, 6, 3), leak(A, 3, 40, 4), leak(B, 2, 30, 3), leak(C, 1, 20, 2)]);
    expect(ranked.map((entry) => entry.leak.id)).toEqual([A, B, C]);
  });

  it("fills an empty place with a thin leak of two mistakes or more, marked tentative", () => {
    const ranked = rankTopLeaks([leak(E, 30, 6, 3), leak(D, 50, 4, 1), leak(A, 3, 40, 4)]);
    expect(ranked.map((entry) => [entry.leak.id, entry.tentative, entry.rank])).toEqual([
      [A, false, 1],
      [E, true, 2],
    ]);
  });

  it("never lists a leak of one mistake, however costly", () => {
    expect(topEligible(leak(D, 50, 4, 1))).toBe(false);
    expect(topEligible(leak(E, 1, 6, 2))).toBe(true);
    expect(rankTopLeaks([leak(D, 50, 4, 1)])).toEqual([]);
  });

  it("breaks ties by the bigger sample, then more mistakes, then the id", () => {
    const tied = [leak(B, 5, 30, 3), leak(A, 5, 60, 6), leak(C, 5, 60, 8), leak(D, 5, 60, 8)];
    expect([...tied].sort(compareImportance).map((l) => l.id)).toEqual([C, D, A, B]);
    // The same in any input order.
    expect(rankTopLeaks([...tied].reverse()).map((entry) => entry.leak.id)).toEqual([C, D, A]);
  });

  it("works on the leak finder's own leaks: the same ids as the report", () => {
    const rows = [
      // BB vs a BTN open: 30 decisions, 6 folds where the charts call.
      row("preflop", "vs-open", "fffr", "BB", "fold", "call", 6, 6, 4.2),
      row("preflop", "vs-open", "fffr", "BB", "call", "call", 24, 0, 0),
      // River as the raiser out of position: 25 decisions, 5 checks where it bets.
      row("river", "pfr-oop-first", "", "CO", "check", "bet", 5, 5, 7.5),
      row("river", "pfr-oop-first", "", "CO", "bet", "bet", 20, 0, 0),
      // A thin spot with one blunder.
      row("preflop", "vs-4bet", "rrr", "CO", "fold", "call", 1, 1, 9),
    ];
    const leaks = groupLeaks(rows, { hands: 200 });
    const ranked = rankTopLeaks(leaks);
    expect(ranked.map((entry) => entry.leak.attrs.street)).toEqual(["river", "preflop"]);
    expect(ranked.map((entry) => entry.leak.id)).toEqual(leaks.filter(topEligible).map((l) => l.id).slice(0, 2));
    expect(ranked[0].leak.per100).toBeCloseTo(3.75, 6);
  });

  it("parses the period", () => {
    expect([parseTopPeriod("30d"), parseTopPeriod("all"), parseTopPeriod("7d"), parseTopPeriod(null)]).toEqual(["30d", "all", null, null]);
  });
});

/* ---------------------------------------------------------- uncertainty - */

describe("how sure", () => {
  it("is the Wilson interval of the mistake rate", () => {
    const half = wilson(5, 10)!;
    expect(half.low).toBeCloseTo(0.2366, 4);
    expect(half.high).toBeCloseTo(0.7634, 4);
    const none = wilson(0, 10)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 4);
    expect(wilson(0, 0)).toBeNull();
  });

  it("carries the interval to EV lost per 100 hands at the leak's cost per mistake", () => {
    const size = leakSize(leak(A, 4, 20, 5, { per100: 2 }))!;
    expect(size.rate).toBe(0.25);
    expect(size.per100).toBe(2);
    expect(size.per100Interval.low).toBeCloseTo((2 * size.rateInterval.low) / 0.25, 3);
    expect(size.per100Interval.high).toBeCloseTo((2 * size.rateInterval.high) / 0.25, 3);
    expect(size.per100Interval.low).toBeLessThan(2);
    expect(size.per100Interval.high).toBeGreaterThan(2);
    expect(leakSize(leak(A, 4, 0, 5))).toBeNull();
  });
});

/* -------------------------------------------------------------- was/now - */

describe("was / now", () => {
  const leaks = groupLeaks(
    [row("preflop", "vs-open", "fffr", "BB", "fold", "call", 6, 6, 4), row("preflop", "vs-open", "fffr", "BB", "call", "call", 24, 0, 0)],
    { hands: 100 },
  );
  const target = leaks[0];

  it("counts the leak's mistakes and every decision in its spots, per period", () => {
    const period = leakPeriod(target, [
      row("preflop", "vs-open", "fffr", "BB", "fold", "call", 2, 2, 1),
      row("preflop", "vs-open", "fffr", "BB", "call", "call", 18, 0, 0),
      row("river", "pfr-oop-first", "", "CO", "check", "bet", 5, 5, 3),
    ]);
    expect(period).toEqual({ spot: 20, mistakes: 2, evLossBb: 1, rate: 0.1 });
  });

  it("says better when the rate fell clearly, too few under 10 decisions", () => {
    const now = [row("preflop", "vs-open", "fffr", "BB", "fold", "call", 1, 1, 1), row("preflop", "vs-open", "fffr", "BB", "call", "call", 59, 0, 0)];
    const was = [row("preflop", "vs-open", "fffr", "BB", "fold", "call", 20, 20, 9), row("preflop", "vs-open", "fffr", "BB", "call", "call", 40, 0, 0)];
    const better = leakTrend(target, now, was);
    expect(better.trend).toBe("better");
    expect(better.now.rate).toBeCloseTo(1 / 60, 6);
    expect(better.was.rate).toBeCloseTo(1 / 3, 6);
    expect(leakTrend(target, now.slice(0, 1), was).trend).toBe("too-few");
    expect(leakTrend(target, [], []).trend).toBe("too-few");
  });
});

/* ------------------------------------------------------------- examples - */

describe("example hands", () => {
  const ex = (handId: string, ord: number, ev: number | null, spot = "vs-open|fffr|BB", playedAt = "2026-09-01T10:00:00Z"): ExampleCandidate => {
    const [scenario, line, position] = spot.split("|");
    return { handId, ord, playedAt, scenario, line, position, evLossBb: ev };
  };

  it("are the costliest, one per hand, at most five", () => {
    const picked = pickExamples([ex("a", 0, 1), ex("b", 0, 5), ex("a", 1, 3), ex("c", 0, 2), ex("d", 0, 4), ex("e", 0, 0.5), ex("f", 0, 0.1)]);
    expect(EXAMPLES_MAX).toBe(5);
    expect(picked.map((e) => `${e.handId}${e.ord}`)).toEqual(["b0", "d0", "a1", "c0", "e0"]);
  });

  it("show a merged leak's spread: the costliest of each finer spot first", () => {
    const picked = pickExamples(
      [ex("a", 0, 9), ex("b", 0, 8), ex("c", 0, 7), ex("d", 0, 6), ex("e", 0, 5, "vs-open|ffr|BB"), ex("f", 0, 0.2, "vs-open|r|BB")],
      3,
    );
    expect(picked.map((e) => e.handId)).toEqual(["a", "e", "f"]);
  });

  it("break equal costs by the newer hand, then the id", () => {
    const picked = pickExamples([
      ex("b", 0, 2, undefined, "2026-09-01T10:00:00Z"),
      ex("a", 0, 2, undefined, "2026-09-01T10:00:00Z"),
      ex("c", 0, 2, undefined, "2026-09-02T10:00:00Z"),
    ]);
    expect(picked.map((e) => e.handId)).toEqual(["c", "a", "b"]);
  });

  it("are empty without candidates", () => {
    expect(pickExamples([])).toEqual([]);
  });
});

/* ------------------------------------------------------- the web source - */

const PAYLOAD = {
  analysisVersion: "analysis/9",
  period: "30d",
  last: "2026-09-30",
  current: { from: "2026-09-01", to: "2026-09-30" },
  prior: { from: "2026-08-02", to: "2026-08-31" },
  sample: {
    hands: 200,
    graded: 230,
    rows: [
      { key: "preflop|vs-open|fffrf|BB|fold|call", set: "nlhe-cash-6max-100bb", street: "preflop", scenario: "vs-open", line: "fffrf", position: "BB", taken: "fold", best: "call", decisions: 6, hands: 6, nonPerfect: 6, mistakes: 5, evLossBb: "4.2", evLossPot: 0.3, scoreSum: 120, scoreSq: 2400 },
      { key: "preflop|vs-open|fffrf|BB|call|call", set: "nlhe-cash-6max-100bb", street: "preflop", scenario: "vs-open", line: "fffrf", position: "BB", taken: "call", best: "call", decisions: 24, hands: 24, nonPerfect: 0, mistakes: 0, evLossBb: 0, evLossPot: 0, scoreSum: 2400, scoreSq: 240000 },
      { key: "river|pfr-oop-first||CO|check|bet", set: null, street: "river", scenario: "pfr-oop-first", line: "", position: "CO", taken: "check", best: "bet", decisions: 5, hands: 5, nonPerfect: 5, mistakes: 5, evLossBb: 7.5, evLossPot: 1, scoreSum: 200, scoreSq: 9000 },
      { key: "river|pfr-oop-first||CO|bet|bet", set: null, street: "river", scenario: "pfr-oop-first", line: "", position: "CO", taken: "bet", best: "bet", decisions: 20, hands: 20, nonPerfect: 0, mistakes: 0, evLossBb: 0, evLossPot: 0, scoreSum: 2000, scoreSq: 200000 },
      { key: "river|caller-ip-vs-bet||BTN|call|fold", set: null, street: "river", scenario: "caller-ip-vs-bet", line: "", position: "BTN", taken: "call", best: "fold", decisions: 3, hands: 3, nonPerfect: 3, mistakes: 3, evLossBb: 6, evLossPot: 1, scoreSum: 90, scoreSq: 2700 },
    ],
  },
  now: { hands: 200, graded: 230, rows: [] as unknown[] },
  was: { hands: 0, graded: 0, rows: [] },
};
PAYLOAD.now.rows = PAYLOAD.sample.rows;

beforeEach(() => {
  rpc.mockReset();
});

describe("the web's source", () => {
  it("sends only the overview's filters and the version", () => {
    expect(
      topLeaksFilters({ analysisVersion: "analysis/2", gameFormat: "cash", position: "BB", potType: "3bet", from: "2026-01-01", site: "x", grade: "bad" }),
    ).toEqual({ analysisVersion: "analysis/2", gameFormat: "cash", position: "BB", potType: "3bet" });
    expect(topLeaksFilters({}).analysisVersion).toMatch(/^analysis\/\d+$/);
  });

  it("asks analysis_top_leaks for the period and reads its samples", async () => {
    rpc.mockResolvedValueOnce(PAYLOAD);
    const report = await fetchTopLeaks({ position: "BB" }, "30d");
    expect(rpc).toHaveBeenCalledWith("analysis_top_leaks", {
      p_filters: expect.objectContaining({ position: "BB" }),
      p_period: "30d",
    });
    expect(report?.current).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(report?.sample.rows[0]).toMatchObject({ set: "nlhe-cash-6max-100bb", evLossBb: 4.2, mistakes: 5 });
    expect(report?.sample.rows[2].set).toBeNull();
  });

  it("reads an empty account", () => {
    const report = topLeaksFromPayload({ analysisVersion: "analysis/9", period: "all", last: null, current: null, prior: null, sample: { hands: 0, graded: 0, rows: [] }, now: {}, was: {} }, "all");
    expect(report.last).toBeNull();
    expect(report.current).toBeNull();
    expect(report.sample).toEqual({ hands: 0, graded: 0, rows: [] });
  });

  it("asks analysis_leak_examples for the leaks' keys inside the window", async () => {
    rpc.mockResolvedValueOnce({ leaks: [{ id: "x", rows: [{ handId: "h1", ord: 0, actionIndex: 7, heroCards: ["Ah", 3], evLossBb: "1.5", grade: "mistake" }] }] });
    const map = await fetchLeakExamples({}, { leaks: [{ id: "x", keys: ["a"] }, { id: "y", keys: [] }], window: { from: "2026-09-01", to: "2026-09-30" }, limit: 15 });
    expect(rpc).toHaveBeenCalledWith("analysis_leak_examples", expect.objectContaining({
      p_from: "2026-09-01",
      p_to: "2026-09-30",
      p_leaks: [{ id: "x", keys: ["a"] }],
      p_limit: 15,
    }));
    expect(map.get("x")?.[0]).toMatchObject({ handId: "h1", actionIndex: 7, heroCards: ["Ah"], evLossBb: 1.5 });
    expect(examplesFromPayload(null).size).toBe(0);
  });

  it("does not call the server without a leak", async () => {
    expect((await fetchLeakExamples({}, { leaks: [], window: null, limit: 15 })).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------ the card - */

describe("the card", () => {
  const report = topLeaksFromPayload(PAYLOAD, "30d");
  const top = topOf(report);
  const examples = new Map([
    [
      top[0].leak.id,
      [
        { handId: "h-1", ord: 3, actionIndex: 12, playedAt: "2026-09-20T10:00:00Z", site: "pokerstars", stakesLabel: "$1/$2", position: "CO", heroCards: ["Ah", "Kd"], handClass: "AKo", street: "river", scenario: "pfr-oop-first", line: "", taken: "check", best: "bet", grade: "blunder", evLossBb: 3, evLossPot: 0.5 },
      ],
    ],
  ]);
  const render = (locale: "en" | "hr", rows = top) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale },
        createElement(TopLeaksBody, {
          report,
          top: rows,
          examples: { byLeak: examples, error: null },
          scope: { position: "CO" },
          backQuery: "pos=CO",
        }),
      ),
    );

  it("ranks the sample's leaks: the river leak, the BB fold, then the thin call marked tentative", () => {
    expect(top.map((entry) => [entry.leak.attrs.street, entry.tentative])).toEqual([
      ["river", false],
      ["preflop", false],
      ["river", true],
    ]);
  });

  it("names each leak in English with its size, how often, the target and was / now", () => {
    const html = render("en");
    expect(html).toContain("Checking instead of betting");
    expect(html).toContain("BB vs BTN open");
    expect(html).toContain("3.75 bb / 100 hands");
    expect(html).toContain("7.50 bb lost in all");
    expect(html).toContain("5 mistakes in 25 decisions here");
    expect(html).toContain("Target: Bet");
    expect(html).toContain("Tentative");
    expect(html).toContain("Last 30 days against the 30 before");
    expect(html).toContain("Too few to tell");
    expect(html).toContain("Your last 30 days of play");
  });

  it("opens an example hand at the decision, with the way back to the overview", () => {
    const html = render("en");
    expect(html).toContain('href="/analysis/h/h-1?t=a12&amp;pos=CO"');
    expect(html).toContain("−3.00 bb");
  });

  it("links each leak to its row in the report, over the same days and seat", () => {
    const html = render("en");
    const id = new URLSearchParams({ leak: top[0].leak.id }).toString();
    expect(html).toContain(`href="/analysis/leaks?from=2026-09-01&amp;to=2026-09-30&amp;pos=CO&amp;${id}"`);
    expect(html).toContain('href="/analysis/leaks?from=2026-09-01&amp;to=2026-09-30&amp;pos=CO"');
  });

  it("speaks Croatian", () => {
    const html = render("hr");
    expect(html).toContain("Checkaš umjesto da betaš");
    expect(html).toContain("3,75 bb / 100 ruku");
    expect(html).toContain("Okvirno");
    expect(html).toContain("Primjeri ruku");
  });

  it("says when no leak can be vouched for", () => {
    expect(render("en", [])).toContain(topLeaksEn.none);
    expect(render("hr", [])).toContain(topLeaksHr.none);
  });

  it("opens with its heading, the two periods (30 days pressed) and a loading line, in both languages", () => {
    for (const [locale, words] of [["en", topLeaksEn], ["hr", topLeaksHr]] as const) {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, { locale }, createElement(TopLeaks, { scopeKey: "{}", generation: 0, backQuery: "" })),
      );
      expect(html).toContain(words.heading);
      expect(html).toContain(`aria-pressed="true">${words.periods["30d"]}</button>`);
      expect(html).toContain(`aria-pressed="false">${words.periods.all}</button>`);
      expect(html).toContain(words.loading);
      expect(html).not.toMatch(/\bAI\b/); // the AI-written summary was declined: no stub
    }
  });

  it("has the same words in both languages", () => {
    expect(Object.keys(topLeaksHr).sort()).toEqual(Object.keys(topLeaksEn).sort());
  });
});
