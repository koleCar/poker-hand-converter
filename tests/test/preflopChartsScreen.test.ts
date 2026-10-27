/**
 * The user's own preflop charts (R5.3): the screens and the web's side.
 *
 * - The shared screens rendered to markup (React from the web's install) in
 *   English and Croatian: the library, the editor (the grid, the touch path,
 *   the situation words, the export text), the comparison (tiles, situations,
 *   deviations, the missing situations), `hiddenDuringPlay` reading nothing;
 *   the session review's list read against an own chart.
 * - The web: the address (`myChartsQuery.ts`, a whitelist, round trips), the
 *   payload readers and the calls `lib/db/preflopCharts.ts` makes against a
 *   faked `rpc`, and Rail's chart copied into a situation.
 * - The two languages' keys.
 *
 * The pure core is `preflopCharts.test.ts`'; the database's side is pgTAP
 * `preflop_charts`; the 375 px pass is `responsive.mjs`'s.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompareView } from "@rail/ui/charts/ChartCompare";
import { ChartEditor } from "@rail/ui/charts/ChartEditor";
import { ChartsScreen } from "@rail/ui/charts/ChartsScreen";
import { compareChart, type PlayedCell } from "@rail/ui/charts/compare";
import { classIndex, emptyNode, newChartSet, type ChartSet } from "@rail/ui/charts/model";
import { parseRange } from "@rail/ui/charts/ranges";
import type { PreflopChartsSource } from "@rail/ui/charts/source";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import type { ReviewDecision, SessionReview } from "@rail/ui/review/model";
import { SessionReviewView } from "@rail/ui/review/SessionReviewScreen";
import { chartsUiEn } from "@rail/ui/strings/charts.en";
import { chartsUiHr } from "@rail/ui/strings/charts.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";
import { reviewUiEn } from "@rail/ui/strings/review.en";
import { reviewUiHr } from "@rail/ui/strings/review.hr";

import { myChartsQueryString, parseMyChartsQuery } from "../../web/src/components/analysis/myCharts/myChartsQuery.js";
import {
  playedFromPayload,
  sessionDecisionsFromPayload,
  shippedNodeOf,
  webPreflopChartsSource,
  webSessionChartsSource,
} from "../../web/src/lib/db/preflopCharts.js";

const rpc = vi.fn();
vi.mock("../../web/src/lib/db/client.js", () => ({
  rpc: (...args: unknown[]) => rpc(...args),
  currentUserId: () => Promise.resolve("00000000-0000-0000-0000-0000000000a1"),
  requireDb: () => {
    throw new Error("no database in the tests");
  },
}));

function strings(locale: "en" | "hr"): UiStrings {
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    charts: locale === "en" ? chartsUiEn : chartsUiHr,
    review: locale === "en" ? reviewUiEn : reviewUiHr,
    replayer: locale === "en" ? replayerEn : replayerHr,
  } as unknown as UiStrings;
}

const plain = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function render(locale: "en" | "hr", node: ReactNode): string {
  return plain(renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node)));
}

const percents = (text: string) => {
  const r = parseRange(text);
  if (!r.ok) throw new Error("bad range");
  return r.percents;
};

function chart(): ChartSet {
  const set = newChartSet({ id: "00000000-0000-0000-0000-00000000c001", name: "Mine", tableSize: 6, stackMinBb: 80, stackMaxBb: 120 });
  const rfi = emptyNode();
  rfi.freq.raise.set(percents("22+,ATs+,KQs,AJo+"));
  set.nodes.set("rfi:CO", rfi);
  const bb = emptyNode();
  bb.freq.raise.set(percents("QQ+,AKs"));
  bb.freq.call.set(percents("JJ-22,AQs-A2s,AKo:0.5"));
  set.nodes.set("vs-open:BB:BTN", bb);
  return set;
}

const source = (): PreflopChartsSource => ({
  list: vi.fn(() => Promise.resolve([])),
  load: vi.fn(() => Promise.resolve(chart())),
  save: vi.fn(() => Promise.resolve({ id: "x", updatedAt: null })),
  remove: vi.fn(() => Promise.resolve()),
  shippedSets: () => [{ id: "nlhe-cash-6max-100bb", tableSize: 6, depthBb: 100 }],
  shippedNode: vi.fn(() => Promise.resolve(null)),
  played: vi.fn(() => Promise.resolve({ analysisVersion: "analysis/1", from: null, to: null, cells: [] })),
  examples: vi.fn(() => Promise.resolve([])),
});

const cell = (key: string, name: string, action: PlayedCell["action"], decisions: number, evLossBb = 0): PlayedCell => ({
  key,
  cls: classIndex(name),
  action,
  decisions,
  evLossBb,
});

/* -------------------------------------------------------------- screens - */

