/**
 * The Analytics screen (docs/ANALYTICS.md Steps 4 and 5):
 *
 * - **The view model** (`packages/ui/analytics/view.ts`): the tabs, the
 *   figures row's rates from the graph's end, the coded twins from the
 *   report, the filter the checker reads, the All stats rows (order, the
 *   off-target toggle, the band track) and a spot's fold / call / raise
 *   bars.
 * - **The done-when of Step 5**, over the checker's fixture
 *   (`core/rail-stats/tests/data/analytics/checker/cases.json`): the hero
 *   who over-folds the flop shows flop fold red with a cost; the "perfect"
 *   hero shows every row in range.
 * - **All stats rendered to markup** (React from the web's install), in
 *   English and Croatian: the words, the tones, the cost; a row opened to its
 *   spots; the Free plan's numbers with the lock and nothing judged.
 * - **The screen's tab row** over a report still loading.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AllStats } from "@rail/ui/analytics/AllStats";
import { FiguresRow } from "@rail/ui/analytics/FiguresRow";
import {
  ANALYTICS_VIEWS,
  allStatsItems,
  barOf,
  checkerFiltersOf,
  codedForChecker,
  codedOf,
  figuresOf,
  hasFigures,
  isAnalyticsView,
  siblingsOf,
  spotLines,
  trackOf,
  type AllStatsRow,
} from "@rail/ui/analytics/view";
import { EMPTY_FILTER } from "@rail/ui/hands/filter";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import type { Shown } from "@rail/ui/model/stats";
import type { Graph, Report, ReportSource } from "@rail/ui/reports/model";
import { ReportsScreen } from "@rail/ui/reports/ReportsScreen";
import { analyticsUiEn } from "@rail/ui/strings/analytics.en";
import { analyticsUiHr } from "@rail/ui/strings/analytics.hr";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { reportsUiEn } from "@rail/ui/strings/reports.en";
import { reportsUiHr } from "@rail/ui/strings/reports.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";

import { ANALYTICS } from "../../web/src/lib/stats/analytics.js";
import { checkStats, type CheckerResult, type CheckerSumsIn, type CodedIn } from "../../web/src/lib/stats/checker.js";

const ROOT = join(import.meta.dirname, "../..");
const CASES = JSON.parse(
  readFileSync(join(ROOT, "core/rail-stats/tests/data/analytics/checker/cases.json"), "utf8"),
) as { cases: { name: string; sums: CheckerSumsIn; coded: Record<string, CodedIn> }[] };

function result(name: string): CheckerResult {
  const found = CASES.cases.find((c) => c.name === name);
  if (!found) throw new Error(name);
  return checkStats(ANALYTICS, found.sums, found.coded);
}

function rowsOf(items: ReturnType<typeof allStatsItems>): AllStatsRow[] {
  return items.filter((item): item is AllStatsRow => item.kind === "stat");
}

function strings(locale: "en" | "hr"): UiStrings {
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    closeNamed: (what: string) => what,
    hands: locale === "en" ? handsUiEn : handsUiHr,
    reports: locale === "en" ? reportsUiEn : reportsUiHr,
    analytics: locale === "en" ? analyticsUiEn : analyticsUiHr,
    replayer: locale === "en" ? replayerEn : replayerHr,
  } as unknown as UiStrings;
}

function render(locale: "en" | "hr", node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node));
}

/** Markup's text, entities decoded the way the tests compare it. */
const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("the tabs", () => {
  it("are Overview, Streets, All stats, Pool and Breakdown; the figures row on the first three", () => {
    expect([...ANALYTICS_VIEWS]).toEqual(["overview", "streets", "stats", "pool", "breakdown"]);
    expect(ANALYTICS_VIEWS.filter(hasFigures)).toEqual(["overview", "streets", "stats"]);
    expect(isAnalyticsView("stats")).toBe(true);
    // A breakdown's split (the desktop's old `#/reports/position`) is not a view: the app opens Breakdown at it.
    expect(isAnalyticsView("position")).toBe(false);
    expect(isAnalyticsView(null)).toBe(false);
    for (const lang of [analyticsUiEn, analyticsUiHr]) {
      for (const view of ANALYTICS_VIEWS) expect(lang.screen.tabs[view]).toBeTruthy();
      for (const stat of ANALYTICS.stats) expect(lang.screen.stats.counts[stat.id], stat.id).toBeTruthy();
    }
  });
});

