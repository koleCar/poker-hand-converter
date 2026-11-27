/**
 * The Analytics screen's states (docs/ANALYTICS.md Step 12; board
 * AN-States), in English and Croatian:
 *
 * - **small sample**: grey, "Not sure yet", no cost;
 * - **no target yet** (`withUncovered`): a spot the solver does not cover
 *   (a 4-bet pot on the turn, multiway) shows the player's number from every
 *   decision, no colour, "No target yet", no cost - and a coded stat keeps
 *   "No target";
 * - **analysis still running**: "Targets fill in as hands are analysed",
 *   with the hands left (the checker's `pending`, or the browser fill's
 *   countdown), and no "nothing analysed" line under it;
 * - **Free**: the one-line lock per tab (`analytics.screen.lock`), the
 *   player's numbers stay;
 * - **Pool**: counting shows the count alone; the web with the opponents'
 *   statistics off shows one line and the link to the setting.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AllStats } from "@rail/ui/analytics/AllStats";
import { gapText } from "@rail/ui/analytics/findings";
import type { PoolSums } from "@rail/ui/analytics/model";
import { Overview } from "@rail/ui/analytics/Overview";
import { Pool } from "@rail/ui/analytics/Pool";
import { PendingLine, pendingOf } from "@rail/ui/analytics/States";
import { allStatsItems, isUncovered, withUncovered, type AllStatsRow } from "@rail/ui/analytics/view";
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
import { checkStats, type CheckerGroupIn, type CheckerSumsIn } from "../../web/src/lib/stats/checker.js";

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
  return renderToStaticMarkup(createElement(UiStringsProvider, { strings: strings(locale) }, node))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const group = (over: Partial<CheckerGroupIn> & Pick<CheckerGroupIn, "stat" | "spot">): CheckerGroupIn => ({
  size: "",
  handClass: "",
  opps: 0,
  oppsTaken: 0,
  n: 0,
  taken: 0,
  refShare: 0,
  evHigh: 0,
  evLow: 0,
  hands: 0,
  ...over,
});

/**
 * Turn fold vs bet: a single-raised pot analysed against the solver, and a
 * 4-bet pot the solver does not cover (seen 310 times, folded 149, none
 * analysed); river fold vs bet only in the uncovered spot; a small sample on
 * river raise.
 */
const SUMS: CheckerSumsIn = {
  hands: 5000,
  pending: 0,
  groups: [
    group({ stat: "turn_fold_vs_bet", spot: "single-raised|caller|BB|BTN", size: "40-60", handClass: "middle_pair", opps: 200, oppsTaken: 80, n: 200, taken: 80, refShare: 78, hands: 200 }),
    group({ stat: "turn_fold_vs_bet", spot: "4bet+|caller|BB|BTN", size: "40-60", handClass: "middle_pair", opps: 310, oppsTaken: 149, hands: 310 }),
    group({ stat: "river_fold_vs_bet", spot: "4bet+|caller|BB|BTN", size: "40-60", handClass: "middle_pair", opps: 40, oppsTaken: 10, hands: 40 }),
    group({ stat: "river_raise_vs_bet", spot: "single-raised|caller|BB|BTN", size: "40-60", handClass: "top_pair", opps: 12, oppsTaken: 3, n: 12, taken: 3, refShare: 0.6, evHigh: 0.4, hands: 12 }),
  ],
};

const words = { en: analyticsUiEn, hr: analyticsUiHr } as const;

