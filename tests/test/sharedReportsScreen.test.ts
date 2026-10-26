/**
 * The shared Reports screen (`packages/ui/reports/`, R4.5c): one screen, two
 * data sources - the desktop app's local store and the web's report
 * summaries.
 *
 * - The web's source (`frontend/src/lib/db/reportSource.ts`) against a faked
 *   `rpc`: what it asks `report_open`, `report_graph`, `report_situations`
 *   and `report_facets` for, and the report it hands the screen - every
 *   statistic `showStat` of the shipped definitions over the server's sums,
 *   the money the server withheld shown as no value, the graph's money lines,
 *   rooms named, a stake's symbol.
 * - The opponents panel's scope from the screen's filter (`opponentsScope`).
 * - The breakdown table, the starting-hand grid and the screen's first render
 *   to markup (React from the web's install) with reports shaped as each
 *   surface sends them, in English and Croatian.
 *
 * The screen's behaviour in a browser (tabs, the money view, a phone's
 * layout) is checked by hand and by `packages/ui/screens/responsive.mjs`:
 * `docs/RAIL-PLAN.md` R4.5c.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER } from "@rail/ui/hands/filter";
import type { HandFacets } from "@rail/ui/hands/model";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import type { Shown } from "@rail/ui/model/stats";
import { Breakdown } from "@rail/ui/reports/Breakdown";
import { HandMatrix } from "@rail/ui/reports/HandMatrix";
import { BREAKDOWN_COLUMNS, type Report, type ReportSource, type StatGroup } from "@rail/ui/reports/model";
import { ReportsScreen, biggestFormat } from "@rail/ui/reports/ReportsScreen";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { reportsUiEn } from "@rail/ui/strings/reports.en";
import { reportsUiHr } from "@rail/ui/strings/reports.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";
import { statsUiEn } from "@rail/ui/strings/stats.en";
import { statsUiHr } from "@rail/ui/strings/stats.hr";

import { opponentsScope } from "../../frontend/src/components/stats/opponentsScope.js";
import { WEB_DEFINITIONS, reportTotals, webReportSource } from "../../frontend/src/lib/db/reportSource.js";
import { STANDARD_STATS, emptyCounters, emptyMoney, showStat, statById } from "../../frontend/src/lib/stats/index.js";

const rpc = vi.fn();
vi.mock("../../frontend/src/lib/db/client.js", () => ({ rpc: (...args: unknown[]) => rpc(...args) }));

function strings(locale: "en" | "hr"): UiStrings {
  // Only what the breakdowns, the grid and the screen's first render read.
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    closeNamed: (what: string) => what,
    hands: locale === "en" ? handsUiEn : handsUiHr,
    reports: locale === "en" ? reportsUiEn : reportsUiHr,
    replayer: locale === "en" ? replayerEn : replayerHr,
    statTile: (locale === "en" ? statsUiEn : statsUiHr).tile,
    statTable: { ...(locale === "en" ? statsUiEn : statsUiHr).table, sampleOnly: (locale === "en" ? statsUiEn : statsUiHr).sampleOnly },
  } as unknown as UiStrings;
}

function render(locale: "en" | "hr", node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node));
}

/** A row's sums as `report_open` sends them (the breakdown columns' counters and the money). */
function sumsRow(key: string, hands: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    hands,
    money_hands: hands,
    vpip_opp: hands,
    vpip: Math.round(hands * 0.25),
    pfr_opp: hands,
    pfr: Math.round(hands * 0.2),
    net: 1200,
    net_bb_milli: 6000,
    ...extra,
  };
}

const OPEN = {
  statsVersion: "stats/2",
  hands: 200,
  moneyHands: 198,
  mixedCurrency: false,
  mixedUnitKind: false,
  currency: "EUR",
  currencyMinorUnits: 100,
  total: {
    hands: 200,
    money_hands: 198,
    vpip_opp: 200,
    vpip: 46,
    pfr_opp: 200,
    pfr: 37,
    three_bet_opp: 80,
    three_bet: 9,
    won: 9000,
    contributed: 7000,
    net: 2000,
    net_bb_milli: 10000,
    rake_paid: 396,
    out_of_pot: 0,
    cashout_risk: 0,
    ev_net_bb_milli: 12000,
  },
  groups: {
    position: [sumsRow("BTN", 40), sumsRow("", 2)],
    stake: [sumsRow("EUR:20", 200)],
    site: [sumsRow("pokerstars", 150), sumsRow("winamax", 50)],
    size: [sumsRow("6max", 200)],
    format: [sumsRow("cash", 200)],
  },
  allInHands: 3,
};