describe("the figures row", () => {
  const graph: Graph = {
    hands: 2000,
    moneyHands: 2000,
    allInEv: { allInHands: 40, pending: 0 },
    mixedUnitKind: false,
    mixedCurrency: false,
    buckets: [
      {
        bucket: 1,
        hands: 2000,
        moneyHands: 2000,
        cumMoneyHands: 2000,
        firstPlayedAt: null,
        lastPlayedAt: null,
        cumHands: 2000,
        cumNetBbMilli: 52_000,
        cumSdBbMilli: 196_000,
        cumNsdBbMilli: -144_000,
        cumEvBbMilli: 68_000,
        cumNet: 2600,
        cumSdNet: 9800,
        cumNsdNet: -7200,
        cumEvNet: 3400,
      },
    ],
  };

  it("are rates per 100 hands from the graph's end, in big blinds or in money", () => {
    expect(figuresOf(graph, 1990, "bb", 100)).toEqual({ hands: 2000, won: 2.6, allInEv: 3.4, showdown: 9.8, nonShowdown: -7.2 });
    expect(figuresOf(graph, 1990, "money", 100)).toEqual({ hands: 2000, won: 1.3, allInEv: 1.7, showdown: 4.9, nonShowdown: -3.6 });
    // No EV line: no EV figure; no money lines: none in money.
    expect(figuresOf({ ...graph, allInEv: null }, 0, "bb", null).allInEv).toBeNull();
    const bare = { ...graph, buckets: [{ ...graph.buckets[0], cumSdNet: undefined, cumNsdNet: undefined }] };
    expect(figuresOf(bare, 0, "money", 100)).toMatchObject({ won: 1.3, showdown: null, nonShowdown: null });
    expect(figuresOf({ ...graph, buckets: [] }, 5, "bb", null)).toEqual({
      hands: 2000,
      won: null,
      allInEv: null,
      showdown: null,
      nonShowdown: null,
    });
  });

  for (const locale of ["en", "hr"] as const) {
    it(`signed and coloured, the unit toggle with the currency, ${locale}`, () => {
      const report = {
        units: { mixedKind: false, mixedCurrency: false, currency: "USD", symbol: "$", minorUnits: 100 },
        summary: { hands: 2000, moneyHands: 2000, net: 2600, netBbMilli: 52_000, evNetBbMilli: 68_000, stats: [], ids: [] },
        graph,
      } as unknown as Report;
      const html = render(
        locale,
        createElement(FiguresRow, { report, unit: "bb", money: { minorUnits: 100, format: (x: number) => `$${x}` }, onUnit: () => undefined }),
      );
      const f = (locale === "en" ? analyticsUiEn : analyticsUiHr).screen.figures;
      expect(html).toContain(f.won);
      expect(html).toContain(f.nonShowdown);
      expect(html).toContain(locale === "en" ? "+2.6" : "+2,6");
      expect(html).toMatch(/class="[^"]*down[^"]*">[−-]7[.,]2/);
      expect(html).toContain("bb/100");
      expect(html).toContain(">$<");
      expect(html).toContain(f.hands(2000));
    });
  }
});

