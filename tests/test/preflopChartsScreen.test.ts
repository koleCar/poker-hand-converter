/**
 * The user's own preflop charts (R5.3): the screens and the web's side.
 *
 * - The shared screens rendered to markup (React from the web's install) in
 *   English and Croatian: the library, the editor (the grid, the touch path,
 *   the situation words, the export text), a new set, `hiddenDuringPlay`
 *   reading nothing.
 * - The web: the address (`myChartsQuery.ts`, a whitelist, round trips) and
 *   Rail's chart copied into a situation.
 * - The two languages' keys.
 *
 * The pure core is `preflopCharts.test.ts`'; the database's side is pgTAP
 * `preflop_charts`; the 375 px pass is `responsive.mjs`'s.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChartEditor } from "@rail/ui/charts/ChartEditor";
import { ChartsScreen } from "@rail/ui/charts/ChartsScreen";
import { classIndex, emptyNode, newChartSet, type ChartSet } from "@rail/ui/charts/model";
import { parseRange } from "@rail/ui/charts/ranges";
import type { PreflopChartsSource } from "@rail/ui/charts/source";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import { chartsUiEn } from "@rail/ui/strings/charts.en";
import { chartsUiHr } from "@rail/ui/strings/charts.hr";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";

import { myChartsQueryString, parseMyChartsQuery } from "../../frontend/src/components/analysis/myCharts/myChartsQuery.js";
import { shippedNodeOf, webPreflopChartsSource } from "../../frontend/src/lib/db/preflopCharts.js";

vi.mock("../../frontend/src/lib/db/client.js", () => ({
  requireDb: () => {
    throw new Error("no database in the tests");
  },
}));

function strings(locale: "en" | "hr"): UiStrings {
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    charts: locale === "en" ? chartsUiEn : chartsUiHr,
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

  it("the screen's first render: the list loading; hidden during play it reads nothing", () => {
    const s = source();
    const props = {
      source: s,
      title: "T",
      renderState: (_: string, text: string) => createElement("p", null, text),
      selected: null,
      onNavigate: () => undefined,
    };
    expect(render("en", createElement(ChartsScreen, props))).toContain(chartsUiEn.loading);
    const hidden = render("hr", createElement(ChartsScreen, { ...props, hiddenDuringPlay: true }));
    expect(hidden).toContain(chartsUiHr.hiddenDuringPlay);
    expect(s.list).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
  });

  it("a new set opens in the editor", () => {
    const html = render(
      "en",
      createElement(ChartsScreen, {
        source: source(),
        title: "T",
        renderState: (_: string, text: string) => createElement("p", null, text),
        selected: "new",
        onNavigate: () => undefined,
      }),
    );
    expect(html).toContain(chartsUiEn.library.newName);
    expect(html).toContain(chartsUiEn.tools.save);
  });

});

/* ------------------------------------------------------------------ web - */

describe("the web", () => {
  it("reads its address as a whitelist and writes it back", () => {
    const id = "0a1b2c3d-0000-4000-8000-00000000c001";
    expect(parseMyChartsQuery({ set: id })).toEqual({ selected: id, situation: null });
    expect(parseMyChartsQuery({ set: "new", at: "vs-open:BB:BTN" })).toEqual({ selected: "new", situation: "vs-open:BB:BTN" });
    expect(parseMyChartsQuery({ set: "x';drop", at: "bogus" })).toEqual({ selected: null, situation: null });
    expect(parseMyChartsQuery({ at: "rfi:CO" })).toEqual({ selected: null, situation: null });
    for (const query of [
      { selected: id, situation: null },
      { selected: id, situation: "rfi:CO" },
    ]) {
      expect(parseMyChartsQuery(new URLSearchParams(myChartsQueryString(query)))).toEqual(query);
    }
    expect(myChartsQueryString({ selected: null, situation: null })).toBe("");
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