const GRAPH = {
  statsVersion: "stats/2",
  hands: 200,
  moneyHands: 198,
  currency: "EUR",
  currencyMinorUnits: 100,
  mixedCurrency: false,
  mixedUnitKind: false,
  allInEv: { evVersion: "ev/1", allInHands: 3 },
  buckets: [
    {
      bucket: 1,
      hands: 200,
      money_hands: 198,
      first_played_at: "2026-10-01T10:00:00+00:00",
      last_played_at: "2026-10-01T12:00:00+00:00",
      cum_hands: 200,
      cum_money_hands: 198,
      cum_net_bb_milli: 10000,
      cum_sd_bb_milli: 4000,
      cum_nsd_bb_milli: 6000,
      cum_net: 2000,
      cum_sd_net: 800,
      cum_nsd_net: 1200,
      cum_ev_bb_milli: 12000,
      cum_ev_net: 2400,
      ev_applicable: 3,
    },
  ],
};

function shownOf(report: Report, id: string): Shown {
  const shown = report.summary.stats[report.summary.ids.indexOf(id)];
  if (!shown) throw new Error(id);
  return shown;
}

beforeEach(() => {
  rpc.mockReset();
});

describe("the web's ReportSource over the summaries", () => {
  it("asks report_open and report_graph for the filter, the versions and at most its points", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "report_open" ? OPEN : GRAPH));
    const source = webReportSource("Standard format");
    await source.report({ formats: ["cash"], positions: ["BTN"] }, 1200);
    expect(rpc).toHaveBeenCalledTimes(2);
    const [open, graph] = rpc.mock.calls;
    expect(open?.[0]).toBe("report_open");
    expect(open?.[1]).toEqual({
      p_filter: { formats: ["cash"], positions: ["BTN"], statsVersion: expect.stringMatching(/^stats\//), evVersion: expect.stringMatching(/^ev\//) },
    });
    expect(graph?.[0]).toBe("report_graph");
    expect((graph?.[1] as { p_points: number }).p_points).toBe(150);
    expect(source.graphPoints).toBe(150);
  });

  it("every statistic is showStat of the shipped definitions over the server's sums", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "report_open" ? OPEN : GRAPH));
    const report = await webReportSource("Standard format").report({}, 150);
    expect(report.summary.ids).toEqual(STANDARD_STATS.map((stat) => stat.def.id));
    expect(report.summary.stats).toHaveLength(STANDARD_STATS.length);
    expect(shownOf(report, "vpip").text).toBe("23.0");
    expect(shownOf(report, "vpip").sample).toBe(200);
    const totals = reportTotals(report);
    expect(totals?.counters.three_bet).toBe(9);
    expect(shownOf(report, "bb_per_100")).toEqual(
      showStat(statById(STANDARD_STATS, "bb_per_100"), totals!, 100),
    );
    expect(shownOf(report, "allin_ev_bb_per_100").value).toBeCloseTo((12000 / 1000 / 198) * 100, 10);
    expect(report.summary).toMatchObject({ hands: 200, moneyHands: 198, net: 2000, netBbMilli: 10000, evNetBbMilli: 12000 });
    expect(report.units).toEqual({ mixedKind: false, mixedCurrency: false, currency: "EUR", symbol: "€", minorUnits: 100 });
  });

  it("hands the breakdowns over as the app's rows: the breakdown columns, rooms named", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "report_open" ? OPEN : GRAPH));
    const report = await webReportSource("Standard format").report({}, 150);
    expect(report.columns).toEqual([...BREAKDOWN_COLUMNS]);
    const btn = report.byPosition[0] as StatGroup;
    expect(btn).toMatchObject({ key: "BTN", hands: 40, moneyHands: 40, net: 1200, netBbMilli: 6000, label: null });
    expect(btn.stats).toHaveLength(BREAKDOWN_COLUMNS.length);
    expect(btn.stats[BREAKDOWN_COLUMNS.indexOf("vpip")]?.text).toBe("25.0");
    expect(report.bySite.map((row) => row.label)).toEqual(["PokerStars", "Winamax"]);
    expect(report.byPosition[1]?.key).toBe("");
  });

  it("the graph: every line, in big blinds and in money", async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(name === "report_open" ? OPEN : GRAPH));
    const { graph } = await webReportSource("Standard format").report({}, 150);
    expect(graph).toMatchObject({ hands: 200, moneyHands: 198, allInEv: { allInHands: 3, pending: 0 } });
    expect(graph.buckets[0]).toMatchObject({
      cumNetBbMilli: 10000,
      cumSdBbMilli: 4000,
      cumNsdBbMilli: 6000,
      cumEvBbMilli: 12000,
      cumNet: 2000,
      cumSdNet: 800,
      cumNsdNet: 1200,
      cumEvNet: 2400,
      cumMoneyHands: 198,
    });
  });

  it("money the server withheld shows no value: two currencies keep big blinds, chips with cash nothing", async () => {
    const twoCurrencies = {
      ...OPEN,
      mixedCurrency: true,
      currency: null,
      currencyMinorUnits: null,
      total: { ...OPEN.total, won: undefined, contributed: undefined, net: undefined, rake_paid: undefined, out_of_pot: undefined, cashout_risk: undefined },
    };
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === "report_open" ? JSON.parse(JSON.stringify(twoCurrencies)) : GRAPH),
    );
    const report = await webReportSource("Standard format").report({}, 150);
    expect(report.summary.net).toBeNull();
    expect(report.summary.netBbMilli).toBe(10000);
    expect(shownOf(report, "rake_per_100").value).toBeNull();
    expect(shownOf(report, "bb_per_100").value).not.toBeNull();
    expect(report.units).toMatchObject({ mixedCurrency: true, currency: null, symbol: null });

    const chipsAndCash = { ...twoCurrencies, mixedUnitKind: true, total: { ...twoCurrencies.total, net_bb_milli: undefined, ev_net_bb_milli: undefined } };
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === "report_open" ? JSON.parse(JSON.stringify(chipsAndCash)) : GRAPH),
    );
    const mixed = await webReportSource("Standard format").report({}, 150);
    expect(mixed.summary.netBbMilli).toBeNull();
    expect(shownOf(mixed, "bb_per_100").value).toBeNull();
    expect(shownOf(mixed, "vpip").text).toBe("23.0");
  });

  it("the breakdowns by situation from report_situations", async () => {
    rpc.mockResolvedValue({
      groups: {
        potType: [sumsRow("3bet", 30)],
        stack: [sumsRow("100-150", 120)],
        handClass: [sumsRow("AKs", 4), sumsRow("", 1)],
        players: [sumsRow("6", 90)],
        street: [sumsRow("flop", 70)],
      },
      mixedCurrency: false,
      mixedUnitKind: false,
    });
    const breakdowns = await webReportSource("Standard format").breakdowns({ sites: ["pokerstars"] });
    expect(rpc).toHaveBeenCalledWith("report_situations", {
      p_filter: expect.objectContaining({ sites: ["pokerstars"] }),
    });
    expect(breakdowns.columns).toEqual([...BREAKDOWN_COLUMNS]);
    expect(breakdowns.handClass.map((row) => row.key)).toEqual(["AKs", ""]);
    expect(breakdowns.potType[0]?.stats[BREAKDOWN_COLUMNS.indexOf("hands")]?.value).toBe(30);
  });

  it("the chips' counts from report_facets: rooms named, a stake's symbol from its currency", async () => {
    rpc.mockResolvedValue({
      total: 150,
      library: 200,
      sites: [{ value: "pokerstars", count: 150 }],
      formats: [{ value: "cash", count: 150 }, { value: "tournament", count: 0 }],
      variants: [],
      limits: [],
      sizes: [{ value: "6max", count: 150 }],
      positions: [{ value: "BTN", count: 40 }],
      stakes: [
        { value: "USD:200", count: 120, currency: "USD", minorUnits: 100, smallBlind: 100, bigBlind: 200, currencySymbol: null },
        { value: "chips", count: 0, currency: null, minorUnits: null, smallBlind: null, bigBlind: null, currencySymbol: null },
      ],
    });
    const facets = await webReportSource("Standard format").facets({});
    expect(facets.sites).toEqual([{ value: "pokerstars", count: 150, name: "PokerStars" }]);
    expect(facets.stakes[0]).toMatchObject({ value: "USD:200", currencySymbol: "$", smallBlind: 100, bigBlind: 200 });
    expect(facets.stakes[1]).toMatchObject({ value: "chips", currencySymbol: null });
    expect(facets).toMatchObject({ total: 150, library: 200, potTypes: [], tags: [] });
    expect(biggestFormat(facets)).toBeNull();
    expect(biggestFormat({ ...facets, formats: [{ value: "cash", count: 10 }, { value: "tournament", count: 30 }] })).toBe("tournament");
  });

  it("lists every shipped definition", () => {
    expect(WEB_DEFINITIONS.map((definition) => definition.id)).toEqual(STANDARD_STATS.map((stat) => stat.def.id));
  });
});

