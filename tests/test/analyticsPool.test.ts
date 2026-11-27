/**
 * The Analytics Pool tab (docs/ANALYTICS.md Step 10):
 *
 * - **The view model** (`@rail/ui/analytics/poolView`): each type's rate
 *   judged against the player's own target with the checker's band and
 *   tones; an exploit sentence only where a type's gap is clear on its own
 *   opportunities - a pool of over-folding regs gives "bluff them more" on
 *   river fold, a small pool says nothing; one sentence for "regs and fish"
 *   when both are clear the same way; the figures (regs : fish, the regs'
 *   bb/100 ± its standard error, the player's win rate with a fish and with
 *   regs only); the filter the pool follows.
 * - **The words**: every rate has a sentence for each direction, in English
 *   and Croatian.
 * - **The counts** the web writes (`lib/db/poolCounts.ts`): every named
 *   opponent's catalogue counts and result; nothing from a bomb pot, a
 *   positional room or a hand without a hero.
 * - **The tab rendered** in English and Croatian, its lock and its empty state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PoolSums } from "@rail/ui/analytics/model";
import { Pool, exploitText, quietMeaning } from "@rail/ui/analytics/Pool";
import {
  exploitsOf,
  poolCell,
  poolFigures,
  poolFiltersOf,
  poolRows,
  rateOf,
  shownPoolRows,
  youQueries,
  youRates,
  type PoolRow,
} from "@rail/ui/analytics/poolView";
import { UiStringsProvider, type UiStrings } from "@rail/ui/i18n";
import type { Report } from "@rail/ui/reports/model";
import { analyticsUiEn } from "@rail/ui/strings/analytics.en";
import { analyticsUiHr } from "@rail/ui/strings/analytics.hr";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { reportsUiEn } from "@rail/ui/strings/reports.en";
import { reportsUiHr } from "@rail/ui/strings/reports.hr";

import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import { ANALYTICS, type CatalogueStat } from "../../web/src/lib/stats/analytics.js";
import type { CheckedStat, CheckerResult } from "../../web/src/lib/stats/checker.js";
import { handFacts } from "../../web/src/lib/stats/derive.js";
import { handEvents } from "../../web/src/lib/stats/events.js";
import { statsRows } from "../../web/src/lib/stats/mapping.js";
import { poolHand, poolSeats } from "../../web/src/lib/db/poolCounts.js";

const ROOT = join(import.meta.dirname, "../..");

/** A checker result with the player's figures for the stats named (percent; n analysed decisions, default 500). */
function result(figures: Record<string, { player: number; target: number; n?: number }>): CheckerResult {
  return {
    hands: 1000,
    pending: 0,
    findings: [],
    stats: Object.entries(figures).map(
      ([id, f]) => ({ id, player: f.player, target: f.target, n: f.n ?? 500, tone: "ok" }) as unknown as CheckedStat,
    ),
  };
}

const empty = { players: 0, hands: 0, netBb: 0, netBbSq: 0 };

function sums(stats: PoolSums["stats"], reg = { players: 40, hands: 12_000, netBb: -276, netBbSq: 1_080_000 }, fish = { players: 9, hands: 3_000, netBb: -900, netBbSq: 600_000 }): PoolSums {
  return { version: "analytics/1", pending: 0, reg, fish, stats };
}

function stat(id: string): CatalogueStat {
  const found = ANALYTICS.get(id);
  if (!found) throw new Error(id);
  return found;
}

function row(rows: PoolRow[], id: string): PoolRow {
  const found = rows.find((entry) => entry.stat.id === id);
  if (!found) throw new Error(id);
  return found;
}

const words = analyticsUiEn as unknown as UiStrings["analytics"];
const wordsHr = analyticsUiHr as unknown as UiStrings["analytics"];

