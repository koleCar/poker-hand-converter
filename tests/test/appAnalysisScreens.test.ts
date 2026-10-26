/**
 * The desktop app's analysis screens (docs/RAIL-PLAN.md R5.4): the
 * address of each view, the background run's line, one hand's grades in
 * English and Croatian (a real corpus hand analysed by the web's library),
 * and the app's sources for the shared session review and charts screens
 * against faked commands (`test/support/tauriCore.ts`). A10's gate on the
 * route and on the way in from Hands is `appDuringPlay.test.ts`'.
 */
import "./support/appWindow";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import type { RunnerStatus } from "../../app/src/analysis/runner";
import { en } from "../../app/src/i18n/en";
import { hr } from "../../app/src/i18n/hr";
import { DictProvider } from "../../app/src/i18n/index";
import { storeChartsSource } from "../../app/src/lib/chartsSource";
import { fetchTopLeaks, spotRow, topOf } from "../../app/src/lib/leaksSource";
import { reviewHand, storeReviewSource, storeSessionChartsSource } from "../../app/src/lib/reviewSource";
import { HandAnalysisView, type Loaded } from "../../app/src/screens/analysis/HandAnalysis";
import { TopLeaksBody } from "../../app/src/screens/analysis/TopLeaks";
import { describeStatus } from "../../app/src/screens/analysis/status";
import { parseView, tabOf, viewParam, type AnalysisView } from "../../app/src/screens/analysis/view";
import { ANALYSIS_VERSION, analyzeHand, type HandAnalysis } from "../../frontend/src/lib/analysis/index";
import { loadCharts } from "../../frontend/src/lib/charts/index";
import { convertAny } from "../../frontend/src/lib/parsers/index";
import { newChartSet } from "../../packages/ui/charts/model";
import { topLeaksEn } from "../../frontend/src/lib/i18n/ns/analysisLeaks.en";
import { topLeaksHr } from "../../frontend/src/lib/i18n/ns/analysisLeaks.hr";
import { screenHref } from "../../app/src/lib/router";
import { setInvokeHandler } from "./support/tauriCore";

const ROOT = join(import.meta.dirname, "../..");

describe("the analysis' views in the address", () => {
  it("round-trip, and anything else is the session review", () => {
    const views: AnalysisView[] = [
      { kind: "session", at: null, gap: 30 },
      { kind: "session", at: "2026-02-20T21:15:00.000Z", gap: 60 },
      { kind: "charts", set: null, view: "edit", situation: null, period: null },
      { kind: "charts", set: "c-0123", view: "compare", situation: "vs-open:BB:BTN", period: "365d" },
      { kind: "hand", key: "pokerstars:123/4?x=1", actionIndex: 7, back: "session?at=2026-02-20T21%3A15%3A00.000Z" },
      { kind: "hand", key: "k", actionIndex: null, back: null },
    ];
    for (const view of views) expect(parseView(viewParam(view))).toEqual(view);
    expect(viewParam({ kind: "session", at: null, gap: 30 })).toBe("session");
    expect(parseView(null)).toEqual({ kind: "session", at: null, gap: 30 });
    expect(parseView("nonsense?gap=7")).toEqual({ kind: "session", at: null, gap: 30 });
    expect(parseView("hand")).toEqual({ kind: "session", at: null, gap: 30 });
    expect(parseView("charts?period=10y").kind === "charts" && parseView("charts?period=10y")).toMatchObject({ period: null });
    // A hand belongs to the tab it was opened from.
    expect(tabOf(parseView(viewParam({ kind: "hand", key: "k", actionIndex: 1, back: "charts?view=compare" })))).toBe("charts");
    expect(tabOf(parseView(viewParam({ kind: "hand", key: "k", actionIndex: 1, back: null })))).toBe("session");
  });
});