describe("the opponents panel beside the screen", () => {
  it("follows one room, one game and one stake", () => {
    expect(opponentsScope({ sites: ["pokerstars"], formats: ["cash"], stakes: ["USD:200"] })).toEqual({
      filters: { site: "pokerstars", gameFormat: "cash", currency: "USD", bigBlind: 200 },
      partial: false,
    });
    expect(opponentsScope({ formats: ["tournament"], stakes: ["chips"] })).toEqual({
      filters: { gameFormat: "tournament" },
      partial: false,
    });
  });

  it("says when the filter has chips it does not follow", () => {
    expect(opponentsScope({ sites: ["a", "b"] }).partial).toBe(true);
    expect(opponentsScope({ positions: ["BTN"] }).partial).toBe(true);
    expect(opponentsScope({ from: "2026-10-01T00:00:00.000Z" }).partial).toBe(true);
    expect(opponentsScope({}).partial).toBe(false);
  });
});

/* ------------------------------------------------------------ markup - */

const DEFINITIONS = STANDARD_STATS.map((stat) => stat.def);
const COLUMN_STATS = BREAKDOWN_COLUMNS.map((id) => statById(STANDARD_STATS, id));

/** A group row with real `Shown`s for the breakdown columns. */
function group(key: string, hands: number, label: string | null = null): StatGroup {
  const sums = {
    counters: { ...emptyCounters(), hands, vpip_opp: hands, vpip: Math.round(hands / 4), pfr_opp: hands, pfr: Math.round(hands / 5) },
    money: { ...emptyMoney(), net_bb_milli: hands * 50 },
    moneyHands: hands,
  };
  return {
    key,
    label,
    hands,
    moneyHands: hands,
    net: null,
    netBbMilli: hands * 50,
    stats: COLUMN_STATS.map((stat) => showStat(stat, sums, null)),
  };
}