describe("the checker's inputs", () => {
  it("the coded twins from the report's values, and only the coded stats for the checker", () => {
    const shown = (value: number, sample: number) => ({ value, sample }) as unknown as Shown;
    const coded = codedOf(ANALYTICS, [shown(25, 1000), shown(28.88, 1800), shown(55, 0)], ["vpip", "wtsd", "cbet_flop"]);
    expect(coded).toEqual({ vpip: { made: 250, opp: 1000 }, wtsd: { made: 520, opp: 1800 }, cbet_flop: { made: 0, opp: 0 } });
    expect(codedForChecker(ANALYTICS, coded)).toEqual({ wtsd: { made: 520, opp: 1800 } });
  });

  it("the filter: dates, the kind or one format, one position, one pot type; anything else is partial", () => {
    expect(checkerFiltersOf({ formats: ["cash"], from: "2026-01-01T00:00:00Z", positions: ["BTN"], potTypes: ["3bet"] })).toEqual({
      filters: { from: "2026-01-01T00:00:00Z", gameFormat: "cash", position: "BTN", potType: "3bet" },
      partial: false,
    });
    expect(checkerFiltersOf({ formats: ["tournament", "sng", "spin"], sites: [], tags: [], allIn: null })).toEqual({
      filters: { gameKind: "tournament" },
      partial: false,
    });
    expect(checkerFiltersOf({ positions: ["BTN", "CO"] }).partial).toBe(true);
    expect(checkerFiltersOf({ sites: ["pokerstars"] }).partial).toBe(true);
    expect(checkerFiltersOf({ stacks: ["0-40"] }).partial).toBe(true);
    expect(checkerFiltersOf({ utcOffsetMinutes: 60 }).partial).toBe(false);
  });
});

describe("All stats rows", () => {
  it("the hero who over-folds the flop: flop fold red (far) with a cost, among the costliest", () => {
    const res = result("overfolder");
    const rows = rowsOf(allStatsItems(ANALYTICS, res, {}, "street", "all"));
    const flop = rows.find((row) => row.stat.id === "flop_fold_vs_bet");
    expect(flop?.tone).toBe("far");
    expect(flop?.cost).toBeGreaterThan(0.05);
    expect(flop?.track?.dot).toBeGreaterThan((flop?.track?.bandLeft ?? 0) + (flop?.track?.bandWidth ?? 0));
    const byCost = rowsOf(allStatsItems(ANALYTICS, res, {}, "cost", "all"));
    // The flop and the turn folds lead (the fixture's two leaks), costliest first.
    expect(byCost.slice(0, 2).map((row) => row.stat.id).sort()).toEqual(["flop_fold_vs_bet", "turn_fold_vs_bet"]);
    expect(byCost.map((row) => row.cost)).toEqual([...byCost.map((row) => row.cost)].sort((a, b) => b - a));
    const off = rowsOf(allStatsItems(ANALYTICS, res, {}, "street", "off"));
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((row) => row.tone === "off" || row.tone === "far")).toBe(true);
    expect(off.map((row) => row.stat.id)).toContain("turn_fold_vs_bet");
  });

  it("the perfect hero: every row with a target in range, nothing off, no cost", () => {
    const res = result("perfect");
    const rows = rowsOf(allStatsItems(ANALYTICS, res, {}, "street", "all"));
    const judged = rows.filter((row) => row.stat.kind !== "coded");
    expect(judged.length).toBe(ANALYTICS.stats.filter((stat) => stat.kind !== "coded").length);
    for (const row of judged) expect([row.stat.id, row.tone]).toEqual([row.stat.id, "ok"]);
    expect(rows.every((row) => row.cost === 0)).toBe(true);
    expect(allStatsItems(ANALYTICS, res, {}, "street", "off")).toEqual([]);
  });

  it("grouped by street in catalogue order, a head before each street", () => {
    const items = allStatsItems(ANALYTICS, result("perfect"), {}, "street", "all");
    const heads = items.filter((item) => item.kind === "street").map((item) => (item.kind === "street" ? item.street : ""));
    expect(heads).toEqual(["preflop", "flop", "turn", "river", "showdown"]);
    expect(rowsOf(items).map((row) => row.stat.id)).toEqual(ANALYTICS.stats.map((stat) => stat.id));
  });

  it("no checker (the Free plan): the coded twins' numbers, no target, no tone, no cost", () => {
    const rows = rowsOf(allStatsItems(ANALYTICS, null, { vpip: { made: 250, opp: 1000 }, wtsd: { made: 9, opp: 30 } }, "street", "all"));
    const vpip = rows.find((row) => row.stat.id === "vpip");
    expect(vpip).toMatchObject({ player: 25, fromRollups: true, tone: "none", track: null, n: 1000, cost: 0 });
    expect(rows.find((row) => row.stat.id === "flop_fold_vs_bet")).toMatchObject({ player: null, tone: "none", n: 0 });
  });

  it("the track: the band centred, the dot clamped, at least ±3 points wide", () => {
    expect(trackOf(null, 40, 30)).toBeNull();
    const t = trackOf(33, 38, 35.5);
    expect(t?.dot).toBeCloseTo(50, 6);
    expect((t?.bandLeft ?? 0) + (t?.bandWidth ?? 0) / 2).toBeCloseTo(50, 6);
    expect(trackOf(33, 38, 90)?.dot).toBeLessThanOrEqual(98);
    const thin = trackOf(10, 10, 10);
    expect(thin?.bandWidth).toBe(0);
  });
});

