/**
 * The Analytics checker rows on the web (docs/ANALYTICS.md Step 2,
 * `web/src/lib/stats/analyticsRows.ts`):
 *
 * - every hero decision of the fixture (`core/rail-stats/tests/data/
 *   analytics/rows/cases.json`: the pinned analytics hands and
 *   `fixtures/stats`, each with a made-up stored analysis) derives exactly
 *   `rows.json` - the file the Rust twin is held to
 *   (`core/rail-stats/tests/analytics_rows.rs`);
 * - those rows sum to `sums.json` - what the web's `analytics_checker` and
 *   the desktop store's checker reader return over the same decisions
 *   (pgTAP `analytics_checker`, which embeds a copy checked here, and
 *   `core/rail-store/tests/checker.rs`);
 * - the size buckets, the best option, the opponent and the rounding read
 *   as documented, and the membership version is pinned to what the rows
 *   read besides the rates.
 *
 * `ANALYTICS_ROWS_WRITE=1 npx vitest run test/analyticsRows.test.ts`
 * rewrites `rows.json`, `sums.json` and the pgTAP test's embedded copies
 * from the TypeScript (then run the Rust tests and the pgTAP test).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSpot, spotKeyOf, spotName } from "../../packages/ui/analytics/spot.js";
import { analyticsUiEn } from "../../packages/ui/strings/analytics.en.js";
import { analyticsUiHr } from "../../packages/ui/strings/analytics.hr.js";
import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import { ANALYTICS, ANALYTICS_MEMBERSHIP_VERSION, rowsFingerprint } from "../../web/src/lib/stats/analytics.js";
import {
  analyticsRows,
  bestOption,
  opponentOf,
  roundHalfAway,
  type AnalyticsRow,
  type RowsDecisionIn,
} from "../../web/src/lib/stats/analyticsRows.js";
import { handEvents } from "../../web/src/lib/stats/events.js";

const ROOT = join(import.meta.dirname, "../..");
const DIR = "core/rail-stats/tests/data/analytics/rows";
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const text = (path: string): string => readFileSync(join(ROOT, path), "utf8");

interface Case {
  file: string;
  decisions: RowsDecisionIn[];
}

interface Group {
  stat: string;
  spot: string;
  size: string;
  handClass: string;
  opps: number;
  oppsTaken: number;
  n: number;
  taken: number;
  refShare: number;
  evHigh: number;
  evLow: number;
  hands: number;
}

const cases = (JSON.parse(text(`${DIR}/cases.json`)) as { cases: Case[] }).cases;

const hand = (file: string) => {
  const parsed = parseStandardHand(text(file), CTX);
  if (!parsed) throw new Error(`${file} did not parse`);
  return parsed;
};

function derived(): Array<{ file: string; rows: AnalyticsRow[] }> {
  return cases.map((c) => ({ file: c.file, rows: analyticsRows(hand(c.file), c.decisions) }));
}

/** The grouped sums `analytics_checker` returns, from rows (the readers' arithmetic). */
function sumsOf(perHand: Array<{ file: string; rows: AnalyticsRow[] }>): { hands: number; groups: Group[] } {
  const groups = new Map<string, Group & { handSet: Set<string> }>();
  for (const { file, rows } of perHand) {
    for (const row of rows) {
      const key = [row.stat, row.spot, row.size, row.handClass].join("\u0000");
      let g = groups.get(key);
      if (!g) {
        g = {
          stat: row.stat,
          spot: row.spot,
          size: row.size,
          handClass: row.handClass,
          opps: 0,
          oppsTaken: 0,
          n: 0,
          taken: 0,
          refShare: 0,
          evHigh: 0,
          evLow: 0,
          hands: 0,
          handSet: new Set(),
        };
        groups.set(key, g);
      }
      g.opps += 1;
      if (row.taken) g.oppsTaken += 1;
      g.handSet.add(file);
      if (row.refShare === null) continue;
      g.n += 1;
      if (row.taken) g.taken += 1;
      g.refShare += row.refShare;
      if (row.taken) g.evHigh += row.evLossBb;
      if (!row.taken && row.bestIn) g.evLow += row.evLossBb;
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    hands: perHand.length,
    groups: [...groups.values()]
      .map(({ handSet, ...g }) => ({
        ...g,
        refShare: roundHalfAway(g.refShare, 6),
        evHigh: roundHalfAway(g.evHigh, 3),
        evLow: roundHalfAway(g.evLow, 3),
        hands: handSet.size,
      }))
      .sort((a, b) => cmp(a.stat, b.stat) || cmp(a.spot, b.spot) || cmp(a.size, b.size) || cmp(a.handClass, b.handClass)),
  };
}

const PGTAP = "supabase/tests/database/analytics_checker.test.sql";

/** The `$name$...$name$` block of the pgTAP test. */
const blockOf = (name: string) => new RegExp(`\\$${name}\\$(.*?)\\$${name}\\$`, "s");

if (process.env.ANALYTICS_ROWS_WRITE === "1") {
  const rows = derived();
  const sums = sumsOf(rows);
  writeFileSync(join(ROOT, `${DIR}/rows.json`), `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(join(ROOT, `${DIR}/sums.json`), `${JSON.stringify(sums, null, 2)}\n`);
  // The pgTAP test's embedded copies, one line each.
  let sql = text(PGTAP);
  const blocks: Array<[string, unknown]> = [
    ["cases", { cases }],
    ["rows", rows],
    ["sums", sums],
  ];
  for (const [name, value] of blocks) {
    sql = sql.replace(blockOf(name), () => `$${name}$${JSON.stringify(value)}$${name}$`);
  }
  writeFileSync(join(ROOT, PGTAP), sql);
}

describe("analyticsRows on the fixture", () => {
  it("derives rows.json", () => {
    expect(derived()).toEqual(JSON.parse(text(`${DIR}/rows.json`)));
  });

  it("sums to sums.json", () => {
    expect(sumsOf(derived())).toEqual(JSON.parse(text(`${DIR}/sums.json`)));
  });

  it("covers what the sums must tell apart", () => {
    const rows = derived().flatMap((h) => h.rows);
    const sizes = new Set(rows.map((r) => r.size));
    expect([...sizes].filter((s) => s !== "").length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.refShare === null)).toBe(true);
    expect(rows.some((r) => r.taken && r.refShare !== null)).toBe(true);
    expect(rows.some((r) => !r.taken && r.bestIn === true)).toBe(true);
    expect(rows.some((r) => r.multiway)).toBe(true);
    expect(new Set(rows.map((r) => r.handClass)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.map((r) => r.stat)).size).toBeGreaterThanOrEqual(10);
    // A group summed over more than one hand.
    expect(sumsOf(derived()).groups.some((g) => g.hands > 1)).toBe(true);
  });

  it("the pgTAP test embeds the same fixture", () => {
    const sql = text(PGTAP);
    const embedded = (name: string): unknown => {
      const match = blockOf(name).exec(sql);
      if (!match) throw new Error(`no $${name}$ block in the pgTAP test`);
      return JSON.parse(match[1]);
    };
    expect(embedded("rows")).toEqual(JSON.parse(text(`${DIR}/rows.json`)));
    expect(embedded("sums")).toEqual(JSON.parse(text(`${DIR}/sums.json`)));
    expect(embedded("cases")).toEqual({ cases });
  });
});

describe("the parts", () => {
  it("size buckets: half-open from each min, rounded to thousandths, nothing for no bet", () => {
    const bucket = (x: number | null) => ANALYTICS.sizeBucket(x)?.id ?? "";
    expect([0.1, 0.3994, 0.3996, 0.4, 0.599, 0.6, 0.849, 0.85, 1.249, 1.2495, 3].map(bucket)).toEqual([
      "20-40",
      "20-40",
      "40-60",
      "40-60",
      "40-60",
      "60-85",
      "60-85",
      "85-125",
      "85-125",
      "125+",
      "125+",
    ]);
    expect([null, 0, -1, Number.NaN].map(bucket)).toEqual(["", "", "", ""]);
  });

  it("the best option: highest EV, then frequency, then the first listed", () => {
    expect(bestOption([{ action: "fold", freq: 0.2, ev: 0 }, { action: "call", freq: 0.8, ev: 1 }])).toBe("call");
    expect(bestOption([{ action: "fold", freq: 0.6, ev: 1 }, { action: "call", freq: 0.4, ev: 1 }])).toBe("fold");
    expect(bestOption([{ action: "call", freq: 0.5, ev: 1 }, { action: "raise", freq: 0.5, ev: 1 }])).toBe("call");
    expect(bestOption([{ action: "call", freq: 0.9 }, { action: "fold", freq: 0.1, ev: -1 }])).toBe("fold");
    expect(bestOption([{ action: "allin", freq: 1, ev: 9 }])).toBeNull();
    expect(bestOption([])).toBeNull();
  });

  it("rounds half away from zero", () => {
    expect([roundHalfAway(0.0005, 3), roundHalfAway(-0.0005, 3), roundHalfAway(1.23456789, 6)]).toEqual([
      0.001, -0.001, 1.234568,
    ]);
  });

  it("the opponent: the street's last aggressor, else the one left, multi, or none preflop", () => {
    const events = handEvents(hand("core/rail-stats/tests/data/analytics/05-fold-to-flop-cbet.txt"));
    const hero = events.seats.find((s) => s.hero)!;
    const [pre, flop] = hero.events;
    expect(opponentOf(events, hero.seat, pre.order, "preflop")).toBe("HJ");
    expect(opponentOf(events, hero.seat, flop.order, "flop")).toBe("HJ");
  });

  it("the membership version is pinned to the hand classes and size buckets too", () => {
    expect([ANALYTICS_MEMBERSHIP_VERSION, createHash("sha256").update(rowsFingerprint()).digest("hex")]).toEqual([
      "analytics/1",
      PINNED_ROWS,
    ]);
  });
});

describe("spot names (packages/ui/analytics/spot.ts)", () => {
  it("names every spot of the fixture in both languages, and round-trips the key", () => {
    const spots = new Set(derived().flatMap((h) => h.rows.map((r) => r.spot)));
    for (const key of spots) {
      expect(spotKeyOf(parseSpot(key))).toBe(key);
      const spot = parseSpot(key);
      // Every pot and role the rows write has words.
      if (spot.pot !== "") expect(Object.keys(analyticsUiEn.spot.pots)).toContain(spot.pot);
      expect(Object.keys(analyticsUiEn.spot.roles)).toContain(spot.role);
      expect(spotName(key, analyticsUiEn.spot)).not.toMatch(/undefined|\|/);
      expect(spotName(key, analyticsUiHr.spot)).not.toMatch(/undefined|\|/);
    }
  });

  it("reads as the board's", () => {
    expect(spotName("3bet|caller|BB|SB", analyticsUiEn.spot)).toBe("BB vs SB · 3-bet pot · as the caller");
    expect(spotName("single-raised|pfr|BTN|multi", analyticsUiEn.spot)).toBe("BTN vs 2+ · Single-raised pot · as the raiser");
    expect(spotName("|unopened|CO|", analyticsUiEn.spot)).toBe("CO · First in");
    expect(spotName("|vs-open|BB|CO", analyticsUiHr.spot)).toBe("BB protiv CO · protiv otvaranja");
  });

  it("the two languages name the same pots and roles", () => {
    expect(Object.keys(analyticsUiHr.spot.pots).sort()).toEqual(Object.keys(analyticsUiEn.spot.pots).sort());
    expect(Object.keys(analyticsUiHr.spot.roles).sort()).toEqual(Object.keys(analyticsUiEn.spot.roles).sort());
  });
});

/** Re-pin with the Rust test (`the_rows_fingerprint_is_pinned`) when a hand class or size bucket changes - and bump the version. */
const PINNED_ROWS = "58038ddfe6d6ff103fa8be05348554d855787b3d964f8a08e59d39c177183a4e";