/** A report as the desktop's store sends it (`reports::ReportDto`): the same shape the web's source builds. */
const APP_REPORT: Report = {
  units: { mixedKind: false, mixedCurrency: false, currency: "USD", symbol: "$", minorUnits: 100 },
  summary: { hands: 300, moneyHands: 300, net: 4500, netBbMilli: 15000, evNetBbMilli: 14000, stats: [], ids: [] },
  graph: { hands: 300, moneyHands: 300, buckets: [], allInEv: { allInHands: 0, pending: 2 }, mixedUnitKind: false, mixedCurrency: false },
  columns: [...BREAKDOWN_COLUMNS],
  byPosition: [group("BTN", 60), group("SB", 50), group("", 2)],
  byStake: [group("USD:200", 300), group("chips", 0)],
  bySite: [group("pokerstars", 300, "PokerStars")],
  bySize: [group("6max", 250), group("hu", 50)],
  byFormat: [group("cash", 300)],
};

const FACETS: HandFacets = {
  total: 300,
  sites: [],
  formats: [],
  variants: [],
  limits: [],
  sizes: [],
  stakes: [{ value: "USD:200", count: 300, currency: "USD", currencySymbol: "$", minorUnits: 100, smallBlind: 100, bigBlind: 200 }],
  positions: [],
  potTypes: [],
  results: [],
  stacks: [],
  allIn: [],
  tags: [],
  noted: 0,
};