describe("a spot's bars", () => {
  it("fold and raise of the same decisions make fold / call / raise; one alone leaves the rest unnamed", () => {
    const flopFold = ANALYTICS.get("flop_fold_vs_bet");
    if (!flopFold) throw new Error("flop_fold_vs_bet");
    expect(siblingsOf(ANALYTICS, flopFold).map((stat) => stat.id)).toEqual(["flop_fold_vs_bet", "flop_raise_vs_bet"]);
    expect(barOf(new Map([["fold", 52], ["raise", 9]]))).toEqual([
      { action: "fold", value: 52 },
      { action: "call", value: 39 },
      { action: "raise", value: 9 },
    ]);
    expect(barOf(new Map([["fold", 40]]))).toEqual([
      { action: "fold", value: 40 },
      { action: "rest", value: 60 },
    ]);
    expect(barOf(new Map([["bet", 55]]))).toEqual([
      { action: "bet", value: 55 },
      { action: "rest", value: 45 },
    ]);
    expect(barOf(new Map([["vpip", 25], ["pfr", 20]]))).toEqual([
      { action: "fold", value: 75 },
      { action: "call", value: 5 },
      { action: "raise", value: 20 },
    ]);
    expect(barOf(new Map([["fold", null]]))).toBeNull();
  });

  it("the over-folder's flop spots: the player folds more than the target in each, every bar whole", () => {
    const lines = spotLines(ANALYTICS, result("overfolder"), "flop_fold_vs_bet");
    expect(lines.length).toBe(4);
    for (const line of lines) {
      for (const bar of [line.you, line.target]) {
        expect(bar?.map((part) => part.action)).toEqual(["fold", "call", "raise"]);
        expect(bar?.reduce((sum, part) => sum + part.value, 0)).toBeCloseTo(100, 6);
      }
      expect(line.you?.[0].value).toBeGreaterThan(line.target?.[0].value ?? 100);
    }
    expect(spotLines(ANALYTICS, result("overfolder"), "wtsd")).toEqual([]);
  });
});