describe("the background run's line", () => {
  const base: RunnerStatus = {
    phase: "running",
    reason: null,
    paused: false,
    counts: { hands: 1204, current: 300, stale: 0, missing: 904, offline: 0, notAnalysable: 2 },
    analysed: 300,
    failed: 0,
    handsPerSecond: 2.4,
    library: true,
    lastError: null,
    version: "analysis/34",
  };
  const lines = (status: RunnerStatus, dict: typeof en) =>
    describeStatus(status, dict.analysis.status, (n) => String(n)).map((l) => (l.warn ? `!${l.text}` : l.text));

  it("says how far it is and why it waits, in both languages", () => {
    expect(lines(base, en)).toEqual([
      "Analysing your hands: 300 of 1,204 hands done.",
      "2.4 hands a second",
      "2 hands cannot be analysed (another game, or no hero).",
    ]);
    expect(lines(base, hr as typeof en)[0]).toBe("Analiziram tvoje ruke: gotovo 300 od 1.204 ruke.");
    expect(lines({ ...base, phase: "waiting", reason: "tables" }, en)[0]).toBe("The analysis waits while a poker table is open.");
    expect(lines({ ...base, phase: "waiting", reason: "paused", paused: true }, hr as typeof en)[0]).toBe("Analiza je pauzirana.");
    expect(lines({ ...base, phase: "idle", counts: { ...base.counts!, current: 1204, missing: 0, notAnalysable: 0 } }, en)).toEqual([
      "Every hand is analysed (1,204 hands).",
    ]);
    expect(lines({ ...base, phase: "starting", counts: null }, en)).toEqual(["The analysis starts shortly after Rail opens."]);
    expect(lines({ ...base, library: false }, en).at(-1)).toMatch(/^!The flop library cannot be reached/);
    expect(lines({ ...base, phase: "error", lastError: "boom" }, en).at(-1)).toBe("!The last page did not finish: boom");
  });
});

/** A corpus hand the web's library grades preflop. */
async function gradedHand(): Promise<HandAnalysis> {
  const charts = loadCharts(JSON.parse(readFileSync(join(ROOT, "frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")));
  for (const dir of ["fixtures/samples/pokerstars", "fixtures/samples/ggpoker", "gg-hh"]) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (!name.endsWith(".txt")) continue;
      const text = readFileSync(join(ROOT, dir, name), "utf8");
      const { hands } = await convertAny(text, { sourceFilename: name }).catch(() => ({ hands: [] }));
      for (const hand of hands) {
        const analysis = analyzeHand(hand, { charts, turn: false });
        if (analysis.decisions.some((d) => d.grade !== null && d.options.length > 0)) return analysis;
      }
    }
  }
  throw new Error("no graded corpus hand");
}

function render(locale: "en" | "hr", loaded: Loaded, actionIndex: number | null = null): string {
  return renderToStaticMarkup(
    createElement(DictProvider, { locale }, createElement(HandAnalysisView, { handKey: "pokerstars:1", actionIndex, back: "session", loaded })),
  );
}

describe("one hand's grades", () => {
  it("lists every decision with its grade, the best action and the reference's options, in English and Croatian", async () => {
    const analysis = await gradedHand();
    const graded = analysis.decisions.find((d) => d.grade !== null && d.options.length > 0);
    expect(graded).toBeDefined();
    for (const [locale, dict] of [
      ["en", en],
      ["hr", hr],
    ] as const) {
      const html = render(locale, { status: "ready", analysis, stored: true }, graded?.actionIndex ?? null);
      expect(html).toContain(dict.analysis.hand.title);
      expect(html).toContain(dict.analysis.hand.decisions);
      expect(html).toContain(dict.analysis.hand.backToList);
      expect(html).toContain(dict.analysis.hand.back);
      expect(html.match(/data-action-index=/g)?.length).toBe(analysis.decisions.length);
      if (graded?.grade) expect(html).toContain(dict.analysis.hand.grades[graded.grade]);
      expect(html).toContain(dict.analysis.hand.options);
      // The decision the list named is open; the stored row needs no note.
      expect(html).toMatch(/<details[^>]*open/);
      expect(html).not.toContain(dict.analysis.hand.notStored);
    }
    expect(render("en", { status: "ready", analysis, stored: false })).toContain(en.analysis.hand.notStored);
  });

  it("says when the hand is missing, being analysed or could not be", () => {
    expect(render("en", { status: "loading" })).toContain(en.analysis.hand.loading);
    expect(render("hr", { status: "missing" })).toContain(hr.analysis.hand.notFound);
    expect(render("en", { status: "error", message: "no charts" })).toContain(en.analysis.hand.failed("no charts"));
  });
});