describe("the breakdown table and the grid, rendered", () => {
  for (const locale of ["en", "hr"] as const) {
    it(`by position and by stake, ${locale}`, () => {
      const byPosition = render(
        locale,
        createElement(Breakdown, {
          report: APP_REPORT,
          breakdowns: null,
          loading: false,
          definitions: DEFINITIONS,
          facets: FACETS,
          tab: "position",
          onTab: () => undefined,
        }),
      );
      const r = locale === "en" ? reportsUiEn : reportsUiHr;
      expect(byPosition).toContain(r.breakdown.heading);
      expect(byPosition).toContain(r.breakdown.noPosition);
      expect(byPosition).toContain(">BTN<");
      // The columns are the definitions' labels in the reader's language.
      expect(byPosition).toContain(`>${statById(STANDARD_STATS, "vpip").def.label[locale]}<`);
      // Positions in a player's order: the button before the small blind.
      expect(byPosition.indexOf(">BTN<")).toBeLessThan(byPosition.indexOf(">SB<"));
      const byStake = render(
        locale,
        createElement(Breakdown, {
          report: APP_REPORT,
          breakdowns: null,
          loading: false,
          definitions: DEFINITIONS,
          facets: FACETS,
          tab: "stake",
          onTab: () => undefined,
        }),
      );
      expect(byStake).toContain(">$1/$2<");
      expect(byStake).toContain(locale === "en" ? handsUiEn.filters.chips : handsUiHr.filters.chips);
    });

    it(`a tab by situation waits for its rows, and the starting hands hide during play, ${locale}`, () => {
      const r = locale === "en" ? reportsUiEn : reportsUiHr;
      const waiting = render(
        locale,
        createElement(Breakdown, {
          report: APP_REPORT,
          breakdowns: null,
          loading: true,
          definitions: DEFINITIONS,
          facets: FACETS,
          tab: "potType",
          onTab: () => undefined,
        }),
      );
      expect(waiting).toContain(r.breakdown.computing);
      const hidden = render(
        locale,
        createElement(Breakdown, {
          report: APP_REPORT,
          breakdowns: { columns: [...BREAKDOWN_COLUMNS], potType: [], stack: [], handClass: [group("AKs", 4)], players: [], street: [] },
          loading: false,
          definitions: DEFINITIONS,
          facets: FACETS,
          tab: "handClass",
          onTab: () => undefined,
          hideHandChart: true,
        }),
      );
      expect(hidden).toContain(r.breakdown.handClassHidden);
      expect(hidden).not.toContain("role=\"grid\"");
    });

    it(`(R6.4) full reports held back: the lock in the situation tabs only, ${locale}`, () => {
      const r = locale === "en" ? reportsUiEn : reportsUiHr;
      const lock = createElement("p", { "data-lock": "reports" }, "LOCKED");
      const situation = render(
        locale,
        createElement(Breakdown, {
          report: APP_REPORT,
          breakdowns: null,
          loading: false,
          definitions: DEFINITIONS,
          facets: FACETS,
          tab: "potType",
          onTab: () => undefined,
          situationsLock: lock,
        }),
      );
      expect(situation).toContain("data-lock=\"reports\"");
      expect(situation).not.toContain(r.breakdown.computing);
      // The basic breakdowns stay: no lock by position.
      const basic = render(
        locale,
        createElement(Breakdown, {
          report: APP_REPORT,
          breakdowns: null,
          loading: false,
          definitions: DEFINITIONS,
          facets: FACETS,
          tab: "position",
          onTab: () => undefined,
          situationsLock: lock,
        }),
      );
      expect(basic).not.toContain("data-lock");
      expect(basic).toContain(">BTN<");
    });

    it(`the 13 x 13 grid, ${locale}`, () => {
      const columns = BREAKDOWN_COLUMNS.map((id) => statById(STANDARD_STATS, id).def);
      const grid = render(locale, createElement(HandMatrix, { rows: [group("AKs", 8), group("72o", 3)], columns }));
      expect(grid.match(/role="gridcell"/g)).toHaveLength(169);
      expect(grid).toContain((locale === "en" ? reportsUiEn : reportsUiHr).matrix.gridLabel);
      expect(grid).toContain(">AKs<");
    });
  }
});

describe("the screen's first render on each source", () => {
  const sources: [string, ReportSource][] = [
    [
      "the app's",
      {
        report: () => new Promise(() => undefined),
        breakdowns: () => new Promise(() => undefined),
        facets: () => new Promise(() => undefined),
        graphPoints: 1200,
        savedFilters: { list: async () => [], save: async () => [], remove: async () => [] },
      },
    ],
    ["the web's", webReportSource("Standard format")],
  ];
  for (const [name, source] of sources) {
    for (const locale of ["en", "hr"] as const) {
      it(`${name}, ${locale}: the title, the report's chips and the loading state`, () => {
        const html = render(
          locale,
          createElement(ReportsScreen, {
            source,
            definitions: DEFINITIONS,
            chosen: { ...EMPTY_FILTER, formats: ["cash"] },
            onChoose: () => undefined,
            tab: "position",
            onTab: () => undefined,
            title: "Reports",
            emptyText: "No hands",
            renderState: (kind: string, text: string) => createElement("p", { "data-state": kind }, text),
          }),
        );
        const h = locale === "en" ? handsUiEn : handsUiHr;
        const r = locale === "en" ? reportsUiEn : reportsUiHr;
        expect(html).toContain(">Reports<");
        expect(html).toContain(`data-state="loading"`);
        expect(html).toContain(r.loading);
        for (const group of ["date", "site", "stakes", "position", "format", "variant", "limit", "size"] as const) {
          expect(html).toContain(h.filters.groups[group]);
        }
        // The Hands screen's groups a report does not sum by are not offered.
        expect(html).not.toContain(`>${h.filters.groups.potType}<`);
      });
    }
  }
});
