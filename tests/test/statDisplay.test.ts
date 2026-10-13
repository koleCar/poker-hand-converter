/**
 * The display definitions of `config/stats/` (docs/RAIL-PLAN.md R2.4,
 * docs/STATS-SPEC.md §13) on the TypeScript side.
 *
 * - `config/stats/standard.json` fits `stats.schema.json` (ajv, draft
 *   2020-12), and the schema refuses what it promises to; the checks a
 *   schema cannot make (formula grammar, names, ids, bands) are
 *   `core/rail-config`'s under `cargo test`, and `compileStats`' here.
 * - The web's copy (`frontend/src/lib/stats/definitions.json`) is the file.
 * - Every string is in every language the web and the app speak.
 * - **Parity.** `core/rail-stats/tests/data/display-vectors.json` holds the
 *   corpus summed as reports sum it plus synthetic totals, and what
 *   `display.ts` showed for each when the file was written; Rust replays it
 *   (`core/rail-stats/tests/display.rs`, which also re-sums the corpus from
 *   its own rows). Here the TypeScript shows the same today, and where
 *   `rates.ts` computes the same statistic its value is the same double and
 *   the web's `Intl.NumberFormat` prints the same text.
 * - **Guideline §14: a new statistic is a definition in `config/stats/`,
 *   not code in the app or the web.** A scan of the web's and the app's
 *   sources for the shapes a hard-coded statistic takes. Honest about its
 *   limits: it is a grep, not a type system. It catches a counter divided by
 *   its opportunity counter, the pair handed to a component side by side,
 *   `pct` imported from `lib/stats`, and the bb/100 division - the ways
 *   every statistic written so far was written. It does not catch a formula
 *   spread over several lines or behind a helper with another name. The
 *   files that do this today are listed with their count; the list may only
 *   shrink (R4.5 moves the screens onto the definitions).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  compileStats,
  evaluate,
  formatFixed,
  parseFormula,
  printFormula,
  showStat,
  statRate,
  type DisplaySums,
  type StatsFile,
} from "../../frontend/src/lib/stats/display.js";
import { STANDARD_STATS } from "../../frontend/src/lib/stats/definitions.js";
import { rates } from "../../frontend/src/lib/stats/rates.js";
import { COUNTER_KEYS, MONEY_KEYS, type SeatCounters, type SeatMoney } from "../../frontend/src/lib/stats/types.js";
import { LOCALES } from "../../frontend/src/lib/i18n/types.js";

const ROOT = join(import.meta.dirname, "../..");
const text = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const read = (path: string): unknown => JSON.parse(text(path));

type Json = Record<string, any>;

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
const validate = ajv.compile(read("config/stats/stats.schema.json") as object);
const shipped = (): Json => read("config/stats/standard.json") as Json;
const stat = (doc: Json, id: string): Json => {
  const found = doc.stats.find((s: Json) => s.id === id);
  if (!found) throw new Error(`no stat ${id}`);
  return found;
};

describe("config/stats/standard.json", () => {
  it("fits its schema", () => {
    const ok = validate(shipped());
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  const refused: [string, (doc: Json) => void][] = [
    ["an unknown field", (d) => (stat(d, "vpip").colour = "red")],
    ["another version", (d) => (d.version = 2)],
    ["an id with capitals", (d) => (stat(d, "vpip").id = "VPIP")],
    ["a label without Croatian", (d) => delete stat(d, "vpip").label.hr],
    ["a label in a language nobody speaks", (d) => (stat(d, "vpip").label.de = "VPIP")],
    ["an empty name", (d) => (stat(d, "vpip").name.en = "")],
    ["an unknown unit", (d) => (stat(d, "vpip").format.unit = "permille")],
    ["seven decimals", (d) => (stat(d, "vpip").format.decimals = 7)],
    ["a fractional sample", (d) => (stat(d, "vpip").sample.min = 2.5)],
    ["an unknown tone", (d) => (stat(d, "vpip").bands[0].tone = "red")],
    ["an unknown group", (d) => (stat(d, "vpip").group = "river")],
    ["an unknown HUD place", (d) => (stat(d, "vpip").hud = "corner")],
    ["a formula with a semicolon", (d) => (stat(d, "vpip").formula = "vpip; drop")],
    ["a formula with capitals", (d) => (stat(d, "vpip").formula = "VPIP / vpip_opp")],
    ["no statistics", (d) => (d.stats = [])],
  ];
  for (const [name, edit] of refused) {
    it(`refuses ${name}`, () => {
      const doc = shipped();
      edit(doc);
      expect(validate(doc)).toBe(false);
    });
  }

  it("compiles: every name a counter, ids unique, bands ascending", () => {
    expect(STANDARD_STATS.length).toBeGreaterThanOrEqual(30);
    const broken: [string, (doc: Json) => void, RegExp][] = [
      ["an unknown counter", (d) => (stat(d, "vpip").formula = "pct(vpip, vpip_op)"), /not a counter/],
      ["a duplicate id", (d) => (stat(d, "pfr").id = "vpip"), /duplicate id/],
      ["EV for villains", (d) => (stat(d, "allin_ev_bb_per_100").players = "any"), /hero only/],
      ["no sample for a ratio", (d) => delete stat(d, "aggression_factor").sample.of, /needs "of"/],
      ["descending bands", (d) => (stat(d, "vpip").bands[1].below = 1), /not above/],
      ["a formula that does not parse", (d) => (stat(d, "vpip").formula = "pct(vpip,"), /does not parse/],
    ];
    for (const [, edit, message] of broken) {
      const doc = shipped();
      edit(doc);
      expect(() => compileStats(doc as StatsFile)).toThrow(message);
    }
  });

  it("the web bundles the same file", () => {
    expect(text("frontend/src/lib/stats/definitions.json")).toBe(text("config/stats/standard.json"));
  });

  it("speaks every language the web and the app speak", () => {
    const appLocales = [...text("app/src/i18n/types.ts").matchAll(/export type Locale = ([^;]+);/g)]
      .flatMap((m) => m[1].split("|"))
      .map((s) => s.trim().replace(/"/g, ""));
    expect([...appLocales].sort()).toEqual([...LOCALES].sort());
    for (const def of shipped().stats) {
      for (const field of ["label", "name", "description"]) {
        expect(Object.keys(def[field]).sort(), `${def.id}.${field}`).toEqual([...LOCALES].sort());
      }
    }
  });
});

/* -------------------------------------------------------------- parity - */