describe("the app's sources for the shared screens", () => {
  let calls: { command: string; args: Record<string, unknown> }[] = [];
  let answers: Record<string, unknown> = {};
  beforeEach(() => {
    calls = [];
    answers = {};
    setInvokeHandler((command, args) => {
      calls.push({ command, args });
      if (!(command in answers)) throw new Error(`unexpected ${command}`);
      const answer = answers[command];
      return typeof answer === "function" ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer;
    });
  });

  const storeHand = {
    handId: "k1",
    playedAt: "2026-02-20T21:15:00.000Z",
    site: "pokerstars",
    stakesLabel: null,
    smallBlind: 50,
    gameFormat: "cash",
    currency: "USD",
    currencySymbol: "$",
    minorUnits: 100,
    bigBlind: 100,
    tableName: "Halley",
    position: "BTN",
    heroCards: ["As", "Kd"],
    handClass: "AKo",
    board: [],
    potType: "single-raised",
    potBb: 6.5,
    net: 250,
    netBbMilli: 2500,
    evNetBbMilli: null,
    grade: "mistake",
    evLossBb: 1.25,
  };

  it("reads a session review with its hands' stakes written, and the picker's window", async () => {
    expect(reviewHand(storeHand)).toMatchObject({ handId: "k1", stakesLabel: "$0.50/$1" });
    expect("smallBlind" in reviewHand(storeHand)).toBe(false);
    answers.session_review = { gapMinutes: 30, session: null, ongoing: null, coverage: { hands: 0, analysed: 0, graded: 0, notAnalysed: 0 }, worst: [], chartDeviations: [], pots: [], hands: { k1: storeHand } };
    const review = await storeReviewSource.review({ at: "2026-02-20T21:00:00.000Z", gapMinutes: 60, filter: {} as never }, 20);
    expect(review.hands.k1.stakesLabel).toBe("$0.50/$1");
    expect(calls[0]).toMatchObject({ command: "session_review", args: { version: ANALYSIS_VERSION, at: "2026-02-20T21:00:00.000Z", gapMinutes: 60, limit: 20 } });

    const item = (n: number) => ({ startedAt: `2026-0${n}-01T00:00:00.000Z`, endedAt: `2026-0${n}-01T01:00:00.000Z`, hands: 10, tables: 1, netBbMilli: 0 });
    answers.review_sessions = (args: Record<string, unknown>) => (args.since === null ? [item(1), item(2)] : [item(3)]);
    calls = [];
    // One session in the last 90 days: the whole history instead.
    expect(await storeReviewSource.sessions({ at: null, gapMinutes: 30, filter: {} as never })).toHaveLength(2);
    expect(calls.map((c) => c.args.since === null)).toEqual([false, true]);
    answers.review_sessions = () => [item(5), item(4), item(3)];
    // Two or more: the window's oldest left out (it may begin before it).
    expect(await storeReviewSource.sessions({ at: null, gapMinutes: 30, filter: {} as never })).toEqual([item(5), item(4)]);
  });

  it("reads a session's preflop decisions for an own chart", async () => {
    answers.session_preflop = [
      { handId: "k1", ord: 0, actionIndex: 4, playedAt: "2026-02-20T21:15:00.000Z", key: "vs-open:BB:BTN", cls: 21, action: "call", scenario: "vs-open", position: "BB", gameFormat: "cash", tableSize: 6, depthBandBb: 100, evLossBb: 0.5 },
      { handId: "k2", ord: 1, actionIndex: 6, playedAt: "", key: "", cls: 3, action: "raise", scenario: "", position: null, gameFormat: "", tableSize: 7, depthBandBb: null, evLossBb: null },
    ];
    const decisions = await storeSessionChartsSource.sessionDecisions({ startedAt: "a", endedAt: "b" }, { at: null, gapMinutes: 30, filter: {} as never });
    expect(decisions[0]).toMatchObject({ key: "vs-open:BB:BTN", tableSize: 6, depthBandBb: 100 });
    expect(decisions[1]).toMatchObject({ playedAt: null, scenario: null, gameFormat: null, tableSize: null });
    answers.review_hands = { k1: storeHand };
    expect((await storeSessionChartsSource.hands(["k1"], { at: null, gapMinutes: 30, filter: {} as never })).k1.stakesLabel).toBe("$0.50/$1");
  });

  it("keeps the user's charts in the store and compares them with the hands played", async () => {
    answers.chart_sets_list = [{ id: "c-1", name: "Mine", gameFormat: "cash", tableSize: 6, stackMinBb: 80, stackMaxBb: 120, nodes: 2, updatedAt: Date.UTC(2026, 9, 23) }];
    expect(await storeChartsSource.list()).toEqual([
      { id: "c-1", name: "Mine", gameFormat: "cash", tableSize: 6, stackMinBb: 80, stackMaxBb: 120, nodes: 2, updatedAt: "2026-10-23T00:00:00.000Z" },
    ]);
    const set = newChartSet({ name: "Mine" });
    answers.chart_set_save = { id: "c-1", updatedAt: "2026-10-23T00:00:00.000Z" };
    expect(await storeChartsSource.save(set)).toEqual({ id: "c-1", updatedAt: "2026-10-23T00:00:00.000Z" });
    expect(calls.at(-1)?.args.set).toMatchObject({ id: null, name: "Mine", game_format: "cash", table_size: 6, format_version: 1, nodes: {} });
    answers.chart_set_load = { id: "c-1", name: "Mine", game_format: "cash", table_size: 6, stack_min_bb: 80, stack_max_bb: 120, format_version: 1, nodes: {}, updated_at: "2026-10-23T00:00:00.000Z" };
    expect(await storeChartsSource.load("c-1")).toMatchObject({ id: "c-1", name: "Mine", tableSize: 6 });
    answers.chart_set_load = null;
    await expect(storeChartsSource.load("gone")).rejects.toThrow("not-found");
    expect(storeChartsSource.shippedSets().some((s) => s.id === "nlhe-cash-6max-100bb" && s.tableSize === 6 && s.depthBb === 100)).toBe(true);
    expect(storeChartsSource.shippedSets().some((s) => s.id.endsWith("-straddle"))).toBe(false);

    answers.chart_played = { from: "2026-07-26", to: "2026-10-23", cells: [{ key: "vs-open:BB:BTN", cls: 21, action: "call", decisions: 4, evLossBb: 1.5 }] };
    const query = { period: "90d", gameFormat: "cash", tableSize: 6, stackMinBb: 80, stackMaxBb: 120 } as const;
    expect(await storeChartsSource.played(query)).toEqual({
      analysisVersion: ANALYSIS_VERSION,
      from: "2026-07-26",
      to: "2026-10-23",
      cells: [{ key: "vs-open:BB:BTN", cls: 21, action: "call", decisions: 4, evLossBb: 1.5 }],
    });
    expect(calls.at(-1)?.args).toEqual({ version: ANALYSIS_VERSION, query });
    answers.chart_examples = [
      { handId: "k1", actionIndex: 4, playedAt: "2026-10-23T10:00:00.000Z", heroCards: ["Ah", "9h"], site: "pokerstars", currency: "EUR", currencySymbol: "€", minorUnits: 100, smallBlind: 5, bigBlind: 10, evLossBb: 0.25 },
    ];
    expect(await storeChartsSource.examples(query, "vs-open:BB:BTN", 21, "call", 5)).toEqual([
      { handId: "k1", actionIndex: 4, playedAt: "2026-10-23T10:00:00.000Z", heroCards: ["Ah", "9h"], stakesLabel: "€0.05/€0.10", site: "pokerstars", evLossBb: 0.25 },
    ]);
  });
});