describe("no target yet: spots the solver does not cover", () => {
  const raw = checkStats(ANALYTICS, SUMS, {});
  const shown = withUncovered(raw);
  const of = (id: string) => shown.stats.find((stat) => stat.id === id);

  it("the checker leaves the number null; the screen shows it from every decision, without a target", () => {
    expect(raw.stats.find((stat) => stat.id === "river_fold_vs_bet")?.player).toBeNull();
    const river = of("river_fold_vs_bet");
    expect(river?.player).toBeCloseTo(25, 6);
    expect(river?.target).toBeNull();
    expect(river?.tone).toBe("none");
    expect(river && isUncovered(river)).toBe(true);
    // A spot row too, beside an analysed one of the same stat.
    const turn = of("turn_fold_vs_bet");
    const fourBet = turn?.spots.find((row) => row.key.startsWith("4bet+"));
    expect(fourBet?.player).toBeCloseTo((149 * 100) / 310, 6);
    expect(fourBet?.target).toBeNull();
    const single = turn?.spots.find((row) => row.key.startsWith("single-raised"));
    expect(single?.player).toBeCloseTo(40, 6);
    expect(single?.target).not.toBeNull();
    // The stat itself is judged on its analysed decisions only.
    expect(turn?.n).toBe(200);
    expect(turn?.player).toBeCloseTo(40, 6);
  });

  it("All stats: the number, no colour, no band, Times = every decision, no cost", () => {
    const row = allStatsItems(ANALYTICS, shown, {}, "street", "all").find(
      (item): item is AllStatsRow => item.kind === "stat" && item.stat.id === "river_fold_vs_bet",
    );
    expect(row?.player).toBeCloseTo(25, 6);
    expect(row?.tone).toBe("none");
    expect(row?.track).toBeNull();
    expect(row?.n).toBe(40);
    expect(row?.cost).toBe(0);
  });

  for (const locale of ["en", "hr"] as const) {
    const w = words[locale];
    it(`rendered: "No target yet" for the uncovered rate, "No target" for a coded one, ${locale}`, () => {
      const river = ANALYTICS.get("river_fold_vs_bet");
      const wtsd = ANALYTICS.get("wtsd");
      if (!river || !wtsd) throw new Error("catalogue");
      expect(gapText(river, { tone: "none", gap: null, direction: null, n: 0, opps: 40 }, w, "en-GB")).toBe(w.checker.noTargetYet);
      expect(gapText(wtsd, { tone: "none", gap: null, direction: null, n: 0, opps: 9 }, w, "en-GB")).toBe(w.checker.noTarget);
      const html = render(locale, createElement(AllStats, { catalogue: ANALYTICS, result: shown, coded: {}, order: "street", show: "all" }));
      expect(html).toContain(w.checker.noTargetYet);
      expect(html).toContain(w.checker.percent("25"));
    });
  }
});

describe("a small sample", () => {
  for (const locale of ["en", "hr"] as const) {
    const w = words[locale];
    it(`grey, "Not sure yet", no cost, ${locale}`, () => {
      const shown = withUncovered(checkStats(ANALYTICS, SUMS, {}));
      const raise = shown.stats.find((stat) => stat.id === "river_raise_vs_bet");
      expect(raise?.tone).toBe("few");
      const row = allStatsItems(ANALYTICS, shown, {}, "street", "all").find(
        (item): item is AllStatsRow => item.kind === "stat" && item.stat.id === "river_raise_vs_bet",
      );
      expect(row?.cost).toBe(0);
      const html = render(locale, createElement(AllStats, { catalogue: ANALYTICS, result: shown, coded: {}, order: "street", show: "all" }));
      expect(html).toContain(w.checker.notSure);
    });
  }
});