describe("the screens", () => {
  it.each(["en", "hr"] as const)("the editor (%s): the game, the situation, the brush, the grid and the touch path", (locale) => {
    const t = locale === "en" ? chartsUiEn : chartsUiHr;
    const html = render(locale, createElement(ChartEditor, { set: chart(), onChange: () => undefined, source: source(), initialKey: "vs-open:BB:BTN" }));
    expect(html).toContain(t.game.heading);
    expect(html).toContain(t.situation.label("vs-open", "BB", "BTN"));
    expect(html).toContain(t.situation.label("rfi", "CO", null)); // a filled situation's chip
    expect(html.match(/role="gridcell"/g)).toHaveLength(169);
    expect(html).toContain('role="grid"');
    expect(html).toContain(t.grid.byRank);
    expect(html.match(/class="[^"]*rankItem/g)?.length).toBe(25); // the ace's 25 hands (AA, AKs-A2s, AKo-A2o) as 44 px buttons
    expect(html).toContain(t.tools.copyRail);
    expect(html).toContain(t.tools.importText);
    // The export shows the situation's ranges.
    expect(html).toContain("QQ+,AKs");
    expect(html).toContain("JJ-22,AQs-A2s,AKo:0.5");
    // AA's cell names its mix.
    expect(html).toContain(t.grid.cell("AA", t.brush.rest(t.actions.raise, 100)));
  });

  it.each(["en", "hr"] as const)("the comparison (%s): tiles, situations, deviations and the missing", (locale) => {
    const t = locale === "en" ? chartsUiEn : chartsUiHr;
    const set = chart();
    const comparison = compareChart(set, [
      cell("rfi:CO", "AA", "raise", 10),
      cell("rfi:CO", "72o", "fold", 30),
      cell("rfi:CO", "K9o", "raise", 4, 1.2),
      cell("vs-open:BB:BTN", "72o", "call", 5, 3),
      cell("rfi:UTG", "AA", "raise", 7),
      cell("", "AA", "raise", 2),
    ]);
    const html = render(
      locale,
      createElement(CompareView, {
        set,
        data: { analysisVersion: "analysis/1", from: "2026-03-01", to: "2026-03-30", cells: [] },
        comparison,
        query: { period: "30d", gameFormat: "cash", tableSize: 6, stackMinBb: 80, stackMaxBb: 120 },
        source: source(),
        renderHandLink: ({ children }) => children,
        onFill: () => undefined,
      }),
    );
    expect(html).toContain(t.compare.tiles.decisions);
    expect(html).toContain(t.compare.tiles.followed);
    expect(html).toContain(t.compare.followedValue(locale === "en" ? "81.6" : "81,6")); // 40 of 49 decisions
    expect(html).toContain(t.compare.costValue(locale === "en" ? "4.2" : "4,2"));
    expect(html).toContain(t.situation.label("rfi", "CO", null));
    expect(html).toContain(t.compare.deviation("K9o", t.actions.raise, 4));
    expect(html).toContain(t.compare.missing(1));
    expect(html).toContain(t.compare.missingItem(t.situation.label("rfi", "UTG", null), 7));
    expect(html).toContain(t.compare.fill);
    expect(html).toContain(t.compare.unnamed(2));
    // The first situation is open: its deviations, worded.
    expect(html).toContain(
      t.compare.detail.row("K9o", t.compare.detail.did.raise, 4, t.compare.detail.does.fold, "0"),
    );
    expect(html.match(/role="gridcell"/g)).toHaveLength(169);
  });

  it("the comparison with nothing played says what is compared", () => {
    const set = chart();
    const html = render(
      "en",
      createElement(CompareView, {
        set,
        data: { analysisVersion: "analysis/1", from: null, to: null, cells: [] },
        comparison: compareChart(set, []),
        query: { period: "all", gameFormat: "cash", tableSize: 6, stackMinBb: 80, stackMaxBb: 120 },
        source: source(),
        renderHandLink: ({ children }) => children,
      }),
    );
    expect(html).toContain(chartsUiEn.compare.nothing);
  });

  it("the screen's first render: the list loading; hidden during play it reads nothing", () => {
    const s = source();
    const props = {
      source: s,
      title: "T",
      renderState: (_: string, text: string) => createElement("p", null, text),
      renderHandLink: ({ children }: { children: ReactNode }) => children,
      selected: null,
      view: "edit" as const,
      onNavigate: () => undefined,
    };
    expect(render("en", createElement(ChartsScreen, props))).toContain(chartsUiEn.loading);
    const hidden = render("hr", createElement(ChartsScreen, { ...props, hiddenDuringPlay: true }));
    expect(hidden).toContain(chartsUiHr.hiddenDuringPlay);
    expect(s.list).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
  });

  it("a new set opens in the editor, with the compare tab off until it is saved", () => {
    const html = render(
      "en",
      createElement(ChartsScreen, {
        source: source(),
        title: "T",
        renderState: (_: string, text: string) => createElement("p", null, text),
        renderHandLink: ({ children }) => children,
        selected: "new",
        view: "compare",
        onNavigate: () => undefined,
      }),
    );
    expect(html).toContain(chartsUiEn.library.newName);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Compare with your hands<\/button>/);
    expect(html).toContain(chartsUiEn.tools.save);
  });

  it.each(["en", "hr"] as const)("the session review's list against an own chart (%s)", (locale) => {
    const r = locale === "en" ? reviewUiEn : reviewUiHr;
    const review = {
      gapMinutes: 30,
      session: {
        startedAt: "2026-09-01T10:00:00Z",
        endedAt: "2026-09-01T11:00:00Z",
        finished: true,
        previousAt: null,
        nextAt: null,
        hands: 3,
        tables: 1,
        allInHands: 0,
        mixedUnitKind: false,
        mixedCurrency: false,
        cash: true,
        currency: "USD",
        currencySymbol: "$",
        currencyMinorUnits: 100,
        netBbMilli: 0,
        evNetBbMilli: 0,
        net: 0,
        evNet: 0,
      },
      ongoing: null,
      coverage: { hands: 3, analysed: 3, graded: 3, notAnalysed: 0 },
      worst: [],
      chartDeviations: [],
      pots: [],
      hands: {},
    } as SessionReview;
    const decision: ReviewDecision = {
      handId: "h1",
      ord: 0,
      actionIndex: 4,
      street: "preflop",
      action: "raise",
      best: "fold",
      scenario: "unopened",
      position: "CO",
      source: "own-chart",
      grade: null,
      evLossBb: 0.4,
      evLossPot: null,
      chosenFreq: 0,
    };
    const html = render(
      locale,
      createElement(SessionReviewView, {
        review,
        deviations: [decision],
        deviationHands: { h1: { handId: "h1", playedAt: "2026-09-01T10:10:00Z", heroCards: ["Kd", "9c"], board: [] } as never },
        deviationKind: "own",
        deviationLabel: "Mine",
        deviationChoices: [
          { id: "shipped-charts", label: r.deviationSource.shipped },
          { id: "own:x", label: "Mine" },
        ],
        deviationChoice: "own:x",
        onDeviationSource: () => undefined,
        sessions: [],
        query: { at: null, gapMinutes: 30, filter: {} },
        onQuery: () => undefined,
        renderHandLink: ({ children }) => createElement("a", null, children),
        renderState: (_kind, text) => createElement("p", null, text),
      }),
    );
    expect(html).toContain(r.deviationSource.description("Mine"));
    expect(html).toContain(r.deviationSource.label);
    expect(html).toContain(r.deviationSource.freq("0"));
    expect(html).toContain(r.deviationSource.best(r.actions.fold));
    expect(html).not.toContain(r.lists.deviations.description);
  });
});