const VECTORS = read("core/rail-stats/tests/data/display-vectors.json") as Json;

/** The statistics `rates()` also computes, by definition id (as in display-vectors.mjs). */
const RATES_KEYS: Record<string, string> = {
  hands: "hands",
  bb_per_100: "bb100",
  net_bb: "netBb",
  vpip: "vpip",
  pfr: "pfr",
  rfi: "rfi",
  limp: "limp",
  iso: "iso",
  cold_call: "coldCall",
  three_bet: "threeBet",
  fold_to_three_bet: "foldToThreeBet",
  four_bet: "fourBet",
  fold_to_four_bet: "foldToFourBet",
  squeeze: "squeeze",
  steal: "steal",
  fold_to_steal: "foldToSteal",
  saw_flop: "sawFlop",
  cbet_flop: "cbetFlop",
  cbet_turn: "cbetTurn",
  cbet_river: "cbetRiver",
  fold_to_cbet_flop: "foldToCbetFlop",
  fold_to_cbet_turn: "foldToCbetTurn",
  donk_flop: "donkFlop",
  check_raise_flop: "checkRaiseFlop",
  aggression_factor: "aggressionFactor",
  aggression_frequency: "aggressionFrequency",
  wwsf: "wwsf",
  wtsd: "wtsd",
  wsd: "wsd",
};

function sumsOf(totals: Array<number | null>): DisplaySums {
  const counters = Object.fromEntries(COUNTER_KEYS.map((k, i) => [k, totals[i]])) as unknown as SeatCounters;
  const money = Object.fromEntries(
    MONEY_KEYS.map((k, i) => [k, totals[COUNTER_KEYS.length + i]]),
  ) as unknown as SeatMoney;
  return {
    counters,
    money,
    moneyHands: totals[COUNTER_KEYS.length + MONEY_KEYS.length] as number,
    evNetBbMilli: totals[COUNTER_KEYS.length + MONEY_KEYS.length + 1],
  };
}

const intl = (decimals: number) =>
  new Intl.NumberFormat("en-GB", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });

describe("display parity (Rust replays the same vectors)", () => {
  it("the vectors were written from these definitions", () => {
    expect(VECTORS.meta.stats).toEqual(STANDARD_STATS.map((s) => s.def.id));
    expect(VECTORS.meta.totals).toEqual([...COUNTER_KEYS, ...MONEY_KEYS, "money_hands", "ev_net_bb_milli"]);
  });

  for (const section of ["groups", "synthetic"] as const) {
    it(`${section}: the TypeScript shows what it showed, and rates() agrees`, () => {
      let againstRates = 0;
      for (const vector of VECTORS[section] as Json[]) {
        const sums = sumsOf(vector.totals);
        const web = rates(sums) as unknown as Record<string, number | null>;
        STANDARD_STATS.forEach((stat, i) => {
          const shown = showStat(stat, sums, 2);
          const line = [
            shown.value === null ? "" : String(shown.value),
            shown.text ?? "",
            shown.tone ?? "",
            shown.sample === null ? "" : String(shown.sample),
            shown.full ? "1" : "0",
          ].join("|");
          expect(line, `${vector.key} ${stat.def.id}`).toBe(vector.out[i]);
          const key = RATES_KEYS[stat.def.id];
          if (key !== undefined) {
            expect(Object.is(web[key], shown.value), `${vector.key} ${stat.def.id} vs rates()`).toBe(true);
            if (shown.value !== null) {
              expect(shown.text).toBe(intl(stat.def.format.decimals).format(shown.value));
            }
            againstRates += 1;
          }
          const rate = statRate(stat, sums);
          if (rate && shown.value !== null) {
            expect(shown.value).toBe((rate.made * 100) / rate.opportunities);
          }
        });
      }
      expect(againstRates).toBeGreaterThan(10_000);
    });
  }

  it("formulas parse, fail and evaluate as recorded", () => {
    const samples = (VECTORS.synthetic as Json[]).map((v) => sumsOf(v.totals));
    for (const vector of VECTORS.formulas as Json[]) {
      if (vector.error !== undefined) {
        expect(() => parseFormula(vector.text), vector.text).toThrow(vector.error);
        continue;
      }
      const expr = parseFormula(vector.text);
      expect(printFormula(expr)).toBe(vector.parsed);
      (vector.values as Array<string | null>).forEach((want, i) => {
        const value = evaluate(expr, samples[i]);
        expect(value === null ? null : String(value), `${vector.text} over synthetic:${i}`).toBe(want);
      });
    }
  });

  it("text is what Intl.NumberFormat prints", () => {
    for (const [value, decimals, want] of VECTORS.formats as Array<[string, number, string]>) {
      const x = Number(value);
      expect(formatFixed(x, decimals)).toBe(want);
      expect(intl(decimals).format(x)).toBe(want);
    }
  });
});

/* ------------------------------------------------------ guideline §14 - */

const SCANNED = ["frontend/src", "app/src", "app/src-tauri/src", "hud"];
const NOT_SCANNED = [
  // The engine: the counters, `rates.ts` (the reference the definitions are
  // held to) and the evaluator itself.
  "frontend/src/lib/stats/",
  // Generated database types (column names, no arithmetic).
  "frontend/src/lib/db/database.types.ts",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name === "target" || name === "dist" || name === "gen") continue;
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) {
      sources(path, out);
    } else if (/\.(ts|tsx|rs)$/.test(name)) {
      out.push(path.split(sep).join("/"));
    }
  }
  return out;
}

const COUNTERS = new Set<string>(COUNTER_KEYS);

/** The shapes a hard-coded displayed statistic takes, one line at a time. */
function hardCodedStats(line: string): string[] {
  const found: string[] = [];
  // A counter and its opportunity counter on one line: `made={c.vpip}
  // opportunities={c.vpip_opp}`, `pct(c.vpip, c.vpip_opp)`, `["vpip", "vpip_opp"]`.
  for (const match of line.matchAll(/\b([a-z][a-z0-9_]*)_opp\b/g)) {
    const made = match[1];
    if (COUNTERS.has(`${made}_opp`) && new RegExp(`\\b${made}\\b(?!_)`).test(line)) {
      found.push(`${made} / ${made}_opp`);
    }
  }
  // Anything divided by an opportunity counter.
  if (/\/\s*[\w.]*\b[a-z_]+_opp\b/.test(line)) found.push("division by an opportunity counter");
  // `pct` from lib/stats outside it.
  if (/import\s*\{[^}]*\bpct\b[^}]*\}\s*from\s*["'][^"']*\bstats["']/.test(line)) found.push("pct imported");
  // bb/100 and big blinds from thousandths.
  if (/net_bb_milli\s*\/\s*(10|1000|1_000)\b/.test(line)) found.push("net_bb_milli division");
  // Rust: a counter pair (`Counter::vpip`, `Counter::vpip_opp`).
  for (const match of line.matchAll(/Counter::([a-z][a-z0-9_]*)_opp\b/g)) {
    if (new RegExp(`Counter::${match[1]}\\b(?!_)`).test(line)) found.push(`Counter::${match[1]} pair`);
  }
  return found;
}