describe("analysis still running", () => {
  const unanalysed: CheckerSumsIn = {
    hands: 0,
    pending: 1204,
    groups: [],
  };
  for (const locale of ["en", "hr"] as const) {
    const w = words[locale];
    const left = locale === "en" ? "1,204" : "1.204";
    it(`the hands left, from the checker or the fill's countdown, and nothing else, ${locale}`, () => {
      const result = withUncovered(checkStats(ANALYTICS, unanalysed, {}));
      expect(pendingOf(result, null)).toBe(1204);
      expect(pendingOf(result, 300)).toBe(300);
      expect(pendingOf(result, 0)).toBe(1204);
      expect(render(locale, createElement(PendingLine, { left: 0 }))).toBe("");
      const line = render(locale, createElement(PendingLine, { left: 1204 }));
      expect(line).toContain(w.screen.stats.pendingLeft(left, 1204));
      expect(line).toContain('role="status"');

      const overview = render(locale, createElement(Overview, { catalogue: ANALYTICS, result, onView: () => undefined }));
      expect(overview).toContain(w.screen.stats.pendingLeft(left, 1204));
      // No "targets show once your hands are analysed" under the line that says they are being.
      expect(overview).not.toContain(w.screen.overview.unanalysed);
      const stats = render(locale, createElement(AllStats, { catalogue: ANALYTICS, result, coded: {}, order: "street", show: "all" }));
      expect(stats).toContain(w.screen.stats.pendingLeft(left, 1204));
      expect(stats).not.toContain(w.screen.stats.empty);
      const filling = render(
        locale,
        createElement(AllStats, { catalogue: ANALYTICS, result, coded: {}, order: "street", show: "all", filling: 3 }),
      );
      expect(filling).toContain(w.screen.stats.pendingLeft("3", 3));

      // Nothing pending and nothing analysed: the one line that says so.
      const idle = withUncovered(checkStats(ANALYTICS, { ...unanalysed, pending: 0 }, {}));
      expect(render(locale, createElement(Overview, { catalogue: ANALYTICS, result: idle, onView: () => undefined }))).toContain(
        w.screen.overview.unanalysed,
      );
    });
  }
});

describe("the Free plan's one line", () => {
  it("has the words for every tab and the drill-down, in both languages", () => {
    for (const w of [analyticsUiEn, analyticsUiHr]) {
      for (const place of ["overview", "streets", "stats", "pool", "drill"]) expect(w.screen.lock[place], place).toBeTruthy();
      expect(w.screen.clearFilters).toBeTruthy();
    }
  });

  for (const locale of ["en", "hr"] as const) {
    const w = words[locale];
    it(`All stats: the line above the player's own numbers, nothing judged, ${locale}`, () => {
      const html = render(
        locale,
        createElement(AllStats, {
          catalogue: ANALYTICS,
          result: null,
          coded: { vpip: { made: 250, opp: 1000 } },
          order: "street",
          show: "all",
          lock: createElement("p", { "data-lock": "line" }, w.screen.lock.stats),
        }),
      );
      expect(html).toContain(w.screen.lock.stats);
      expect(html).toContain(w.checker.percent("25"));
      expect(html).not.toContain(w.checker.noTargetYet);
      expect(html).not.toContain(w.checker.inRange);
    });
  }
});

describe("Pool's states", () => {
  const none = { players: 0, hands: 0, netBb: 0, netBbSq: 0 };
  const empty: PoolSums = { version: "analytics/1", pending: 0, reg: none, fish: none, stats: [] };
  const base = {
    catalogue: ANALYTICS,
    result: null,
    you: null,
    show: "all" as const,
    onAllStats: () => undefined,
  };
  for (const locale of ["en", "hr"] as const) {
    const p = words[locale].screen.pool;
    it(`counting: the count alone; off: one line and the link; else the empty line, ${locale}`, () => {
      const counting = render(locale, createElement(Pool, { ...base, sums: { ...empty, pending: 900 }, counting: 900 }));
      expect(counting).toContain(p.counting(locale === "en" ? "900" : "900"));
      expect(counting).not.toContain(p.empty);
      const off = render(
        locale,
        createElement(Pool, { ...base, sums: empty, off: createElement("a", { href: "/players" }, p.offLink) }),
      );
      expect(off).toContain(p.off);
      expect(off).toContain('href="/players"');
      expect(off).not.toContain(p.empty);
      const idle = render(locale, createElement(Pool, { ...base, sums: empty }));
      expect(idle).toContain(p.empty);
      expect(idle).toContain(p.allStats);
    });
  }
});