/* ------------------------------------------------------------------ web - */

describe("the web", () => {
  beforeEach(() => rpc.mockReset());

  it("reads its address as a whitelist and writes it back", () => {
    const id = "0a1b2c3d-0000-4000-8000-00000000c001";
    expect(parseMyChartsQuery({ set: id, view: "compare", period: "365d" })).toEqual({
      selected: id,
      view: "compare",
      situation: null,
      period: "365d",
    });
    expect(parseMyChartsQuery({ set: "new", at: "vs-open:BB:BTN" })).toMatchObject({ selected: "new", view: "edit", situation: "vs-open:BB:BTN" });
    expect(parseMyChartsQuery({ set: "x';drop", view: "compare", at: "bogus", period: "7d" })).toEqual({
      selected: null,
      view: "edit",
      situation: null,
      period: undefined,
    });
    for (const query of [
      { selected: id, view: "compare" as const, situation: null, period: "all" as const },
      { selected: id, view: "edit" as const, situation: "rfi:CO", period: undefined },
    ]) {
      expect(parseMyChartsQuery(new URLSearchParams(myChartsQueryString(query)))).toEqual(query);
    }
    expect(myChartsQueryString({ selected: null, view: "edit", situation: null, period: undefined })).toBe("");
  });

  it("reads the played cells and the session's decisions, dropping malformed rows", () => {
    expect(
      playedFromPayload({
        analysisVersion: "analysis/7",
        from: "2026-03-01",
        to: "nope",
        cells: [["rfi:CO", 13, "raise", 3, "1.5"], ["rfi:CO", 169, "raise", 1, 0], ["rfi:CO", 1, "limp", 1, 0], "x"],
      }),
    ).toEqual({ analysisVersion: "analysis/7", from: "2026-03-01", to: null, cells: [{ key: "rfi:CO", cls: 13, action: "raise", decisions: 3, evLossBb: 1.5 }] });
    expect(
      sessionDecisionsFromPayload([
        { handId: "h", ord: 0, actionIndex: 4, key: "rfi:CO", cls: 13, action: "allin", tableSize: 6, depthBand: 100, evLossBb: null },
        { handId: "h2", action: "bet" },
      ]),
    ).toMatchObject([{ handId: "h", action: "allin", tableSize: 6, depthBandBb: 100, evLossBb: null }]);
  });

  it("asks the database for the played cells, the examples and the session at this build's versions", async () => {
    rpc.mockResolvedValueOnce({ cells: [] }).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce({});
    const query = { period: "90d" as const, gameFormat: "cash" as const, tableSize: 6 as const, stackMinBb: 80, stackMaxBb: 120 };
    await webPreflopChartsSource.played(query);
    expect(rpc).toHaveBeenLastCalledWith("preflop_chart_played", expect.objectContaining({
      p_period: "90d",
      p_format: "cash",
      p_table_size: 6,
      p_min_bb: 80,
      p_max_bb: 120,
      p_version: expect.stringMatching(/^analysis\/\d+$/),
    }));
    await webPreflopChartsSource.examples(query, "rfi:CO", 13, "raise", 5);
    expect(rpc).toHaveBeenLastCalledWith("preflop_chart_examples", expect.objectContaining({ p_key: "rfi:CO", p_class: 13, p_action: "raise", p_limit: 5 }));
    await webSessionChartsSource.sessionDecisions({ startedAt: "a", endedAt: "b" }, { at: null, gapMinutes: 30, filter: { from: "x", sites: ["weplay"] } });
    const [name, args] = rpc.mock.calls[2];
    expect(name).toBe("preflop_chart_session");
    expect(args.p_from).toBe("a");
    expect(args.p_filter.sites).toEqual(["weplay"]);
    expect(args.p_filter).not.toHaveProperty("from");
    await webSessionChartsSource.hands(["h1"], { at: null, gapMinutes: 30, filter: {} });
    expect(rpc).toHaveBeenLastCalledWith("preflop_chart_review_hands", expect.objectContaining({ p_hand_ids: ["h1"] }));
    expect(webPreflopChartsSource.shippedSets().every((s) => !s.id.endsWith("straddle"))).toBe(true);
  });

  it("copies Rail's chart into a situation as whole percents", async () => {
    const node = await shippedNodeOf("nlhe-cash-6max-100bb", "rfi:BTN");
    expect(node).not.toBeNull();
    expect(node!.freq.raise[classIndex("AA")]).toBeGreaterThanOrEqual(95);
    expect(node!.freq.raise[classIndex("72o")]).toBeLessThanOrEqual(5);
    for (let i = 0; i < 169; i += 1) expect(node!.freq.raise[i] + node!.freq.call[i] + node!.freq.allin[i]).toBeLessThanOrEqual(100);
    expect(await shippedNodeOf("nlhe-cash-hu-100bb", "vs-limp:BB:UTG")).toBeNull();
  });
});

describe("words", () => {
  it("both languages have the same keys", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, inner]) => [`${prefix}${key}`, ...keys(inner, `${prefix}${key}.`)])
        : [];
    expect(keys(chartsUiHr).sort()).toEqual(keys(chartsUiEn).sort());
  });
});