/**
 * Files that compute a displayed statistic outside the definitions today,
 * with how many lines do. R4.5 (screens from `packages/ui`) moves them onto
 * `STANDARD_STATS`; until then a number here may only go down.
 */
const KNOWN: Record<string, number> = {
  // Table columns: each rate from rates(), each opportunity counter read for
  // its sample size.
  "frontend/src/components/stats/BreakdownPanel.tsx": 6,
  // Opponents table: thin-sample marks from opportunity counters (`< 20`; the
  // scan sees the line that names the pair).
  "frontend/src/components/stats/OpponentsPanel.tsx": 1,
  // The learn module's pool statistics: [made, opp] pairs over population data.
  "frontend/src/lib/learn/pool.ts": 8,
  // A villain's VPIP inputs handed to the analysis's player-type heuristic.
  "frontend/src/lib/db/analysis.ts": 1,
};

describe("guideline §14: a new statistic is a definition in config/stats/", () => {
  it("no new hard-coded statistic in the web or the app", () => {
    const counts: Record<string, number> = {};
    const where: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sources(dir)) {
        if (NOT_SCANNED.some((skip) => file.startsWith(skip))) continue;
        text(file)
          .split("\n")
          .forEach((line, i) => {
            const trimmed = line.trim();
            // Comments may name counters; they compute nothing.
            if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
            const found = hardCodedStats(line);
            if (found.length > 0) {
              counts[file] = (counts[file] ?? 0) + 1;
              where.push(`${file}:${i + 1}: ${found.join(", ")}`);
            }
          });
      }
    }
    const over = Object.entries(counts)
      .filter(([file, count]) => count > (KNOWN[file] ?? 0))
      .map(([file]) => where.filter((w) => w.startsWith(`${file}:`)).join("\n"));
    expect(
      over,
      "computed outside config/stats/ (guideline §14): add a definition to " +
        "config/stats/standard.json and read it with STANDARD_STATS",
    ).toEqual([]);
    const fewer = Object.entries(KNOWN)
      .filter(([file, count]) => (counts[file] ?? 0) < count)
      .map(([file, count]) => `${file}: ${counts[file] ?? 0}, KNOWN says ${count}`);
    expect(fewer, "fewer than KNOWN says: lower the count (the list only shrinks)").toEqual([]);
  });

  it("the scan sees what it is meant to see", () => {
    expect(hardCodedStats("<StatTile made={counters.vpip} opportunities={counters.vpip_opp} />")).not.toEqual([]);
    expect(hardCodedStats("const r = c.three_bet / c.three_bet_opp;")).not.toEqual([]);
    expect(hardCodedStats("const r = c.raise_cbet_flop / c.fold_to_cbet_flop_opp;")).not.toEqual([]);
    expect(hardCodedStats('import { pct, rates } from "../../lib/stats";')).not.toEqual([]);
    expect(hardCodedStats("const bb = money.net_bb_milli / 1000;")).not.toEqual([]);
    expect(hardCodedStats("let v = (t.get(Counter::vpip), t.get(Counter::vpip_opp));")).not.toEqual([]);
    expect(hardCodedStats("const sample = row.counters.hands;")).toEqual([]);
    expect(hardCodedStats("const x = pot / bet;")).toEqual([]);
  });

  it("is honest about what it cannot see", () => {
    // Split over lines, or behind another name: not caught. Review catches these.
    expect(hardCodedStats("const made = c.vpip;")).toEqual([]);
    expect(hardCodedStats("const rate = made / opportunities;")).toEqual([]);
  });
});
