/**
 * The Analytics drill-down (docs/ANALYTICS.md Step 8), over the checker's
 * fixture (`core/rail-stats/tests/data/analytics/checker/cases.json`):
 *
 * - **Routes**: the desktop's `#/reports/stat/<id>` parameter and the web's
 *   `/stats/<id>` path in and out.
 * - **The view model** (`drillOf`): the stat's spots in the checker's order,
 *   the open spot's bet sizes with fold / call / raise for the player and
 *   the target (the same figures as the checker over that spot alone), the
 *   hand classes strongest first, a size narrowing them, "Practise ▸" on the
 *   classes off target the stat's way; the Trainer's queries.
 * - **Rendered** in English and Croatian: the bar, the spots, the size
 *   table, "What you fold", the hands' heading, the Pro lock, and the way in
 *   ("By bet size and hand →") under a stat's spots.
 * - **Done when**: two clicks from a red stat reach a spot's hand classes
 *   (open the row, then the way in: the costliest spot is open with its
 *   classes), and the third opens a hand (each hand row is a link).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatSpots } from "@rail/ui/analytics/AllStats";
import { Drill, DrillHandRows, DrillNavContext, type DrillNav } from "@rail/ui/analytics/Drill";
import { statName } from "@rail/ui/analytics/findings";
import type { CheckerExample } from "@rail/ui/analytics/model";
import { spotName } from "@rail/ui/analytics/spot";
import {
  drillOf,
  drillOfParam,
  drillOfPath,
  drillParam,
  drillQuery,
  drillSide,
  isDrillable,
  playQuery,
  spotLines,
} from "@rail/ui/analytics/view";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
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

function sumsOf(name: string): CheckerSumsIn {
  const found = CASES.cases.find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found.sums;
}

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

const NAV: DrillNav = { href: (stat) => (stat === null ? "#/reports/stats" : `#/reports/stat/${stat}`) };

function render(locale: "en" | "hr", node: ReactNode, nav: DrillNav | null = NAV): string {
  const inner = nav ? createElement(DrillNavContext.Provider, { value: nav }, node) : node;
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, inner));
}

const EXAMPLE: CheckerExample = {
  handId: "hand-1",
  ord: 2,
  actionIndex: 9,
  playedAt: null,
  site: "pokerstars",
  stat: "flop_fold_vs_bet",
  spot: "single-raised|caller|BB|CO",
  size: "20-40",
  handClass: "middle_pair",
  taken: true,
  bestIn: false,
  refShare: 0.1,
  evLossBb: 1.24,
  facingPot: 0.33,
  cards: ["Ah", "5h"],
  board: ["Kd", "5c", "2s"],
};

const text = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("drill-down routes", () => {
  it("the desktop parameter: stat/<id> in and out, anything else is not a drill-down", () => {
    expect(drillParam("flop_fold_vs_bet")).toBe("stat/flop_fold_vs_bet");
    expect(drillOfParam("stat/flop_fold_vs_bet")).toBe("flop_fold_vs_bet");
    expect(drillOfParam("stats")).toBeNull();
    expect(drillOfParam("stat/")).toBeNull();
    expect(drillOfParam("position")).toBeNull();
    expect(drillOfParam(null)).toBeNull();
  });

  it("the web path: /stats/<id> (encoded), not /stats", () => {
    expect(drillOfPath("/stats/flop_fold_vs_bet")).toBe("flop_fold_vs_bet");
    expect(drillOfPath("/stats/flop_fold_vs_bet/")).toBe("flop_fold_vs_bet");
    expect(drillOfPath("/stats/a%20b")).toBe("a b");
    expect(drillOfPath("/stats")).toBeNull();
    expect(drillOfPath("/stats/")).toBeNull();
    expect(drillOfPath("/analysis/x")).toBeNull();
    expect(drillOfPath("/stats/%E0%A4%A")).toBeNull();
    expect(drillOfPath(null)).toBeNull();
  });

  it("only rates have a drill-down", () => {
    expect(isDrillable(ANALYTICS.get("flop_fold_vs_bet"))).toBe(true);
    expect(isDrillable(ANALYTICS.get("vpip"))).toBe(true);
    expect(isDrillable(ANALYTICS.get("river_bet_weak"))).toBe(false);
    expect(isDrillable(ANALYTICS.get("wtsd"))).toBe(false);
    expect(isDrillable(undefined)).toBe(false);
  });
});

describe("drillOf: the view model", () => {
  const sums = sumsOf("overfolder");
  const res = result("overfolder");

  it("the over-folder's flop fold: the checker's spots, the costliest open, its sizes and classes", () => {
    const model = drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", null, null);
    expect(model).not.toBeNull();
    if (!model) return;
    const checked = res.stats.find((stat) => stat.id === "flop_fold_vs_bet");
    expect(model.checked?.tone).toBe("far");
    expect(model.spots.map((row) => row.key)).toEqual(checked?.spots.map((row) => row.key));
    expect(model.spot).toBe(checked?.spots[0]?.key);
    // Sizes: catalogue order, fold / call / raise (flop fold and flop raise share their decisions).
    const order = ANALYTICS.file.sizeBuckets.map((bucket) => bucket.id);
    const keys = model.sizes.map((size) => size.row.key);
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(keys);
    expect(model.actions).toEqual(["fold", "call", "raise"]);
    // Their sample adds up to the spot's.
    const spotRow = model.spots[0];
    expect(model.sizes.reduce((sum, size) => sum + size.row.n, 0)).toBe(spotRow?.n);
    for (const size of model.sizes) {
      const [fold, call, raise] = size.cells;
      expect(fold?.you).toBeCloseTo(size.row.player ?? NaN, 6);
      expect(fold?.target).toBeCloseTo(size.row.target ?? NaN, 6);
      expect((fold?.you ?? 0) + (call?.you ?? 0) + (raise?.you ?? 0)).toBeCloseTo(100, 6);
      expect((fold?.target ?? 0) + (call?.target ?? 0) + (raise?.target ?? 0)).toBeCloseTo(100, 6);
      // The stat's own action carries the row's tone; the derived ones none.
      expect(fold?.tone).toBe(size.row.tone);
      expect(call?.tone).toBe("none");
    }
    // Classes: strongest first (the catalogue's order), each with a sample.
    const classOrder = ANALYTICS.file.handClasses.map((cls) => cls.id);
    const classKeys = model.classes.map((entry) => entry.row.key);
    expect(classKeys.length).toBeGreaterThan(0);
    expect([...classKeys].sort((a, b) => classOrder.indexOf(a) - classOrder.indexOf(b))).toEqual(classKeys);
    expect(model.classes.every((entry) => entry.row.n > 0)).toBe(true);
    // The shares of the folds add up to the whole.
    expect(model.classes.reduce((sum, entry) => sum + (entry.row.shareOfTaken ?? 0), 0)).toBeCloseTo(1, 4);
  });

  it("a spot's figures are the checker's over that spot alone", () => {
    const model = drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", null, null);
    const spot = model?.spot ?? "";
    const alone = checkStats(ANALYTICS, { ...sums, groups: sums.groups.filter((group) => group.spot === spot) });
    const figures = alone.stats.find((stat) => stat.id === "flop_fold_vs_bet");
    expect(model?.sizes.map((size) => size.row)).toEqual(figures?.sizes.filter((row) => row.n > 0));
    expect(model?.classes.map((entry) => entry.row)).toEqual(figures?.classes.filter((row) => row.n > 0));
  });

  it("a spot seen but never analysed is left out; with nothing analysed there are no spots", () => {
    const seen = {
      ...sums,
      groups: [
        ...sums.groups,
        { stat: "flop_fold_vs_bet", spot: "single-raised|caller|SB|UTG", size: "20-40", handClass: "nothing", opps: 9, oppsTaken: 4, n: 0, taken: 0, refShare: 0, evHigh: 0, evLow: 0, hands: 9 },
      ],
    };
    const checked = checkStats(ANALYTICS, seen);
    expect(checked.stats.find((stat) => stat.id === "flop_fold_vs_bet")?.spots.some((row) => row.key === "single-raised|caller|SB|UTG")).toBe(true);
    const model = drillOf(ANALYTICS, seen, checked, "flop_fold_vs_bet", "single-raised|caller|SB|UTG", null);
    expect(model?.spots.some((row) => row.key === "single-raised|caller|SB|UTG")).toBe(false);
    expect(model?.spot).toBe(model?.spots[0]?.key);
    const unanalysed = { hands: 9, pending: 0, groups: seen.groups.slice(-1) };
    expect(drillOf(ANALYTICS, unanalysed, checkStats(ANALYTICS, unanalysed), "flop_fold_vs_bet", null, null)?.spots).toEqual([]);
  });

  it("choosing a spot opens it; an unknown spot falls back to the costliest", () => {
    const first = drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", null, null);
    const second = first?.spots[1]?.key ?? "";
    expect(drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", second, null)?.spot).toBe(second);
    expect(drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", "nowhere|x|y|z", null)?.spot).toBe(first?.spot);
  });

  it("choosing a size narrows the classes to it; a size the spot lacks means every size", () => {
    const all = drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", null, null);
    const size = all?.sizes[0]?.row.key ?? "";
    const narrow = drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", all?.spot ?? null, size);
    expect(narrow?.size).toBe(size);
    const sizeN = all?.sizes[0]?.row.n ?? 0;
    expect(narrow?.classes.reduce((sum, entry) => sum + entry.row.n, 0)).toBe(sizeN);
    expect(drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", all?.spot ?? null, "999")?.size).toBeNull();
  });

  it("Practise ▸ on the classes off target the stat's way that are a real part of the folds", () => {
    const model = drillOf(ANALYTICS, sums, res, "flop_fold_vs_bet", null, null);
    const offered = model?.classes.filter((entry) => entry.practise) ?? [];
    expect(offered.length).toBeGreaterThan(0);
    for (const entry of offered) {
      expect(entry.row.direction).toBe("high");
      expect(["off", "far", "few"]).toContain(entry.row.tone);
      expect(entry.row.shareOfTaken ?? 0).toBeGreaterThanOrEqual(0.05);
    }
    // In range or the other way: no link.
    for (const entry of model?.classes.filter((c) => !c.practise) ?? []) {
      const off = ["off", "far", "few"].includes(entry.row.tone) && entry.row.direction === "high" && (entry.row.shareOfTaken ?? 0) >= 0.05;
      expect(off).toBe(false);
    }
  });

  it("a stat with one action alone: fold and the rest (the probe has no raise twin)", () => {
    const model = drillOf(ANALYTICS, sums, res, "turn_fold_vs_probe", null, null);
    expect(model?.actions).toEqual(["fold", "rest"]);
  });

  it("preflop: spots, but no sizes or classes", () => {
    const pre = result("preflop");
    const model = drillOf(ANALYTICS, sumsOf("preflop"), pre, "bb_fold_vs_steal", null, null);
    expect(model?.spots.length).toBeGreaterThan(0);
    expect(model?.sizes).toEqual([]);
    expect(model?.classes).toEqual([]);
  });

  it("without sums (still loading) the spots only; a share or a coded stat has none", () => {
    const model = drillOf(ANALYTICS, null, res, "flop_fold_vs_bet", null, null);
    expect(model?.spots.length).toBeGreaterThan(0);
    expect(model?.sizes).toEqual([]);
    expect(drillOf(ANALYTICS, sums, res, "flop_raise_weak", null, null)).toBeNull();
    expect(drillOf(ANALYTICS, sums, res, "wtsd", null, null)).toBeNull();
    expect(drillOf(ANALYTICS, sums, res, "nope", null, null)).toBeNull();
  });

  it("the Trainer's queries: the spot, the size, the classes; Play it adds the decision", () => {
    expect(drillQuery("flop_fold_vs_bet", "single-raised|caller|BB|CO", "20-40", ["middle_pair", "gutshot"])).toBe(
      "from=analytics&stat=flop_fold_vs_bet&spot=single-raised%7Ccaller%7CBB%7CCO&size=20-40&classes=middle_pair%2Cgutshot",
    );
    expect(drillQuery("vpip", null, null, [])).toBe("from=analytics&stat=vpip");
    const query = new URLSearchParams(
      playQuery("flop_fold_vs_bet", { handId: "h1", ord: 3, actionIndex: 7, spot: "single-raised|caller|BB|CO", size: "40-60", handClass: "gutshot" }),
    );
    expect(Object.fromEntries(query)).toEqual({
      from: "analytics",
      stat: "flop_fold_vs_bet",
      spot: "single-raised|caller|BB|CO",
      size: "40-60",
      classes: "gutshot",
      hand: "h1",
      ord: "3",
      action: "7",
    });
  });

  it("the hands shown: the actions taken when the stat is too high, the ones missed when too low", () => {
    const over = res.stats.find((stat) => stat.id === "flop_fold_vs_bet") ?? null;
    expect(drillSide(over)).toBe("high");
    const pre = result("preflop").stats.find((stat) => stat.id === "three_bet") ?? null;
    expect(pre?.direction).toBe("low");
    expect(drillSide(pre)).toBe("low");
    expect(drillSide(null)).toBe("high");
  });
});

describe("the drill-down, rendered", () => {
  const sums = sumsOf("overfolder");
  const res = result("overfolder");
  const example: CheckerExample = EXAMPLE;

  for (const locale of ["en", "hr"] as const) {
    const words = locale === "en" ? analyticsUiEn : analyticsUiHr;
    const d = words.screen.drill;

    it(`${locale}: the bar, the spots, the sizes, the classes and the hands' heading`, () => {
      const stat = ANALYTICS.get("flop_fold_vs_bet");
      if (!stat) throw new Error("stat");
      const model = drillOf(ANALYTICS, sums, res, stat.id, null, null);
      const html = text(
        render(
          locale,
          createElement(Drill, {
            catalogue: ANALYTICS,
            statId: stat.id,
            sums,
            result: res,
            examples: () => Promise.resolve([example]),
            practiseHref: (query: string) => `/train?${query}`,
          }),
        ),
      );
      expect(html).toContain(d.back);
      expect(html).toContain('href="#/reports/stats"');
      expect(html).toContain(statName(stat, words));
      // Every spot on the left, the open one pressed.
      for (const row of model?.spots ?? []) expect(html).toContain(spotName(row.key, words.spot).split(words.spot.separator)[0] ?? "");
      expect(html).toContain('aria-pressed="true"');
      // The size table's heads and the classes.
      expect(html).toContain(d.sizes.youRef(words.screen.stats.bars.fold, d.sizes.ref.solver ?? ""));
      expect(html).toContain(d.what.fold ?? "");
      expect(html).toContain(d.share.fold ?? "");
      expect(html).toContain(d.sizes.youRef(words.screen.stats.bars.fold, d.sizes.ref.solver ?? ""));
      expect(html).toContain(d.worth.fold ?? "");
      expect(html).toContain(d.practiseClass);
      // The way to the Trainer for the open spot.
      expect(html).toContain(d.practise(spotName(model?.spot ?? "", words.spot)));
      expect(html).toContain("/train?from=analytics&amp;stat=flop_fold_vs_bet".replace("&amp;", "&"));
      // The hands' heading (the list loads after the first paint).
      expect(html).toContain(d.handsTitle(d.handsHigh.fold ?? ""));
      expect(html).toContain(d.handsLoading);
    });

    it(`${locale}: the Free plan shows the way back and the lock only`, () => {
      const html = text(
        render(
          locale,
          createElement(Drill, {
            catalogue: ANALYTICS,
            statId: "flop_fold_vs_bet",
            sums: null,
            result: null,
            lock: createElement("p", null, "LOCK"),
          }),
        ),
      );
      expect(html).toContain(d.back);
      expect(html).toContain("LOCK");
      expect(html).not.toContain(d.what.fold ?? "");
    });

    it(`${locale}: a stat without a drill-down says so, with the way back`, () => {
      const html = text(render(locale, createElement(Drill, { catalogue: ANALYTICS, statId: "wtsd", sums, result: res })));
      expect(html).toContain(d.noDrill);
      expect(html).toContain(d.back);
    });

    it(`${locale}: "By bet size and hand →" under a rate's spots, only where the surface has the route`, () => {
      const stat = ANALYTICS.get("flop_fold_vs_bet");
      if (!stat) throw new Error("stat");
      const withNav = text(render(locale, createElement(StatSpots, { catalogue: ANALYTICS, result: res, stat })));
      expect(withNav).toContain(d.link);
      expect(withNav).toContain('href="#/reports/stat/flop_fold_vs_bet"');
      const without = text(render(locale, createElement(StatSpots, { catalogue: ANALYTICS, result: res, stat }), null));
      expect(without).not.toContain(d.link);
      const share = ANALYTICS.get("flop_raise_weak");
      if (!share) throw new Error("share");
      expect(text(render(locale, createElement(StatSpots, { catalogue: ANALYTICS, result: res, stat: share })))).not.toContain(d.link);
    });
  }
});

describe("done when: two clicks to a spot's classes, three to a hand", () => {
  it("a red stat's row opens to its spots with the way in (1), the drill-down opens its costliest spot with classes (2), each hand is a link (3)", () => {
    const sums = sumsOf("overfolder");
    const res = result("overfolder");
    const red = res.stats.filter((stat) => stat.tone === "far" && isDrillable(ANALYTICS.get(stat.id)) && stat.spots.length > 0);
    expect(red.length).toBeGreaterThan(0);
    for (const stat of red) {
      const catalogueStat = ANALYTICS.get(stat.id);
      if (!catalogueStat) throw new Error(stat.id);
      // Click 1: the row opens to its spots, and the way in is there.
      expect(spotLines(ANALYTICS, res, stat.id).length).toBeGreaterThan(0);
      expect(text(render("en", createElement(StatSpots, { catalogue: ANALYTICS, result: res, stat: catalogueStat })))).toContain(
        analyticsUiEn.screen.drill.link,
      );
      // Click 2: the drill-down, its costliest spot open with that spot's classes.
      const model = drillOf(ANALYTICS, sums, res, stat.id, null, null);
      expect(model?.spot).toBe(stat.spots[0]?.key);
      if (catalogueStat.street !== "preflop") expect(model?.classes.length).toBeGreaterThan(0);
    }
    // Click 3: each hand row is the surface's link to the hand, with "Play it ▸" beside it.
    const stat = ANALYTICS.get("flop_fold_vs_bet");
    if (!stat) throw new Error("stat");
    const rows: CheckerExample[] = [
      { ...EXAMPLE, handId: "hand-1", evLossBb: 1.24 },
      { ...EXAMPLE, handId: "hand-2", ord: 4, actionIndex: 12, handClass: "gutshot", evLossBb: 0.4 },
    ];
    const opened: { handId: string; actionIndex: number }[] = [];
    const html = text(
      render(
        "en",
        createElement(DrillHandRows, {
          stat,
          rows,
          catalogue: ANALYTICS,
          renderHandLink: ({ handId, actionIndex, label, className, children }) => {
            opened.push({ handId, actionIndex });
            return createElement("a", { href: `#/hands/${handId}`, "aria-label": label, className }, children);
          },
          practiseHref: (query: string) => `#/trainer/${query}`,
        }),
      ),
    );
    expect(opened).toEqual([
      { handId: "hand-1", actionIndex: 9 },
      { handId: "hand-2", actionIndex: 12 },
    ]);
    expect(html).toContain('href="#/hands/hand-1"');
    expect(html).toContain('href="#/hands/hand-2"');
    expect(html).toContain(analyticsUiEn.screen.drill.openHand("Ah 5h"));
    expect(html).toContain(analyticsUiEn.screen.drill.bb("1.24"));
    expect(html).toContain("Middle pair");
    expect(html.match(new RegExp(analyticsUiEn.screen.drill.playIt, "g"))?.length).toBe(2);
    expect(html).toContain("hand=hand-2&ord=4&action=12");
  });
});
