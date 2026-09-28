/**
 * The statistics derivation engine, run over the whole corpus.
 *
 * Every `.txt` under `gg-hh/`, `weplay-hh/`, `fixtures/samples/` and
 * `backend/test/fixtures/` is converted with `convertAny` — the same entry
 * point the app uses — and every resulting hand is put through
 * `support/statsInvariants.ts`. Nineteen rooms, nineteen dialects, one
 * derivation.
 *
 * The suite deliberately asserts *properties*, not numbers, because there is no
 * known-good reference to diff against and manufacturing one would only move
 * the question. The one place numbers appear is the plausibility test at the
 * bottom, which is a smoke alarm rather than a spec: it catches a definition
 * that has gone wrong by an order of magnitude, which is the failure mode a
 * property test cannot see.
 */

import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";
import { STATS_COLUMNS, statsRows, type StatsRow } from "../../frontend/src/lib/stats/mapping.js";
import { aggregate, rates } from "../../frontend/src/lib/stats/rates.js";
import { COUNTER_KEYS, STATS_VERSION } from "../../frontend/src/lib/stats/types.js";
import { weplayFiles } from "./support/corpus.js";
import { ggCorpusFiles, readTree, type CorpusFile } from "./support/psggCorpus.js";
import { allStatsInvariants } from "./support/statsInvariants.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

/** Every real hand-history file in the repository, from every room. */
const FILES: CorpusFile[] = [
  ...ggCorpusFiles(),
  ...weplayFiles(),
  ...readTree(join(ROOT, "fixtures/samples"), "fixtures/samples"),
  ...readTree(join(import.meta.dirname, "fixtures"), "backend/test/fixtures"),
];

interface ParsedFile {
  file: CorpusFile;
  hands: PhfHand[];
}

/*
 * Converted once, at module load. `convertAny` is the app's own entry point, so
 * this exercises detection, the parser registry and `assignPositions` exactly
 * as a real upload would - which matters, because `buildContext` only assigns
 * positions when the parser did not, and both paths have to work.
 */
const PARSED: ParsedFile[] = await Promise.all(
  FILES.map(async (file) => {
    try {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      return { file, hands: result.hands };
    } catch {
      // A file no parser claims is the parser suites' problem, not this one.
      return { file, hands: [] };
    }
  }),
);

const HANDS: PhfHand[] = PARSED.flatMap((entry) => entry.hands);
/** Rows grouped by hand, which is how the money identity is stated. */
const BY_HAND: StatsRow[][] = HANDS.map((hand) => statsRows(handFacts(hand)));
const ROWS: StatsRow[] = BY_HAND.flat();

describe("the stats corpus", () => {
  it("has the files and hands it thinks it has", () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(HANDS.length).toBeGreaterThan(5000);
    // Every hand produces at least two rows; a hand with one seat is not a hand.
    expect(ROWS.length).toBeGreaterThan(HANDS.length * 2);
  });

  it("stamps every row with the schema version", () => {
    expect(new Set(ROWS.map((row) => row.stats_version))).toEqual(new Set([STATS_VERSION]));
  });

  it("keeps the column list and the counter set in step", () => {
    // Schema drift: a counter added to types.ts without a column in mapping.ts
    // would be derived, never stored, and read as zero forever.
    for (const key of COUNTER_KEYS) {
      expect(STATS_COLUMNS).toContain(key);
    }
    expect(new Set(STATS_COLUMNS).size).toBe(STATS_COLUMNS.length);
  });
});

describe("the module stays importable from a server", () => {
  /*
   * The hard rule: `lib/stats/**` may import only `lib/phf/types`,
   * `lib/phf/validate` and `lib/cards`. No Supabase, no React, no `window`, no
   * `process`. That is what lets this suite import it directly and what will let
   * a server-side backfill run the identical function. `lib/replay.ts` obeys the
   * same rule; this test is what stops the rule from rotting, because the first
   * `import { supabase }` would work fine in the browser and only fail later.
   */
  const ALLOWED = new Set(["../phf/types", "../phf/validate", "../cards"]);
  const dir = join(import.meta.dirname, "../../frontend/src/lib/stats");
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts"));

  it("has all its files", () => {
    expect(sources.sort()).toEqual([
      "context.ts",
      "derive.ts",
      "index.ts",
      "mapping.ts",
      "money.ts",
      "postflop.ts",
      "preflop.ts",
      "rates.ts",
      "showdown.ts",
      "types.ts",
    ]);
  });

  it.each(sources)("%s imports nothing it may not", (name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    const forbidden = specifiers.filter(
      (specifier) => !specifier.startsWith("./") && !ALLOWED.has(specifier),
    );
    expect(forbidden).toEqual([]);
  });

  it("names no browser or server global", () => {
    for (const name of sources) {
      // Comments are stripped first: the prose in this module talks about "the
      // PHF document" a great deal, and a test that cannot tell that from
      // `document.body` would only teach people to write worse comments.
      const code = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, name).not.toMatch(
        /\b(?:window|document|localStorage|sessionStorage|navigator|fetch|process)\b/,
      );
    }
  });
});

