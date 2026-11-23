/**
 * The Analytics stat checker (docs/ANALYTICS.md Step 3,
 * `web/src/lib/stats/checker.ts`) and its words
 * (`packages/ui/analytics/findings.ts`):
 *
 * - **Golden vectors.** Every case of `core/rail-stats/tests/data/analytics/
 *   checker/cases.json` (Step 2's fixture sums, and made-up libraries: a
 *   hero who over-folds the flop and turn, a "perfect" hero, preflop leaks,
 *   river shares, a share alone off target, small samples, nothing analysed,
 *   nothing at all) gives exactly `expected.json`'s result - the file the
 *   Rust twin is held to (`core/rail-stats/tests/checker.rs`) - and its
 *   words, English and Croatian: each stat's gap, each finding's headline
 *   and why-sentence.
 * - **Properties** over random sums: no tone stronger than `few` below a
 *   stat's `sample.min` (rows included), and a player equal to the
 *   reference is always `ok`.
 * - What the cases are for, said once in plain assertions.
 *
 * `ANALYTICS_CHECKER_WRITE=1 npx vitest run test/analyticsChecker.test.ts`
 * rewrites `cases.json` (from the builders below) and `expected.json` (from
 * the TypeScript); then run `cargo test -p rail-stats --test checker`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  breakdownName,
  findingHeadline,
  findingWhy,
  gapText,
  percentText,
} from "../../packages/ui/analytics/findings.js";
import type { AnalyticsStrings } from "../../packages/ui/i18n.js";
import { analyticsUiEn } from "../../packages/ui/strings/analytics.en.js";
import { analyticsUiHr } from "../../packages/ui/strings/analytics.hr.js";
import { ANALYTICS } from "../../web/src/lib/stats/analytics.js";
import { roundHalfAway } from "../../web/src/lib/stats/analyticsRows.js";
import {
  checkStats,
  type CheckedStat,
  type CheckerFigures,
  type CheckerGroupIn,
  type CheckerResult,
  type CheckerSumsIn,
  type CodedIn,
} from "../../web/src/lib/stats/checker.js";

const ROOT = join(import.meta.dirname, "../..");
const DIR = "core/rail-stats/tests/data/analytics/checker";
const WRITE = process.env.ANALYTICS_CHECKER_WRITE === "1";
const LANGS: { lang: "en" | "hr"; words: AnalyticsStrings; locale: string }[] = [
  { lang: "en", words: analyticsUiEn, locale: "en-GB" },
  { lang: "hr", words: analyticsUiHr, locale: "hr-HR" },
];

interface Case {
  name: string;
  sums: CheckerSumsIn;
  coded: Record<string, CodedIn>;
}

interface Expected {
  name: string;
  result: CheckerResult;
  text: Record<string, { gaps: Record<string, string>; findings: { headline: string; why: string }[] }>;
}

/* ------------------------------------------------------- the cases -- */

/** Park-Miller: deterministic, exact in doubles. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

const r3 = (x: number) => roundHalfAway(x, 3);
const r6 = (x: number) => roundHalfAway(x, 6);

/** One group: `n` analysed decisions taking the class `p` of the time against a reference `q`. */
function group(
  rnd: () => number,
  stat: string,
  spot: string,
  size: string,
  handClass: string,
  n: number,
  p: number,
  q: number,
): CheckerGroupIn {
  const taken = Math.round(n * p);
  const extra = Math.floor(n / 10);
  const refShare = r6(Math.min(n, n * q * (0.95 + rnd() * 0.1)));
  const gap = p - q;
  return {
    stat,
    spot,
    size,
    handClass,
    opps: n + extra,
    oppsTaken: taken + Math.round(extra * p),
    n,
    taken,
    refShare,
    evHigh: gap > 0 ? r3(taken * gap * (1 + rnd())) : r3(taken * 0.02 * rnd()),
    evLow: gap < 0 ? r3((n - taken) * -gap * (1 + rnd())) : r3((n - taken) * 0.01 * rnd()),
    hands: n,
  };
}

const CLASSES = ANALYTICS.file.handClasses.map((cls) => cls.id);
const POSTFLOP_SIZES = ["20-40", "40-60", "60-85", "85-125"];