describe("All stats rendered", () => {
  for (const locale of ["en", "hr"] as const) {
    const words = locale === "en" ? analyticsUiEn : analyticsUiHr;

    it(`the over-folder: flop fold red with its words and cost, ${locale}`, () => {
      const res = result("overfolder");
      const html = text(
        render(locale, createElement(AllStats, { catalogue: ANALYTICS, result: res, coded: {}, order: "street", show: "all" })),
      );
      const flop = res.stats.find((stat) => stat.id === "flop_fold_vs_bet");
      const flopWords = ANALYTICS.get("flop_fold_vs_bet")?.words.high[words.lang] ?? "";
      expect(html).toContain(flopWords);
      // The row's gap and number in the far (red) tone, its cost as a loss.
      expect(html).toMatch(new RegExp(`class="[^"]*far[^"]*">${flopWords}`));
      const cost = (flop?.cost ?? 0).toFixed(1).replace(".", locale === "en" ? "." : ",");
      expect(html).toContain(`−${cost}`);
      // The hover: what it counts, where the target comes from.
      expect(html).toContain(`title="${words.screen.stats.counts.flop_fold_vs_bet}\n${words.screen.stats.targetFrom.solver}"`);
      expect(html).toContain(words.checker.streets.flop);
      expect(html).toContain(words.screen.stats.heads.track);
    });

    it(`the perfect hero: in range on every judged row, no cost, ${locale}`, () => {
      const html = text(
        render(locale, createElement(AllStats, { catalogue: ANALYTICS, result: result("perfect"), coded: {}, order: "street", show: "all" })),
      );
      const inRange = html.split(words.checker.inRange).length - 1;
      expect(inRange).toBe(ANALYTICS.stats.filter((stat) => stat.kind !== "coded").length);
      expect(html).not.toContain("−");
      const off = render(
        locale,
        createElement(AllStats, { catalogue: ANALYTICS, result: result("perfect"), coded: {}, order: "street", show: "off" }),
      );
      expect(text(off)).toContain(words.screen.stats.noneOff);
    });

    it(`the Free plan: the player's numbers and the lock, nothing judged, ${locale}`, () => {
      const html = text(
        render(
          locale,
          createElement(AllStats, {
            catalogue: ANALYTICS,
            result: result("overfolder"),
            coded: { vpip: { made: 250, opp: 1000 } },
            order: "street",
            show: "all",
            lock: createElement("p", { "data-lock": "analysis" }, "Pro"),
          }),
        ),
      );
      expect(html).toContain('data-lock="analysis"');
      expect(html).toContain(words.checker.percent("25"));
      expect(html).not.toContain(words.checker.inRange);
      expect(html).not.toContain(ANALYTICS.get("flop_fold_vs_bet")?.words.high[words.lang] ?? "?");
      expect(html).not.toContain("aria-expanded");
    });

    it(`loading, failing and partial, ${locale}`, () => {
      const base = { catalogue: ANALYTICS, coded: {}, order: "street" as const, show: "all" as const };
      expect(text(render(locale, createElement(AllStats, { ...base, result: null, loading: true })))).toContain(words.screen.stats.loading);
      expect(text(render(locale, createElement(AllStats, { ...base, result: null, error: "boom" })))).toContain(words.screen.stats.error("boom"));
      const partial = render(locale, createElement(AllStats, { ...base, result: result("perfect"), partial: true }));
      expect(text(partial)).toContain(words.screen.stats.partial);
      const pending = { ...result("perfect"), pending: 3 };
      expect(text(render(locale, createElement(AllStats, { ...base, result: pending })))).toContain(words.screen.stats.pending);
    });
  }
});

describe("the screen's tab row", () => {
  const source: ReportSource = {
    report: () => new Promise(() => undefined),
    breakdowns: () => new Promise(() => undefined),
    facets: () => new Promise(() => undefined),
    graphPoints: 1200,
    filters: { annotations: true, search: true, sorts: [], more: [], builder: true },
  };
  for (const locale of ["en", "hr"] as const) {
    it(`every tab, the chosen one selected, All stats' controls on its tab, ${locale}`, () => {
      const words = locale === "en" ? analyticsUiEn : analyticsUiHr;
      const props = {
        source,
        definitions: [],
        chosen: { ...EMPTY_FILTER, formats: ["cash"] },
        onChoose: () => undefined,
        onView: () => undefined,
        tab: "position" as const,
        onTab: () => undefined,
        title: words.screen.tabsLabel,
        emptyText: "No hands",
        renderState: (kind: string, label: string) => createElement("p", { "data-state": kind }, label),
      };
      const stats = text(render(locale, createElement(ReportsScreen, { ...props, view: "stats" })));
      for (const view of ANALYTICS_VIEWS) expect(stats).toContain(`>${words.screen.tabs[view]}<`);
      expect(stats).toMatch(new RegExp(`aria-selected="true"[^>]*>${words.screen.tabs.stats}<`));
      expect(stats).toContain(words.screen.stats.byCost);
      expect(stats).toContain(words.screen.stats.off);
      const overview = text(render(locale, createElement(ReportsScreen, { ...props, view: "overview" })));
      expect(overview).not.toContain(words.screen.stats.byCost);
      expect(overview).toContain('data-state="loading"');
    });
  }
});