describe("the top three leaks", () => {
  const spot = (key: string, decisions: number, mistakes: number, ev: number) => ({
    key,
    set: key.startsWith("preflop") ? "nlhe-cash-6max-100bb" : null,
    decisions,
    nonPerfect: mistakes + 2,
    mistakes,
    evLossBb: ev,
    evLossPot: ev / 10,
    scoreSum: decisions * 80.123456,
    scoreSq: decisions * 6500.987654,
  });
  const sample = {
    hands: 120,
    graded: 66,
    rows: [
      spot("preflop|vs-open|fffrf|BB|fold|call", 30, 8, 4.12345),
      spot("flop|ip-pfr||BTN|check|bet", 24, 5, 2.0004999),
      spot("river|oop-caller||BB|call|fold", 12, 1, 0.9),
    ],
  };
  const dto = {
    last: "2026-10-23",
    current: { from: "2026-09-24", to: "2026-10-23" },
    prior: { from: "2026-08-25", to: "2026-09-23" },
    sample,
    now: sample,
    was: { hands: 40, graded: 20, rows: [spot("preflop|vs-open|fffrf|BB|fold|call", 20, 2, 1)] },
  };

  it("reads the store's sums as the web's rows, rounded as its numeric sums, and ranks them with the web's rule", async () => {
    const asked: Record<string, unknown>[] = [];
    setInvokeHandler((command, args) => {
      asked.push({ command, ...args });
      return command === "top_leaks" ? dto : [];
    });
    const report = await fetchTopLeaks({}, "30d");
    expect(asked[0]).toEqual({ command: "top_leaks", version: ANALYSIS_VERSION, filters: {}, period: "30d" });
    const row = spotRow(sample.rows[0]);
    expect(row).toMatchObject({ street: "preflop", scenario: "vs-open", line: "fffrf", position: "BB", taken: "fold", best: "call", hands: 30 });
    expect([row.evLossBb, spotRow(sample.rows[1]).evLossBb, row.scoreSum]).toEqual([4.123, 2, 2403.7]);
    const top = topOf(report);
    // The web's own rule ranks them: the costliest sure leak first, at most three.
    expect(top[0].leak.attrs.street).toBe("preflop");
    expect(top.length).toBeLessThanOrEqual(3);
    expect(top[0].trend.now.spot).toBe(30);
  });

  it("renders the card in English and Croatian, each example opening the hand at the decision", async () => {
    setInvokeHandler((command) => (command === "top_leaks" ? dto : []));
    const report = await fetchTopLeaks({}, "30d");
    const top = topOf(report);
    const example = {
      handId: "pokerstars:9",
      ord: 0,
      actionIndex: 7,
      playedAt: "2026-10-20T20:00:00.000Z",
      site: "pokerstars",
      stakesLabel: "$0.50/$1",
      position: "BB",
      heroCards: ["Kd", "Qd"],
      handClass: "KQs",
      street: "preflop",
      scenario: "vs-open",
      line: "fffrf",
      taken: "fold",
      best: "call",
      grade: "mistake",
      evLossBb: 1.25,
      evLossPot: 0.2,
    };
    for (const [locale, words, dict] of [
      ["en", topLeaksEn, en],
      ["hr", topLeaksHr, hr],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(
          DictProvider,
          { locale },
          createElement(TopLeaksBody, { report, top, examples: new Map([[top[0].leak.id, [example]]]), period: "30d" }),
        ),
      );
      expect(html).toContain(words.sample(66, 120));
      expect(html).toContain(words.rank(1));
      expect(html).toContain(words.rank(2));
      expect(html).toContain(words.examples);
      expect(html).toContain(dict.analysis.hand.grades.mistake);
      expect(html).toContain(screenHref("analysis", viewParam({ kind: "hand", key: "pokerstars:9", actionIndex: 7, back: "leaks" })).replace(/&/g, "&amp;"));
      expect(html).not.toContain(words.allLeaks);
    }
  });
});