/** Fold rates by hand class: the hero's, the solver's. */
const OVERFOLD: Record<string, [number, number]> = {
  top_pair_plus: [0.03, 0.02],
  middle_pair: [0.45, 0.15],
  weak_pair: [0.6, 0.35],
  underpair: [0.55, 0.3],
  strong_draw: [0.3, 0.05],
  gutshot: [0.7, 0.5],
  ace_high_backdoor: [0.75, 0.6],
  overcards: [0.8, 0.65],
  nothing: [0.9, 0.85],
};

function facing(
  rnd: () => number,
  stat: string,
  spots: string[],
  rates: (cls: string) => [number, number],
): CheckerGroupIn[] {
  const out: CheckerGroupIn[] = [];
  for (const spot of spots) {
    for (const size of POSTFLOP_SIZES) {
      for (const cls of CLASSES) {
        const [p, q] = rates(cls);
        out.push(group(rnd, stat, spot, size, cls, 5 + Math.floor(rnd() * 26), p, q));
      }
    }
  }
  return out;
}

function sorted(groups: CheckerGroupIn[]): CheckerGroupIn[] {
  const key = (g: CheckerGroupIn) => [g.stat, g.spot, g.size, g.handClass];
  return groups.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 4; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

function preflopGroups(rnd: () => number, stat: string, spots: [string, number, number, number][]): CheckerGroupIn[] {
  return spots.map(([spot, n, p, q]) => group(rnd, stat, spot, "", "", n, p, q));
}

function overfolder(): Case {
  const rnd = random(11);
  const flopSpots = ["single-raised|caller|BB|BTN", "single-raised|caller|BB|CO", "single-raised|caller|BTN|CO", "3bet|pfr|CO|BTN"];
  const turnSpots = ["single-raised|caller|BB|BTN", "single-raised|pfr|BTN|BB", "single-raised|pfr|CO|BB"];
  const turnFold = facing(rnd, "turn_fold_vs_bet", turnSpots, (cls) => {
    const [p, q] = OVERFOLD[cls];
    return [Math.min(1, p + 0.05), q];
  });
  const probe = turnFold
    .filter((g) => g.spot === "single-raised|pfr|BTN|BB")
    .map((g) => ({ ...g, stat: "turn_fold_vs_probe" }));
  const groups = [
    ...facing(rnd, "flop_fold_vs_bet", flopSpots, (cls) => OVERFOLD[cls]),
    ...facing(rnd, "flop_raise_vs_bet", flopSpots, () => [0.08, 0.08]),
    ...turnFold,
    ...probe,
    ...facing(rnd, "river_fold_vs_bet", ["single-raised|caller|BB|BTN"], () => [0.4, 0.4]),
    ...facing(rnd, "cbet_flop", ["single-raised|pfr|BTN|BB", "single-raised|pfr|CO|BB"], () => [0.55, 0.55]),
    ...preflopGroups(rnd, "vpip", [
      ["|unopened|BTN|", 900, 0.45, 0.45],
      ["|vs-open|BB|BTN", 700, 0.6, 0.6],
    ]),
    ...preflopGroups(rnd, "pfr", [
      ["|unopened|BTN|", 900, 0.44, 0.44],
      ["|vs-open|BB|BTN", 700, 0.12, 0.12],
    ]),
  ];
  return {
    name: "overfolder",
    sums: { hands: 20000, pending: 0, groups: sorted(groups) },
    coded: { wtsd: { made: 520, opp: 1800 }, wsd: { made: 270, opp: 520 }, wwsf: { made: 820, opp: 1800 } },
  };
}

/** Every decision taking the class exactly as often as the reference: integer shares, so the sums are equal. */
function perfect(): Case {
  const rnd = random(29);
  const groups: CheckerGroupIn[] = [];
  for (const stat of ANALYTICS.stats) {
    if (stat.kind !== "rate") continue;
    const preflop = stat.street === "preflop";
    const spots = preflop ? ["|unopened|CO|", "|vs-open|BB|CO"] : ["single-raised|caller|BB|CO", "3bet|pfr|CO|BTN"];
    for (const spot of spots) {
      for (const size of preflop ? [""] : POSTFLOP_SIZES.slice(0, 2)) {
        for (const cls of preflop ? [""] : CLASSES) {
          const n = 20 + Math.floor(rnd() * 80);
          const taken = Math.floor(n * rnd());
          groups.push({
            stat: stat.id,
            spot,
            size,
            handClass: cls,
            opps: n,
            oppsTaken: taken,
            n,
            taken,
            refShare: taken,
            evHigh: r3(taken * 0.05 * rnd()),
            evLow: r3((n - taken) * 0.05 * rnd()),
            hands: n,
          });
        }
      }
    }
  }
  return { name: "perfect", sums: { hands: 60000, pending: 0, groups: sorted(groups) }, coded: {} };
}

function preflop(): Case {
  const rnd = random(47);
  const groups = [
    ...preflopGroups(rnd, "vpip", [
      ["|unopened|BTN|", 1200, 0.62, 0.48],
      ["|unopened|CO|", 1100, 0.4, 0.3],
      ["|vs-open|BB|BTN", 900, 0.7, 0.66],
    ]),
    ...preflopGroups(rnd, "pfr", [
      ["|unopened|BTN|", 1200, 0.38, 0.47],
      ["|unopened|CO|", 1100, 0.24, 0.29],
      ["|vs-open|BB|BTN", 900, 0.1, 0.14],
    ]),
    ...preflopGroups(rnd, "three_bet", [
      ["|vs-open|BB|SB", 400, 0.1, 0.22],
      ["|vs-open|BB|BTN", 600, 0.08, 0.12],
      ["|vs-open|BTN|CO", 300, 0.1, 0.11],
    ]),
    ...preflopGroups(rnd, "bb_fold_vs_steal", [
      ["|vs-open|BB|BTN", 500, 0.6, 0.42],
      ["|vs-open|BB|CO", 300, 0.53, 0.45],
      ["|vs-open|BB|SB", 250, 0.4, 0.38],
    ]),
    ...preflopGroups(rnd, "fold_to_three_bet", [
      ["|vs-3bet|BTN|BB", 220, 0.66, 0.5],
      ["|vs-3bet|CO|BTN", 180, 0.58, 0.52],
    ]),
    ...preflopGroups(rnd, "four_bet", [
      ["|vs-3bet|BTN|BB", 220, 0.04, 0.09],
      ["|vs-3bet|CO|BTN", 180, 0.05, 0.07],
    ]),
    ...preflopGroups(rnd, "rfi", [
      ["|unopened|BTN|", 1200, 0.38, 0.47],
      ["|unopened|CO|", 1100, 0.24, 0.29],
    ]),
  ];
  return { name: "preflop", sums: { hands: 30000, pending: 0, groups: sorted(groups) }, coded: {} };
}

function byClass(
  rnd: () => number,
  stat: string,
  spot: string,
  size: string,
  rows: [string, number, number, number][],
): CheckerGroupIn[] {
  return rows.map(([cls, n, p, q]) => group(rnd, stat, spot, size, cls, n, p, q));
}

function river(): Case {
  const rnd = random(83);
  const spot = "single-raised|pfr|BTN|BB";
  const groups = [
    ...byClass(rnd, "river_bet", spot, "", [
      ["top_pair_plus", 300, 0.6, 0.6],
      ["middle_pair", 200, 0.3, 0.25],
      ["weak_pair", 250, 0.45, 0.15],
      ["nothing", 400, 0.55, 0.35],
      ["overcards", 150, 0.5, 0.3],
    ]),
    ...byClass(rnd, "river_bet", "single-raised|caller|BB|BTN", "", [
      ["top_pair_plus", 120, 0.5, 0.45],
      ["nothing", 160, 0.3, 0.2],
    ]),
    ...byClass(rnd, "river_raise_vs_bet", "single-raised|caller|BB|BTN", "40-60", [
      ["top_pair_plus", 300, 0.15, 0.22],
      ["middle_pair", 150, 0.01, 0.05],
      ["weak_pair", 200, 0.01, 0.04],
      ["nothing", 300, 0.02, 0.1],
    ]),
    ...byClass(rnd, "river_raise_vs_bet", "single-raised|caller|BB|BTN", "85-125", [
      ["top_pair_plus", 200, 0.12, 0.15],
      ["nothing", 200, 0.01, 0.06],
    ]),
  ];
  return { name: "river", sums: { hands: 25000, pending: 0, groups: sorted(groups) }, coded: {} };
}

function shareOnly(): Case {
  const rnd = random(101);
  const groups = [
    ...byClass(rnd, "flop_raise_vs_bet", "single-raised|caller|BB|BTN", "20-40", [
      ["top_pair_plus", 400, 0.05, 0.15],
      ["nothing", 400, 0.15, 0.05],
    ]),
  ].map((g) => ({ ...g, refShare: g.handClass === "nothing" ? 20 : 60 }));
  return { name: "share-only", sums: { hands: 9000, pending: 0, groups }, coded: {} };
}

function few(): Case {
  const rnd = random(131);
  const groups = [
    group(rnd, "flop_fold_vs_bet", "single-raised|caller|BB|BTN", "40-60", "middle_pair", 40, 0.8, 0.3),
    group(rnd, "three_bet", "|vs-open|BB|SB", "", "", 50, 0, 0.2),
    group(rnd, "turn_fold_vs_probe", "single-raised|pfr|BTN|BB", "20-40", "nothing", 20, 1, 0.3),
    group(rnd, "turn_fold_vs_bet", "single-raised|pfr|BTN|BB", "20-40", "nothing", 20, 1, 0.3),
  ];
  return { name: "few", sums: { hands: 400, pending: 3, groups: sorted(groups) }, coded: { wtsd: { made: 3, opp: 9 } } };
}

function unanalysed(): Case {
  const groups: CheckerGroupIn[] = [
    { stat: "cbet_flop", spot: "single-raised|pfr|CO|BB", size: "", handClass: "nothing", opps: 4, oppsTaken: 3, n: 0, taken: 0, refShare: 0, evHigh: 0, evLow: 0, hands: 4 },
    { stat: "river_bet", spot: "single-raised|pfr|CO|BB", size: "", handClass: "weak_pair", opps: 2, oppsTaken: 1, n: 0, taken: 0, refShare: 0, evHigh: 0, evLow: 0, hands: 2 },
    { stat: "vpip", spot: "|unopened|CO|", size: "", handClass: "", opps: 5, oppsTaken: 2, n: 0, taken: 0, refShare: 0, evHigh: 0, evLow: 0, hands: 5 },
  ];
  return { name: "unanalysed", sums: { hands: 9, pending: 12, groups }, coded: { wtsd: { made: 0, opp: 0 } } };
}

function rowsFixture(): Case {
  const sums = JSON.parse(readFileSync(join(ROOT, "core/rail-stats/tests/data/analytics/rows/sums.json"), "utf8")) as {
    hands: number;
    groups: CheckerGroupIn[];
  };
  return {
    name: "rows-fixture",
    sums: { hands: sums.hands, pending: 0, groups: sums.groups },
    coded: { wtsd: { made: 5, opp: 12 }, wsd: { made: 3, opp: 5 } },
  };
}

function buildCases(): Case[] {
  return [
    rowsFixture(),
    overfolder(),
    perfect(),
    preflop(),
    river(),
    shareOnly(),
    few(),
    unanalysed(),
    { name: "empty", sums: { hands: 0, pending: 0, groups: [] }, coded: {} },
  ];
}

/* ---------------------------------------------------------- golden -- */

function textOf(result: CheckerResult): Expected["text"] {
  const out: Expected["text"] = {};
  for (const { lang, words, locale } of LANGS) {
    const gaps: Record<string, string> = {};
    for (const stat of result.stats) {
      const def = ANALYTICS.get(stat.id);
      if (!def) throw new Error(stat.id);
      gaps[stat.id] =
        stat.player === null ? "" : `${percentText(stat.player, words, locale)} · ${gapText(def, stat, words, locale)}`;
    }
    out[lang] = {
      gaps,
      findings: result.findings.map((finding) => ({
        headline: findingHeadline(ANALYTICS, finding, words),
        why: findingWhy(ANALYTICS, finding, words, locale),
      })),
    };
  }
  return out;
}

function expectedOf(cases: Case[]): Expected[] {
  return cases.map((c) => {
    const result = checkStats(ANALYTICS, c.sums, c.coded);
    return { name: c.name, result, text: textOf(result) };
  });
}

/** Indented, with every innermost object (a group, a row) on one line. */
const json = (value: unknown) =>
  `${JSON.stringify(value, null, 1).replace(/\{\n\s*([^{}[\]]*?)\n\s*\}/g, (_m, body: string) => `{${body.replace(/\n\s*/g, " ")}}`)}\n`;

if (WRITE) {
  const cases = buildCases();
  writeFileSync(join(ROOT, DIR, "cases.json"), json({ cases }));
  writeFileSync(join(ROOT, DIR, "expected.json"), json({ cases: expectedOf(cases) }));
}

const CASES = (JSON.parse(readFileSync(join(ROOT, DIR, "cases.json"), "utf8")) as { cases: Case[] }).cases;
const EXPECTED = (JSON.parse(readFileSync(join(ROOT, DIR, "expected.json"), "utf8")) as { cases: Expected[] }).cases;
const byName = (name: string) => {
  const index = CASES.findIndex((c) => c.name === name);
  return { input: CASES[index], expected: EXPECTED[index] };
};

describe("the checker's golden vectors", () => {
  it("are built from the builders here", () => {
    expect(CASES).toEqual(JSON.parse(JSON.stringify(buildCases())));
  });

  it.each(CASES.map((c, i) => [c.name, i] as const))("%s gives the expected result and words", (_name, index) => {
    const c = CASES[index];
    const result = checkStats(ANALYTICS, c.sums, c.coded);
    expect(JSON.parse(JSON.stringify(result))).toEqual(EXPECTED[index].result);
    expect(textOf(result)).toEqual(EXPECTED[index].text);
  });
});

/* ---------------------------------------------------- what it means -- */

const stat = (result: CheckerResult, id: string): CheckedStat => {
  const found = result.stats.find((s) => s.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("the checker", () => {
  it("finds the hero who over-folds the flop and turn: red flop fold, one finding with the probe inside turn fold", () => {
    const { expected } = byName("overfolder");
    const result = expected.result;
    const flop = stat(result, "flop_fold_vs_bet");
    expect(flop.tone).toBe("far");
    expect(flop.direction).toBe("high");
    expect(flop.cost).toBeGreaterThan(0);
    expect(flop.source).toBe("solver");
    const first = result.findings[0];
    expect(first.family).toBe("gives_up");
    expect(first.lean).toBe("tight");
    const ids = Object.fromEntries(first.stats.map((s) => [s.id, s.counted]));
    expect(ids).toEqual({ flop_fold_vs_bet: true, turn_fold_vs_bet: true, turn_fold_vs_probe: false });
    const sum = stat(result, "flop_fold_vs_bet").cost + stat(result, "turn_fold_vs_bet").cost;
    expect(first.cost).toBeCloseTo(sum, 5);
    // The why-sentence reads the class with the most extra folds and what a call is worth there.
    expect(first.why.handClass).not.toBeNull();
    expect(first.why.classWorth).toBeGreaterThan(0);
    expect(expected.text.en.findings[0].headline).toBe("You give up too many pots after the flop");
    expect(expected.text.en.findings[0].why).toMatch(/A call there is worth \d+\.\d\d bb a hand\./);
    expect(expected.text.hr.findings[0].why).toMatch(/Call tamo vrijedi \d+,\d\d bb po ruci\./);
    // Coded stats: the player's number only.
    expect(stat(result, "wtsd")).toMatchObject({ tone: "none", target: null, player: roundHalfAway((520 * 100) / 1800, 6) });
    // The breakdowns: sizes and classes in catalogue order, shares of the folds summing to one.
    expect(flop.sizes.map((r) => r.key)).toEqual(POSTFLOP_SIZES);
    expect(flop.classes.map((r) => r.key)).toEqual(CLASSES);
    expect(flop.classes.reduce((a, r) => a + (r.shareOfTaken ?? 0), 0)).toBeCloseTo(1, 5);
    const costs = flop.spots.map((r) => r.costHigh);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("shows a perfect hero in range everywhere, with no finding", () => {
    const { expected } = byName("perfect");
    for (const s of expected.result.stats) {
      if (s.kind === "coded") continue;
      expect([s.id, s.tone]).toEqual([s.id, "ok"]);
      for (const row of [...s.spots, ...s.sizes]) expect(row.tone === "ok" || row.tone === "none").toBe(true);
    }
    expect(expected.result.findings).toEqual([]);
  });

  it("merges preflop leaks by family and lean, the folds and the 3-bets of one family together", () => {
    const { expected } = byName("preflop");
    const keyed = expected.result.findings.map((f) => `${f.family}.${f.lean}`);
    expect(keyed).toContain("vs_open.tight");
    expect(keyed).toContain("range.loose");
    expect(keyed).toContain("range.tight");
    // PFR and open raise judge the same first decisions: only the costlier is summed.
    const tight = expected.result.findings.find((f) => f.family === "range" && f.lean === "tight");
    expect(tight?.stats.map((s) => s.counted)).toEqual([true, false]);
    expect(tight?.cost).toBe(stat(expected.result, tight?.lead ?? "").cost);
    const vsOpen = expected.result.findings.find((f) => f.family === "vs_open");
    expect(vsOpen?.stats.map((s) => s.id).sort()).toEqual(["bb_fold_vs_steal", "three_bet"]);
    expect(vsOpen?.why.source).toBe("charts");
    expect(vsOpen?.why.handClass).toBeNull();
    expect(vsOpen?.why.spot).not.toBeNull();
    const costs = expected.result.findings.map((f) => f.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("does not count a weak share inside its own rate twice", () => {
    const { expected } = byName("river");
    const loose = expected.result.findings.find((f) => f.family === "river_aggression" && f.lean === "loose");
    const tight = expected.result.findings.find((f) => f.family === "river_aggression" && f.lean === "tight");
    expect(loose?.stats).toEqual([
      { id: "river_bet", counted: true },
      { id: "river_bet_weak", counted: false },
    ]);
    expect(loose?.cost).toBe(stat(expected.result, "river_bet").cost);
    expect(tight?.stats.find((s) => s.id === "river_raise_weak")?.counted).toBe(false);
  });

  it("names a share that leads its finding by itself", () => {
    const { expected } = byName("share-only");
    expect(stat(expected.result, "flop_raise_vs_bet").tone).toBe("ok");
    const share = stat(expected.result, "flop_raise_weak");
    expect(share.tone).toBe("far");
    expect(share.player).toBe(75);
    expect(share.target).toBe(25);
    expect(share.classes.map((r) => [r.key, r.weak])).toEqual([
      ["top_pair_plus", false],
      ["nothing", true],
    ]);
    expect(expected.result.findings).toHaveLength(1);
    expect(expected.result.findings[0].lead).toBe("flop_raise_weak");
    expect(expected.text.en.findings[0].headline).toBe("Too many of your flop raises are bluffs");
    expect(expected.text.hr.findings[0].headline).toBe("Previše tvojih raiseova na flopu su blefovi");
  });

  it("keeps small samples grey and out of the findings", () => {
    const { expected } = byName("few");
    expect(stat(expected.result, "flop_fold_vs_bet").tone).toBe("few");
    expect(stat(expected.result, "three_bet").tone).toBe("few");
    expect(expected.result.findings).toEqual([]);
    expect(expected.text.en.gaps.flop_fold_vs_bet).toBe("80% · Not sure yet");
    expect(expected.text.hr.gaps.flop_fold_vs_bet).toBe("80 % · Još nije sigurno");
    expect(expected.result.pending).toBe(3);
  });

  it("has no target without analysed decisions, and shows the coverage", () => {
    const { expected } = byName("unanalysed");
    const cbet = stat(expected.result, "cbet_flop");
    expect(cbet).toMatchObject({ player: null, target: null, tone: "none", coverage: 0, opps: 4 });
    expect(stat(expected.result, "wtsd").player).toBeNull();
    expect(byName("empty").expected.result.findings).toEqual([]);
  });

  it("names breakdown rows with the spot names and the catalogue labels", () => {
    expect(breakdownName(ANALYTICS, "spot", "3bet|pfr|CO|BTN", analyticsUiEn)).toBe("CO vs BTN · 3-bet pot · as the raiser");
    expect(breakdownName(ANALYTICS, "size", "85-125", analyticsUiHr)).toBe("85–125%");
    expect(breakdownName(ANALYTICS, "class", "weak_pair", analyticsUiHr)).toBe("Treći par ili slabiji");
  });

  it("writes an off-target gap with the stat's words and signed points", () => {
    const def = ANALYTICS.get("flop_fold_vs_bet");
    if (!def) throw new Error("flop_fold_vs_bet");
    const off = { tone: "far", gap: 11.4, direction: "high" } as const;
    expect(gapText(def, off, analyticsUiEn, "en-GB")).toBe("Folds too much · +11 pts");
    expect(gapText(def, { ...off, gap: -3.45, direction: "low" }, analyticsUiHr, "hr-HR")).toBe(
      "Folda premalo · -3,5 p. b.",
    );
  });
});

/* ------------------------------------------------------- properties -- */

const STRONG = new Set(["off", "far"]);

function randomCase(rnd: () => number, equal: boolean): Case {
  const groups: CheckerGroupIn[] = [];
  for (const def of ANALYTICS.stats) {
    if (def.kind !== "rate") continue;
    const spots = 1 + Math.floor(rnd() * 3);
    for (let s = 0; s < spots; s += 1) {
      for (const cls of def.street === "preflop" ? [""] : CLASSES.filter(() => rnd() < 0.4)) {
        // Mostly small samples, now and then a large one.
        const n = rnd() < 0.8 ? Math.floor(rnd() * 60) : Math.floor(rnd() * 3000);
        const taken = Math.floor(n * rnd());
        groups.push({
          stat: def.id,
          spot: `single-raised|caller|BB|S${s}`,
          size: def.street === "preflop" ? "" : POSTFLOP_SIZES[Math.floor(rnd() * 4)],
          handClass: cls,
          opps: n + Math.floor(rnd() * 5),
          oppsTaken: taken,
          n,
          taken,
          refShare: equal ? taken : r6(n * rnd()),
          evHigh: r3(rnd() * taken),
          evLow: r3(rnd() * (n - taken)),
          hands: n,
        });
      }
    }
  }
  return { name: "random", sums: { hands: 1 + Math.floor(rnd() * 50000), pending: 0, groups }, coded: {} };
}

function figuresOf(s: CheckedStat): CheckerFigures[] {
  return [s, ...s.spots, ...s.sizes, ...s.classes];
}

describe("the checker's properties", () => {
  it("never colours a sample under sample.min stronger than few", () => {
    const rnd = random(7);
    for (let i = 0; i < 300; i += 1) {
      const result = checkStats(ANALYTICS, randomCase(rnd, false).sums);
      for (const s of result.stats) {
        const min = ANALYTICS.get(s.id)?.sample.min ?? 0;
        for (const f of figuresOf(s)) {
          if (f.n < min) expect(STRONG.has(f.tone), `${s.id} n=${f.n} ${f.tone}`).toBe(false);
        }
      }
      for (const finding of result.findings) {
        for (const { id } of finding.stats) {
          expect(stat(result, id).n).toBeGreaterThanOrEqual(ANALYTICS.get(id)?.sample.min ?? 0);
        }
      }
    }
  });

  it("always calls a player equal to the reference ok", () => {
    const rnd = random(13);
    for (let i = 0; i < 300; i += 1) {
      const result = checkStats(ANALYTICS, randomCase(rnd, true).sums);
      for (const s of result.stats) {
        if (s.kind === "coded") continue;
        for (const f of figuresOf(s)) {
          if (f.n > 0 && f.target !== null) expect(f.tone, s.id).toBe("ok");
        }
      }
      expect(result.findings).toEqual([]);
    }
  });
});