describe("every invariant holds on every hand", () => {
  it.each(PARSED.filter((entry) => entry.hands.length > 0).map((entry) => [entry.file.relativePath, entry] as const))(
    "%s",
    (_name, entry) => {
      const problems = entry.hands.flatMap((hand) => allStatsInvariants(hand));
      expect(problems.slice(0, 5)).toEqual([]);
    },
  );
});

describe("the corpus totals are plausible", () => {
  /*
   * Cash hands only, and Hold'em only. A tournament corpus is mostly short
   * stacks and a mixed-variant one is mostly noise, and neither has the
   * population these ranges were written for.
   */
  const cash = ROWS.filter((row) => row.game_format === "cash" && row.variant === "holdem");
  const totals = aggregate(cash);
  const r = rates(totals);

  it("has a large enough sample to mean anything", () => {
    expect(totals.counters.vpip_opp).toBeGreaterThan(5000);
  });

  it("puts VPIP and PFR in the range a real population lives in", () => {
    // A cash population across nineteen rooms sits somewhere in the 20-45%
    // band; anything outside that is a broken definition, not a table full of
    // maniacs. PFR below VPIP is arithmetic, and is asserted per seat too.
    expect(r.vpip).toBeGreaterThan(15);
    expect(r.vpip).toBeLessThan(60);
    expect(r.pfr).toBeGreaterThan(8);
    expect(r.pfr).toBeLessThan(45);
    expect(r.pfr!).toBeLessThan(r.vpip!);
  });

  it("puts the 3-bet and steal frequencies in range", () => {
    expect(r.threeBet).toBeGreaterThan(2);
    expect(r.threeBet).toBeLessThan(20);
    expect(r.steal).toBeGreaterThan(15);
    expect(r.steal).toBeLessThan(75);
  });

  it("puts the continuation-bet chain in range and in order", () => {
    expect(r.cbetFlop).toBeGreaterThan(35);
    expect(r.cbetFlop).toBeLessThan(90);
    expect(r.cbetTurn).toBeGreaterThan(25);
    expect(r.cbetTurn).toBeLessThan(90);
    // The turn opportunity is a strict subset of the flop one - it needs the
    // flop cbet to have been made *and* called - so it can never be larger.
    expect(totals.counters.cbet_turn_opp).toBeLessThan(totals.counters.cbet_flop_opp);
    expect(totals.counters.cbet_river_opp).toBeLessThan(totals.counters.cbet_turn_opp);
  });

  it("puts the showdown stats in range", () => {
    expect(r.wtsd).toBeGreaterThan(15);
    expect(r.wtsd).toBeLessThan(45);
    expect(r.wsd).toBeGreaterThan(35);
    expect(r.wsd).toBeLessThan(70);
    expect(r.wwsf).toBeGreaterThan(30);
    expect(r.wwsf).toBeLessThan(60);
  });

  it("puts the aggression factor in range", () => {
    expect(r.aggressionFactor).toBeGreaterThan(0.8);
    expect(r.aggressionFactor).toBeLessThan(5);
    expect(r.aggressionFrequency).toBeGreaterThan(20);
    expect(r.aggressionFrequency).toBeLessThan(70);
  });

  it("leaves the table down by exactly the rake, across the whole sample", () => {
    /*
     * Every seat of every hand is in this sample, so once the transfers between
     * players cancel, what is left is the money that crossed the table
     * boundary: the house took the fees out and dropped promotional chips in.
     * The per-hand form of this is `moneyConservation`; this is the same
     * identity summed over tens of thousands of hands, which is what makes a
     * one-cent-per-hand leak visible.
     */
    let net = 0;
    let expected = 0;
    for (const rows of BY_HAND) {
      const first = rows[0];
      if (!first || first.game_format !== "cash" || first.variant !== "holdem") {
        continue;
      }
      if (first.has_cashout || first.is_bomb_pot) {
        continue;
      }
      net += rows.reduce((sum, row) => sum + row.net, 0);
      expected += first.house_into_pot - first.fees;
    }
    expect(net).toBe(expected);
    // Rake is larger than the promotions, so the players are collectively down.
    expect(net).toBeLessThan(0);
  });
});
