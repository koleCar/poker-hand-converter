/**
 * The Analytics screen's Streets and Overview tabs (docs/ANALYTICS.md Steps
 * 6 and 7), over the checker's fixture
 * (`core/rail-stats/tests/data/analytics/checker/cases.json`):
 *
 * - **Streets' view model** (`streetColumns`): four columns of the
 *   catalogue's groups, a block's fold / call / raise (or one action) for
 *   the player over the target, its words, its cost without counting the
 *   same decisions twice; the Free plan's bars from the rollups.
 * - **Overview's view model** (`overviewOf`, `practiseQuery`): the three
 *   costliest findings, the stats in range, "nothing clearly off", and the
 *   Trainer's query.
 * - **Both rendered to markup** in English and Croatian: the over-folder,
 *   the perfect hero, the Free plan's lock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { findingHeadline, findingWhy, gapText } from "@rail/ui/analytics/findings";
import { Overview } from "@rail/ui/analytics/Overview";
import { Streets } from "@rail/ui/analytics/Streets";
import {
  STREET_COLUMNS,
  blockStats,
  firstOpenBlock,
  overviewOf,
  practiseQuery,
  streetColumns,
  type BarPart,
  type StreetBlock,
} from "@rail/ui/analytics/view";
import { EMPTY_FILTER } from "@rail/ui/hands/filter";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import type { ReportSource } from "@rail/ui/reports/model";
import { AnalyticsScreen } from "@rail/ui/analytics/AnalyticsScreen";
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

const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function block(columns: ReturnType<typeof streetColumns>, id: string): StreetBlock {
  const found = columns.flatMap((column) => column.blocks).find((entry) => entry.group.id === id);
  if (!found) throw new Error(id);
  return found;
}

const part = (parts: BarPart[] | null, action: BarPart["action"]) => parts?.find((entry) => entry.action === action)?.value;
const whole = (parts: BarPart[] | null) => (parts ?? []).reduce((sum, entry) => sum + entry.value, 0);
const costOf = (res: CheckerResult, id: string) => res.stats.find((stat) => stat.id === id)?.cost ?? NaN;

describe("Streets: the columns", () => {
  it("are preflop, flop, turn and river, each with its catalogue groups in order (no showdown)", () => {
    const columns = streetColumns(ANALYTICS, result("perfect"), {});
    expect(columns.map((column) => column.street)).toEqual([...STREET_COLUMNS]);
    for (const column of columns) {
      expect(column.blocks.map((entry) => entry.group.id)).toEqual(
        ANALYTICS.file.groups.filter((group) => group.street === column.street).map((group) => group.id),
      );
    }
    expect(columns.flatMap((column) => column.blocks).some((entry) => entry.group.street === "showdown")).toBe(false);
  });

  it("the over-folder: flop facing a bet folds more than the target, far, with the fold's cost", () => {
    const res = result("overfolder");
    const columns = streetColumns(ANALYTICS, res, {});
    const flop = block(columns, "flop_facing_bet");
    expect(flop.kind).toBe("fcr");
    expect(flop.you?.map((entry) => entry.action)).toEqual(["fold", "call", "raise"]);
    expect(flop.target?.map((entry) => entry.action)).toEqual(["fold", "call", "raise"]);
    expect(part(flop.you, "fold")).toBeGreaterThan(part(flop.target, "fold") ?? 100);
    expect(whole(flop.you)).toBeCloseTo(100, 6);
    expect(whole(flop.target)).toBeCloseTo(100, 6);
    expect(flop.verdict?.stat.id).toBe("flop_fold_vs_bet");
    expect(flop.tone).toBe("far");
    expect(flop.cost).toBeCloseTo(costOf(res, "flop_fold_vs_bet"), 9);
    expect(flop.source).toBe("solver");
    expect(flop.n).toBe(res.stats.find((stat) => stat.id === "flop_fold_vs_bet")?.n);
    // The column's cost is its blocks'; the flop's other block (cbet) is in range.
    const flopColumn = columns.find((column) => column.street === "flop");
    expect(flopColumn?.cost).toBeCloseTo(flop.cost, 9);
  });

  it("a block costs its costliest stat once: the probe is inside the turn fold", () => {
    const res = result("overfolder");
    const turn = block(streetColumns(ANALYTICS, res, {}), "turn_facing_bet");
    const fold = costOf(res, "turn_fold_vs_bet");
    const probe = costOf(res, "turn_fold_vs_probe");
    expect(turn.cost).toBeCloseTo(Math.max(fold, probe), 9);
    expect(turn.cost).toBeLessThan(fold + probe);
    expect(turn.barStats.map((stat) => stat.id)).toEqual(["turn_fold_vs_bet"]);
    expect(blockStats(turn, res).map((entry) => entry.stat.id)).toEqual(["turn_fold_vs_bet", "turn_fold_vs_probe"]);
  });

  it("the costliest block off target opens first; nothing opens for the perfect hero", () => {
    const res = result("overfolder");
    const columns = streetColumns(ANALYTICS, res, {});
    const all = columns.flatMap((column) => column.blocks);
    const costliest = all.reduce((best, entry) => (entry.cost > best.cost ? entry : best));
    expect(firstOpenBlock(columns)).toBe(costliest.group.id);
    expect(firstOpenBlock(streetColumns(ANALYTICS, result("perfect"), {}))).toBeNull();
  });

  it("the perfect hero: every judged block in range, no cost anywhere", () => {
    const columns = streetColumns(ANALYTICS, result("perfect"), {});
    for (const column of columns) {
      expect(column.cost).toBe(0);
      for (const entry of column.blocks) {
        expect(entry.tone).toBe("ok");
        expect(entry.cost).toBe(0);
        expect(entry.target).not.toBeNull();
      }
    }
  });

  it("one action alone fills from the left: a bet, an open raise", () => {
    const columns = streetColumns(ANALYTICS, result("perfect"), {});
    const cbet = block(columns, "flop_cbet");
    expect(cbet.kind).toBe("single");
    expect(cbet.you?.map((entry) => entry.action)).toEqual(["bet", "rest"]);
    const open = block(columns, "preflop_first_in");
    expect(open.kind).toBe("single");
    expect(open.you?.map((entry) => entry.action)).toEqual(["raise", "rest"]);
    const overall = block(columns, "preflop_overall");
    expect(overall.kind).toBe("fcr");
    expect(overall.you?.map((entry) => entry.action)).toEqual(["fold", "call", "raise"]);
  });

  it("preflop: VPIP / PFR overlap the street's other blocks, so the column takes the larger, never the sum of all", () => {
    const columns = streetColumns(ANALYTICS, result("preflop"), {});
    const preflop = columns.find((column) => column.street === "preflop");
    if (!preflop) throw new Error("preflop");
    const overall = block(columns, "preflop_overall");
    expect(overall.overlaps).toBe(true);
    const others = preflop.blocks.filter((entry) => !entry.overlaps).reduce((sum, entry) => sum + entry.cost, 0);
    expect(others).toBeGreaterThan(0);
    expect(preflop.cost).toBeCloseTo(Math.max(overall.cost, others), 9);
    expect(preflop.cost).toBeLessThan(overall.cost + others);
  });

  it("the Free plan (no checker): the rollups' bars where every part has a number, nothing judged", () => {
    const coded = { vpip: { made: 250, opp: 1000 }, pfr: { made: 180, opp: 1000 }, cbet_flop: { made: 60, opp: 100 } };
    const columns = streetColumns(ANALYTICS, null, coded);
    const overall = block(columns, "preflop_overall");
    expect(overall.you?.map((entry) => [entry.action, entry.value])).toEqual([
      ["fold", 75],
      ["call", 7],
      ["raise", 18],
    ]);
    expect(overall.target).toBeNull();
    expect(overall.verdict).toBeNull();
    expect(overall.fromRollups).toBe(true);
    expect(overall.n).toBe(1000);
    expect(block(columns, "flop_cbet").you?.[0]).toEqual({ action: "bet", value: 60 });
    // No coded twin for the flop's folds: no bar.
    expect(block(columns, "flop_facing_bet").you).toBeNull();
    for (const column of columns) expect(column.cost).toBe(0);
  });
});

describe("Overview: the findings", () => {
  it("the over-folder: one finding (gives up), its stats; the in-range stats as pills", () => {
    const res = result("overfolder");
    const model = overviewOf(res);
    expect(model.state).toBe("findings");
    expect(model.findings.map((finding) => [finding.family, finding.lean])).toEqual([["gives_up", "tight"]]);
    expect(model.inRange.map((stat) => stat.id)).toEqual(res.stats.filter((stat) => stat.tone === "ok").map((stat) => stat.id));
    expect(model.inRange.map((stat) => stat.id)).toContain("vpip");
    expect(model.inRange.every((stat) => stat.tone === "ok")).toBe(true);
  });

  it("at most three, costliest first", () => {
    const res = result("preflop");
    expect(res.findings.length).toBeGreaterThan(3);
    const model = overviewOf(res);
    expect(model.findings).toHaveLength(3);
    expect(model.findings).toEqual(res.findings.slice(0, 3));
    for (let i = 1; i < model.findings.length; i++) {
      expect(model.findings[i - 1]?.cost ?? 0).toBeGreaterThanOrEqual(model.findings[i]?.cost ?? 0);
    }
  });

  it("the perfect hero: nothing clearly off, every judged stat a pill", () => {
    const model = overviewOf(result("perfect"));
    expect(model.state).toBe("clear");
    expect(model.findings).toEqual([]);
    expect(model.inRange).toHaveLength(ANALYTICS.stats.filter((stat) => stat.kind !== "coded").length);
  });

  it("nothing analysed: neither cards nor 'nothing off'", () => {
    expect(overviewOf(result("unanalysed")).state).toBe("unanalysed");
    expect(overviewOf(result("empty")).state).toBe("unanalysed");
    expect(overviewOf(result("few")).state).toBe("clear");
  });

  it("Practise this: the Trainer's query, the lead stat, its costliest spot and the class", () => {
    const finding = result("overfolder").findings[0];
    if (!finding) throw new Error("finding");
    const query = new URLSearchParams(practiseQuery(finding));
    expect(query.get("from")).toBe("analytics");
    expect(query.get("stat")).toBe(finding.lead);
    expect(query.get("spot")).toBe(finding.why.spot);
    expect(query.get("classes")).toBe(finding.why.handClass);
    const preflop = result("preflop").findings[0];
    if (!preflop) throw new Error("preflop");
    expect(new URLSearchParams(practiseQuery(preflop)).has("classes")).toBe(false);
  });
});

describe("Streets rendered", () => {
  for (const locale of ["en", "hr"] as const) {
    const words = locale === "en" ? analyticsUiEn : analyticsUiHr;

    it(`the over-folder: the far fold in words and cost, the costliest block open with its spots, ${locale}`, () => {
      const res = result("overfolder");
      const html = text(render(locale, createElement(Streets, { catalogue: ANALYTICS, result: res, coded: {} })));
      for (const street of STREET_COLUMNS) expect(html).toContain(words.checker.streets[street]);
      const fold = ANALYTICS.get("flop_fold_vs_bet");
      if (!fold) throw new Error("fold");
      const figures = res.stats.find((stat) => stat.id === "flop_fold_vs_bet");
      if (!figures) throw new Error("figures");
      expect(html).toMatch(new RegExp(`class="[^"]*far[^"]*"[^>]*>${gapText(fold, figures, words, strings(locale).intlLocale).replace(/[+.]/g, "\\$&")}`));
      const cost = figures.cost.toFixed(1).replace(".", locale === "en" ? "." : ",");
      expect(html).toContain(`−${cost}`);
      expect(html).toContain(words.checker.source.solver);
      // One block open: its stats and the spots' table.
      expect(html.split('aria-expanded="true"')).toHaveLength(2);
      expect(html).toContain(words.screen.stats.spots.spot);
      expect(html).toContain(words.screen.stats.key);
    });

    it(`the perfect hero: in range everywhere, no cost, nothing open, ${locale}`, () => {
      const html = text(render(locale, createElement(Streets, { catalogue: ANALYTICS, result: result("perfect"), coded: {} })));
      expect(html).toContain(words.checker.inRange);
      expect(html).not.toContain("−");
      expect(html).not.toContain('aria-expanded="true"');
    });

    it(`the Free plan: the lock, the player's bars, nothing judged or open, ${locale}`, () => {
      const html = text(
        render(
          locale,
          createElement(Streets, {
            catalogue: ANALYTICS,
            result: result("overfolder"),
            coded: { vpip: { made: 250, opp: 1000 }, pfr: { made: 180, opp: 1000 } },
            lock: createElement("p", { "data-lock": "analysis" }, "Pro"),
          }),
        ),
      );
      expect(html).toContain('data-lock="analysis"');
      expect(html).toContain(words.screen.stats.barLabel(words.screen.streets.you, `${words.screen.stats.bars.fold} ${words.checker.percent("75")}`).split(",")[0]);
      expect(html).not.toContain(words.checker.inRange);
      expect(html).not.toContain(words.checker.source.solver);
      expect(html).not.toContain("aria-expanded");
      expect(html).not.toContain("−");
    });

    it(`loading and failing, ${locale}`, () => {
      const base = { catalogue: ANALYTICS, coded: {}, result: null };
      expect(text(render(locale, createElement(Streets, { ...base, loading: true })))).toContain(words.screen.stats.loading);
      expect(text(render(locale, createElement(Streets, { ...base, error: "boom" })))).toContain(words.screen.stats.error("boom"));
    });
  }
});

describe("Overview rendered", () => {
  for (const locale of ["en", "hr"] as const) {
    const words = locale === "en" ? analyticsUiEn : analyticsUiHr;
    const intl = strings(locale).intlLocale;
    const base = { catalogue: ANALYTICS, onView: () => undefined, practiseHref: (query: string) => `/analysis/train?${query}` };

    it(`the over-folder: the card open with its why, its spots and Practise this; the pills and the links, ${locale}`, () => {
      const res = result("overfolder");
      const finding = res.findings[0];
      if (!finding) throw new Error("finding");
      const html = text(render(locale, createElement(Overview, { ...base, result: res })));
      expect(html).toContain(findingHeadline(ANALYTICS, finding, words));
      expect(html).toContain(findingWhy(ANALYTICS, finding, words, intl));
      expect(html).toContain(`href="/analysis/train?${practiseQuery(finding)}"`);
      expect(html).toContain(words.screen.overview.practise);
      expect(html).toContain(words.screen.stats.spots.spot);
      const cost = finding.cost.toFixed(1).replace(".", locale === "en" ? "." : ",");
      expect(html).toContain(`−${cost}`);
      expect(html).toContain(words.screen.overview.inRange);
      expect(html).toContain(words.screen.overview.allStats);
      expect(html).toContain(words.screen.overview.pool);
      expect(html).not.toContain(words.screen.overview.clear);
    });

    it(`the perfect hero: one line, then the pills, ${locale}`, () => {
      const html = text(render(locale, createElement(Overview, { ...base, result: result("perfect") })));
      expect(html).toContain(words.screen.overview.clear);
      expect(html).not.toContain(words.screen.overview.practise);
      expect(html).not.toContain("aria-expanded");
      // One pill per stat in range: each its hover line and its number.
      for (const stat of overviewOf(result("perfect")).inRange) {
        expect(html).toContain(`title="${words.screen.stats.counts[stat.id]}`);
      }
      expect(html).toContain(words.screen.overview.inRange);
    });

    it(`without a Trainer link: no Practise this, ${locale}`, () => {
      const html = text(render(locale, createElement(Overview, { ...base, practiseHref: undefined, result: result("overfolder") })));
      expect(html).not.toContain(words.screen.overview.practise);
    });

    it(`the Free plan: the lock and the links, no finding, ${locale}`, () => {
      const res = result("overfolder");
      const finding = res.findings[0];
      if (!finding) throw new Error("finding");
      const html = text(
        render(locale, createElement(Overview, { ...base, result: res, lock: createElement("p", { "data-lock": "analysis" }, "Pro") })),
      );
      expect(html).toContain('data-lock="analysis"');
      expect(html).not.toContain(findingHeadline(ANALYTICS, finding, words));
      expect(html).not.toContain(words.screen.overview.inRange);
      expect(html).toContain(words.screen.overview.allStats);
    });

    it(`nothing analysed, loading and failing, ${locale}`, () => {
      expect(text(render(locale, createElement(Overview, { ...base, result: result("empty") })))).toContain(words.screen.overview.unanalysed);
      expect(text(render(locale, createElement(Overview, { ...base, result: null, loading: true })))).toContain(words.screen.stats.loading);
      expect(text(render(locale, createElement(Overview, { ...base, result: null, error: "boom" })))).toContain(words.screen.overview.error("boom"));
    });
  }
});

describe("the screen's tab row on Streets", () => {
  const source: ReportSource = {
    report: () => new Promise(() => undefined),
    breakdowns: () => new Promise(() => undefined),
    facets: () => new Promise(() => undefined),
    graphPoints: 1200,
    filters: { annotations: true, search: true, sorts: [], more: [], builder: true },
  };
  for (const locale of ["en", "hr"] as const) {
    it(`the bars' key on Streets, not on Overview, ${locale}`, () => {
      const words = locale === "en" ? analyticsUiEn : analyticsUiHr;
      const props = {
        source,
        definitions: [],
        chosen: { ...EMPTY_FILTER, formats: ["cash"] },
        onChoose: () => undefined,
        onView: () => undefined,
        title: words.screen.tabsLabel,
        emptyText: "No hands",
        renderState: (kind: string, label: string) => createElement("p", { "data-state": kind }, label),
      };
      const streets = text(render(locale, createElement(AnalyticsScreen, { ...props, view: "streets" })));
      expect(streets).toContain(words.screen.streets.raiseBet);
      expect(streets).toMatch(new RegExp(`aria-selected="true"[^>]*>${words.screen.tabs.streets}<`));
      const overview = text(render(locale, createElement(AnalyticsScreen, { ...props, view: "overview" })));
      expect(overview).not.toContain(words.screen.streets.raiseBet);
    });
  }
});