describe("Pool: the exploit sentences", () => {
  const player = result({ river_fold_vs_bet: { player: 49, target: 46 } });

  it("a pool of over-folding regs: 'bluff them more' on river fold", () => {
    const rows = poolRows(
      ANALYTICS,
      player,
      sums([
        { stat: "river_fold_vs_bet", type: "reg", made: 620, opp: 1000 },
        { stat: "river_fold_vs_bet", type: "fish", made: 135, opp: 300 },
      ]),
    );
    const river = row(rows, "river_fold_vs_bet");
    expect(river.target).toBe(46);
    expect(river.you).toBe(49);
    expect(river.reg.player).toBeCloseTo(62, 9);
    expect(river.reg.tone).toBe("far");
    expect(river.reg.direction).toBe("high");
    expect(river.fish.tone).toBe("ok");
    expect(river.exploits).toEqual([{ types: ["reg"], direction: "high", tone: "far" }]);
    const sentence = exploitText(river.stat, river.exploits[0], words);
    expect(sentence).toBe("Regs fold the river too much: bluff them more.");
    expect(exploitText(river.stat, river.exploits[0], wordsHr)).toBe("Regovi previše foldaju river: češće ih blefiraj.");
    // "Exploits only" keeps it.
    expect(shownPoolRows(rows, "exploits").map((entry) => entry.stat.id)).toEqual(["river_fold_vs_bet"]);
  });

  it("a small pool says nothing: far off on 10 opportunities is 'not sure yet'", () => {
    const rows = poolRows(ANALYTICS, player, sums([{ stat: "river_fold_vs_bet", type: "reg", made: 9, opp: 10 }]));
    const river = row(rows, "river_fold_vs_bet");
    expect(river.reg.player).toBe(90);
    expect(river.reg.tone).toBe("few");
    expect(river.exploits).toEqual([]);
    expect(quietMeaning(river, words)).toBe("Not sure yet");
    expect(shownPoolRows(rows, "exploits")).toEqual([]);
  });

  it("no sentence while the player's own target rests on too few decisions", () => {
    const thin = result({ river_fold_vs_bet: { player: 0, target: 0, n: 3 } });
    const rows = poolRows(ANALYTICS, thin, sums([{ stat: "river_fold_vs_bet", type: "reg", made: 620, opp: 1000 }]));
    const river = row(rows, "river_fold_vs_bet");
    expect(river.reg.tone).toBe("few");
    expect(river.targetSure).toBe(false);
    expect(river.exploits).toEqual([]);
    expect(quietMeaning(river, words)).toBe("Not sure yet");
  });

  it("uses the checker's band: the floor, then 1.96·√(t(1−t)/n), the sample.min", () => {
    const fold = stat("river_fold_vs_bet");
    // n = 1000 at 46%: the half-width is 3.09 points, above the 2-point floor.
    const wide = poolCell(fold, 490, 1000, 46);
    expect(wide.half).toBeCloseTo(1.96 * Math.sqrt((0.46 * 0.54) / 1000) * 100, 9);
    expect(wide.tone).toBe("ok");
    // A huge sample: the floor (2 points) is the band.
    expect(poolCell(fold, 4_850_000, 10_000_000, 46).half).toBe(2);
    expect(poolCell(fold, 4_850_000, 10_000_000, 46).tone).toBe("off");
    // No target, no tone; no opportunity, no number.
    expect(poolCell(fold, 50, 100, null).tone).toBe("none");
    expect(poolCell(fold, 0, 0, 46).player).toBeNull();
  });

  it("both types clear the same way: one sentence for regs and fish", () => {
    const fold = stat("flop_fold_vs_bet");
    const reg = poolCell(fold, 700, 1000, 40);
    const fish = poolCell(fold, 300, 500, 40);
    const exploits = exploitsOf(reg, fish);
    expect(exploits).toEqual([{ types: ["reg", "fish"], direction: "high", tone: "far" }]);
    expect(exploitText(fold, exploits[0], words)).toBe("Regs and fish fold the flop too much: bet the flop more.");
    // Opposite ways: a sentence each.
    const calls = poolCell(fold, 100, 500, 40);
    expect(exploitsOf(reg, calls).map((e) => `${e.types.join("+")}:${e.direction}`)).toEqual(["reg:high", "fish:low"]);
  });

  it("without the player's target the row says so and judges nothing", () => {
    const rows = poolRows(ANALYTICS, null, sums([{ stat: "cbet_flop", type: "reg", made: 600, opp: 1000 }]));
    const cbet = row(rows, "cbet_flop");
    expect(cbet.reg.player).toBe(60);
    expect(cbet.reg.tone).toBe("none");
    expect(cbet.exploits).toEqual([]);
    expect(quietMeaning(cbet, words)).toBe("No target yet");
  });

  it("lists every rate in catalogue order, never a share or a coded stat", () => {
    const rows = poolRows(ANALYTICS, null, null);
    expect(rows.map((entry) => entry.stat.id)).toEqual(ANALYTICS.stats.filter((s) => s.kind === "rate").map((s) => s.id));
  });
});

describe("Pool: the words", () => {
  it("every rate has a sentence for each direction in English and Croatian", () => {
    const rates = ANALYTICS.stats.filter((s) => s.kind === "rate").map((s) => s.id);
    for (const pool of [analyticsUiEn.screen.pool, analyticsUiHr.screen.pool]) {
      expect(Object.keys(pool.exploit).sort()).toEqual([...rates].sort());
      for (const id of rates) {
        for (const direction of ["high", "low"] as const) {
          const line = pool.exploit[id][direction]("X");
          expect(line.startsWith("X ")).toBe(true);
          expect(line.endsWith(".")).toBe(true);
        }
      }
    }
    expect(Object.keys(analyticsUiHr.screen.pool).sort()).toEqual(Object.keys(analyticsUiEn.screen.pool).sort());
  });
});

describe("Pool: the figures", () => {
  it("regs : fish by hands, the regs' bb/100 and its standard error from Σx and Σx²", () => {
    const figures = poolFigures(sums([]));
    expect(figures.ratio).toBe(4);
    expect(figures.regRate).toBeCloseTo(-2.3, 9);
    // mean -0.023 bb, sample variance (1,080,000 − 276²/12,000)/11,999 = 90.0068...; SE = √(var/n)·100.
    const variance = (1_080_000 - (276 * 276) / 12_000) / 11_999;
    expect(figures.regSe).toBeCloseTo(Math.sqrt(variance / 12_000) * 100, 9);
    expect(figures.regSe).toBeCloseTo(8.66, 1);
    expect(poolFigures(sums([], empty, empty)).ratio).toBeNull();
    expect(rateOf({ players: 1, hands: 1, netBb: 2, netBbSq: 4 })).toEqual({ bb100: 200, se: null });
  });

  it("the player's win rate with a fish, and with regs only (reg or fish less fish)", () => {
    const report = (hands: number, moneyHands: number, netBbMilli: number | null) =>
      ({ summary: { hands, moneyHands, net: null, netBbMilli, evNetBbMilli: null, stats: [], ids: [] } }) as unknown as Report;
    const you = youRates(report(5_000, 5_000, 740_000), report(18_000, 17_900, 792_000));
    expect(you.fish).toEqual({ hands: 5_000, bb100: 14.8 });
    expect(you.regsOnly?.hands).toBe(13_000);
    expect(you.regsOnly?.bb100).toBeCloseTo((52 * 100) / 12_900, 9);
    expect(youRates(null, null)).toEqual({ fish: null, regsOnly: null });
    expect(youRates(report(0, 0, 0), report(10, 10, null)).regsOnly?.bb100).toBeNull();
  });

  it("the queries reuse the Hands filter's vs type; the pool follows the field's groups (P2)", () => {
    const q = { formats: ["cash"], sites: ["pokerstars", ""], vsTypes: ["unknown"], positions: ["BTN"] };
    expect(youQueries(q).fish.vsTypes).toEqual(["fish"]);
    expect(youQueries(q).regOrFish.vsTypes).toEqual(["reg", "fish"]);
    expect(youQueries(q).fish.positions).toEqual(["BTN"]);
    expect(poolFiltersOf(q)).toEqual({ gameFormat: "cash", formats: ["cash"], sites: ["pokerstars"] });
    expect(poolFiltersOf({ formats: ["mtt", "sng"] })).toEqual({ gameKind: "tournament", formats: ["mtt", "sng"] });
    expect(poolFiltersOf({})).toEqual({});
    // A GG NL50 6-max filter: every field group goes to the server; the
    // groups the pool has no use for (positions, vs type) do not.
    expect(
      poolFiltersOf({
        sites: ["ggpoker"],
        formats: ["cash"],
        variants: ["holdem"],
        limits: ["nl"],
        sizes: ["6max"],
        stakes: ["USD:50"],
        positions: ["BTN"],
        vsTypes: ["fish"],
      }),
    ).toEqual({
      gameFormat: "cash",
      sites: ["ggpoker"],
      formats: ["cash"],
      variants: ["holdem"],
      limits: ["nl"],
      sizes: ["6max"],
      stakes: ["USD:50"],
    });
  });
});

describe("Pool: the counts the web writes", () => {
  const NAMES: Record<string, string> = { Btn: "Hero", Sb: "Alice", Bb: "Bruno", Utg: "Carla", Hj: "Dario", Co: "Eva" };
  const named = (file: string) => {
    let text = readFileSync(join(ROOT, file), "utf8");
    for (const [from, to] of Object.entries(NAMES)) text = text.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    const parsed = parseStandardHand(text, { siteId: "standard", siteName: "standard", originalFilename: null });
    if (!parsed) throw new Error(file);
    return parsed;
  };

  it("every named opponent: the catalogue's counts on their seat and their result", () => {
    const hand = named("core/rail-stats/tests/data/analytics/01-probe-called-river-raise.txt");
    const seats = poolSeats(hand);
    expect(seats.map((s) => s.player).sort()).toEqual(["Alice", "Bruno", "Carla", "Dario", "Eva"]);
    const events = handEvents(hand);
    const rows = statsRows(handFacts(hand));
    for (const seat of seats) {
      const row = rows.find((r) => r.player === seat.player);
      if (!row) throw new Error(seat.player);
      const counts = ANALYTICS.counts(events, events.seats.find((s) => s.seat === row.seat)!);
      const want: Record<string, [number, number]> = {};
      ANALYTICS.stats.forEach((s, i) => {
        if (s.kind === "rate" && counts[i].opp > 0) want[s.id] = [counts[i].made, counts[i].opp];
      });
      expect(seat.stats).toEqual(want);
      expect(seat.net_bb).toBe(row.net_bb_milli / 1000);
    }
    // The big blind probed the turn and check-raised the river.
    const bruno = seats.find((s) => s.player === "Bruno")!;
    expect(bruno.stats.river_raise_vs_bet).toEqual([1, 1]);
    expect(bruno.net_bb).toBeGreaterThan(0);
    expect(poolHand("h1", hand)).toEqual({ hand_id: "h1", players: seats });
  });

  it("nothing from a positional or opaque room, a hand the browser could not read", () => {
    for (const siteId of ["ignition", "ggpoker"]) {
      const hand = named("core/rail-stats/tests/data/analytics/01-probe-called-river-raise.txt");
      hand.meta.siteId = siteId;
      // A name there is a seat or a session, not a person.
      expect(poolSeats(hand)).toEqual([]);
    }
    expect(poolHand("h2", null)).toEqual({ hand_id: "h2", players: [] });
  });
});

/* ------------------------------------------------------------ rendered -- */

function strings(locale: "en" | "hr"): UiStrings {
  return {
    intlLocale: locale === "en" ? "en-GB" : "hr-HR",
    closeNamed: (what: string) => what,
    hands: locale === "en" ? handsUiEn : handsUiHr,
    reports: locale === "en" ? reportsUiEn : reportsUiHr,
    analytics: locale === "en" ? analyticsUiEn : analyticsUiHr,
  } as unknown as UiStrings;
}

const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function render(locale: "en" | "hr", props: Partial<Parameters<typeof Pool>[0]>): string {
  return text(
    renderToStaticMarkup(
      createElement(
        UiStringsProvider,
        { strings: strings(locale) },
        createElement(Pool, {
          catalogue: ANALYTICS,
          result: result({ river_fold_vs_bet: { player: 49, target: 46 } }),
          sums: sums([{ stat: "river_fold_vs_bet", type: "reg", made: 620, opp: 1000 }]),
          withFish: null,
          regOrFish: null,
          show: "all",
          ...props,
        }),
      ),
    ),
  );
}

describe("Pool: rendered", () => {
  it("the figures, the table and the sentence, in English and Croatian", () => {
    const en = render("en", {});
    expect(en).toContain("Regs : fish");
    expect(en).toContain("4.0 : 1");
    expect(en).toContain("12,000 reg hands · 3,000 fish hands");
    expect(en).toContain("−2.3");
    expect(en).toContain("Regs fold the river too much: bluff them more.");
    expect(en).toContain("≈46%");
    expect(en).toContain("What it means for you");
    const hr = render("hr", {});
    expect(hr).toContain("Regovi : fishevi");
    expect(hr).toContain("Regovi previše foldaju river: češće ih blefiraj.");
    expect(hr).toContain("Što to znači za tebe");
  });

  it("the lock instead of everything on the Free plan; one line and a link with nobody typed", () => {
    const locked = render("en", { lock: createElement("p", null, "PRO-LOCK") });
    expect(locked).toContain("PRO-LOCK");
    expect(locked).not.toContain("Regs : fish");
    const none = render("en", { sums: sums([], empty, empty), onAllStats: () => {} });
    expect(none).toContain("No regs or fish at these filters yet.");
    expect(none).toContain("All stats →");
    const counting = render("en", { counting: 1234 });
    expect(counting).toContain("Counting your opponents: 1,234 hands to go.");
  });
});
