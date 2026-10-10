/**
 * Opponents' preflop ranges where the answering chart set has no node
 * (`analysis/18`, ANALYSIS-PLAN §10 2026-10-10, neighbouring ranges):
 *
 * - a line at a depth no set of the table covers, or too rare for its set,
 *   is read on the nearest charted depth below or above
 *   (`range-neighbour-depth`) - but never a flat call of a single raise,
 *   whose chart ranges explain shown hands worse than the placeholder;
 * - a limper who called an isolation raise starts from the placeholder limp
 *   range (`range-limp-call`), not the `call` one;
 * - the flop library's placement keeps the answering set alone;
 * - the worker loads the neighbouring sets a hand needs (`rareLineChartSets`);
 * - since `analysis/19` (ANALYSIS-PLAN §10 2026-10-10, population callers) an
 *   opponent's flat call of a single raise or limp from outside the blinds
 *   starts from the population range fitted on shown hands
 *   (`range-population`), ahead of all of the above; the hero's own range
 *   and the trainers' walks are unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeHand,
  chartRange,
  defaultRange,
  heroSeatOf,
  POPULATION_RANGES,
  populationLine,
  populationRange,
  preflopClassRange,
  WALK_RANGE_OPTIONS,
  walkMultiway,
  walkRanges,
  type DecisionAnalysis,
  type PopulationLine,
} from "../../frontend/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, rareLineChartSets, uncoveredDepthSets, type PreflopSpot } from "../../frontend/src/lib/charts/index.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
import { chartSet, fullLibrary } from "./charts/support.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";
const SEATS = ["Btn", "Sb", "Bb", "Utg", "Hj", "Co"];
const LIBRARY = fullLibrary();

let serial = 0;
/** A six-handed $0.5/$1 hand from its action lines, every stack `stack` dollars. */
function hand(hero: string, cards: string, lines: string[], stack = 100): PhfHand {
  serial += 1;
  const text = [
    `Poker Hand #NR${serial}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    "Table 'Nr' 6-max Seat #1 is the button",
    ...SEATS.map((name, i) => `Seat ${i + 1}: ${name} ($${stack} in chips)`),
    "Sb: posts small blind $0.5",
    "Bb: posts big blind $1",
    "*** HOLE CARDS ***",
    `Dealt to ${hero} [${cards}]`,
    ...lines,
    "*** SHOWDOWN ***",
    "Co collected $20 from pot",
    "*** SUMMARY ***",
    `Total pot $20 ${FEES}`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

const seatOf = (h: PhfHand, name: string) => h.players.find((p) => p.name === name)!.seat;
const firstPostflop = (h: PhfHand) => h.actions.find((a) => a.street !== "preflop" && a.street !== "showdown")!.index;
const decisionOn = (decisions: DecisionAnalysis[], street: string, action: string) => {
  const found = decisions.find((d) => d.street === street && d.action === action);
  if (!found) throw new Error(`no ${street} ${action}`);
  return found;
};

/* ---------------------------------------------------- neighbouring depth - */

describe("a line at a depth no set covers, read on the nearest charted depth (analysis/18)", () => {
  // 75bb: outside 60bb ±20% (48-72) and 100bb ±20% (80-120).
  /** CO opens, the button 3-bets, the cutoff (hero) calls; the button bets the flop and the hero calls. */
  const threeBet = () =>
    hand(
      "Co",
      "Qs Qd",
      [
        "Utg: folds",
        "Hj: folds",
        "Co: raises $1.5 to $2.5",
        "Btn: raises $5.5 to $8",
        "Sb: folds",
        "Bb: folds",
        "Co: calls $5.5",
        "*** FLOP *** [Kd 7c 2s]",
        "Co: checks",
        "Btn: bets $6",
        "Co: calls $6",
      ],
      75,
    );

  it("lists the nearest depth below and above, nearest first, never further", () => {
    const spot = (players: number, bb: number, straddle = false): PreflopSpot => {
      const positions = (players === 6 ? ["UTG", "HJ", "CO", "BTN", "SB", "BB"] : ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"]) as PreflopSpot["positions"];
      return { positions, hero: "BTN", actions: [], stacksBb: Object.fromEntries(positions.map((p) => [p, bb])), straddle };
    };
    const depths = (s: PreflopSpot) => uncoveredDepthSets(CHART_SETS, s).map((x) => x.stackBb);
    expect(depths(spot(6, 75))).toEqual([60, 100]);
    expect(depths(spot(6, 95))).toEqual([100, 60]);
    expect(depths(spot(6, 25))).toEqual([40]);
    expect(depths(spot(6, 300))).toEqual([200]);
    expect(depths(spot(9, 50))).toEqual([100]);
    expect(depths(spot(9, 300))).toEqual([200]);
    expect(depths(spot(6, 75, true))).toEqual([]);
  });

  it("reads a 3-bettor's range on the neighbouring set, flagged; without the option it is refused", () => {
    const h = threeBet();
    const btn = seatOf(h, "Btn");
    const cut = firstPostflop(h);
    expect(chartRange(h, btn, cut, LIBRARY)).toBeNull();
    const read = chartRange(h, btn, cut, LIBRARY, WALK_RANGE_OPTIONS);
    expect(read).not.toBeNull();
    expect(read!.approx).toEqual(["range-neighbour-depth"]);
    expect(read!.combos).toBeGreaterThan(1);
    // AA is in any 3-betting range; 72o in none.
    expect(read!.range.get("AA") ?? 0).toBeGreaterThan(0);
    expect(read!.range.get("72o") ?? 0).toBe(0);
    // The hero's own call of the 3-bet is read the same way.
    expect(chartRange(h, seatOf(h, "Co"), cut, LIBRARY, WALK_RANGE_OPTIONS)?.approx).toEqual(["range-neighbour-depth"]);
  });

  it("keeps a flat call of a single raise on the placeholder", () => {
    const h = hand(
      "Co",
      "Qs Qd",
      ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: calls $2.5", "Sb: folds", "Bb: folds", "*** FLOP *** [Kd 7c 2s]", "Co: bets $3", "Btn: calls $3"],
      75,
    );
    const btn = seatOf(h, "Btn");
    expect(chartRange(h, btn, firstPostflop(h), LIBRARY, WALK_RANGE_OPTIONS)).toBeNull();
    const context = buildContext(structuredClone(h));
    const range = preflopClassRange(h, context, btn, firstPostflop(h), LIBRARY);
    expect(range).toMatchObject({ source: "placeholder", label: "call:BTN", approx: [] });
    // The opener's range is read on the neighbouring depth.
    expect(preflopClassRange(h, context, seatOf(h, "Co"), firstPostflop(h), LIBRARY)).toMatchObject({ source: "chart", approx: ["range-neighbour-depth"] });
  });

  it("starts the walk from it, and the decision says so in both languages", () => {
    const h = threeBet();
    const context = buildContext(structuredClone(h));
    const hero = heroSeatOf(context)!;
    const walk = walkRanges(h, context, hero, seatOf(h, "Btn"), LIBRARY);
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.sources).toEqual({ hero: "chart", villain: "chart" });
    expect(walk.approx.villain).toEqual(["range-neighbour-depth"]);
    const call = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false }).decisions, "flop", "call");
    expect(call.facts.equity?.source).toBe("narrowed");
    expect(call.approximations).toContain("range-neighbour-depth");
    expect(call.approximations).not.toContain("placeholder-range");
    expect(en.analysis.approximations["range-neighbour-depth"]).toBeTruthy();
    expect(hr.analysis.approximations["range-neighbour-depth"]).toBeTruthy();
  });

  it("lists the neighbouring sets for loading, and reads nothing it has not loaded", () => {
    const h = threeBet();
    const only = chartLibrary([chartSet(DEFAULT_CHART_SET)]);
    expect(rareLineChartSets(h, only)).toEqual(["nlhe-cash-6max-100bb", "nlhe-cash-6max-60bb"]);
    // With only the 100bb set loaded, the 60bb read is skipped and the 100bb one answers.
    const read = chartRange(h, seatOf(h, "Btn"), firstPostflop(h), only, WALK_RANGE_OPTIONS);
    expect(read?.approx).toEqual(["range-neighbour-depth"]);
    const none = chartLibrary([chartSet("nlhe-cash-9max-100bb")]);
    expect(chartRange(h, seatOf(h, "Btn"), firstPostflop(h), none, WALK_RANGE_OPTIONS)).toBeNull();
  });
});

/* ------------------------------------------------------------ limp-call - */

/** UTG limps, the cutoff isolates, the big blind and UTG call: three see the flop; UTG bets, the hero (BB) calls. */
const limpCall = () =>
  hand("Bb", "Ks Jd", [
    "Utg: calls $1",
    "Hj: folds",
    "Co: raises $4 to $5",
    "Btn: folds",
    "Sb: folds",
    "Bb: calls $4",
    "Utg: calls $4",
    "*** FLOP *** [Kd 7c 2s]",
    "Bb: checks",
    "Utg: bets $8",
    "Co: folds",
    "Bb: calls $8",
  ]);

describe("a limper who called an isolation raise starts from the limp placeholder (analysis/18)", () => {
  it("reads the limp range, labelled, where the call placeholder was read before", () => {
    const h = limpCall();
    const utg = seatOf(h, "Utg");
    const context = buildContext(structuredClone(h));
    expect(chartRange(h, utg, firstPostflop(h), LIBRARY, WALK_RANGE_OPTIONS)).toBeNull();
    const range = preflopClassRange(h, context, utg, firstPostflop(h), LIBRARY)!;
    expect(range).toMatchObject({ source: "placeholder", label: "limp:UTG", approx: ["range-limp-call"] });
    expect([...range.range]).toEqual([...defaultRange("limp", "UTG").range]);
    // A cold caller of the same raise keeps the call placeholder.
    expect(preflopClassRange(h, context, seatOf(h, "Bb"), firstPostflop(h), LIBRARY)?.approx).toEqual([]);
  });

  it("carries the flag through the multiway walk, without the analysis' population ranges", () => {
    const h = limpCall();
    const context = buildContext(structuredClone(h));
    const hero = heroSeatOf(context)!;
    // As the trainers walk it: no population option.
    const walk = walkMultiway(h, context, hero, LIBRARY);
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.labels.get(seatOf(h, "Utg"))).toBe("limp:UTG");
    expect(walk.approx.get(seatOf(h, "Utg"))).toEqual(["range-limp-call"]);
    expect(en.analysis.approximations["range-limp-call"]).toBeTruthy();
    expect(hr.analysis.approximations["range-limp-call"]).toBeTruthy();
    // The analysis reads the opponent's population range ahead of it (analysis/19).
    const call = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false }).decisions, "flop", "call");
    const utg = call.facts.multiway?.opponents.find((o) => o.position === "UTG");
    expect(utg).toMatchObject({ range: "limp-call:UTG", source: "placeholder", approx: ["range-population"] });
    expect(call.approximations).toEqual(expect.arrayContaining(["range-population", "placeholder-range"]));
    expect(call.approximations).not.toContain("range-limp-call");
  });
});

/* ----------------------------------------------------------- population - */

describe("opponents' flat calls and limps start from the population range (analysis/19)", () => {
  const combos = (range: ReadonlyMap<string, number>) =>
    [...range].reduce((sum, [name, w]) => sum + w * (name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12), 0);
  const LINES: PopulationLine[] = ["cold-call", "bb-defence", "first-limp", "over-limp", "limp-call"];

  /** CO (hero) opens, the button flats; heads-up flop: the hero checks, the button bets, the hero calls. */
  const coldCall = (stack = 100) =>
    hand(
      "Co",
      "Ah Qd",
      ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: calls $2.5", "Sb: folds", "Bb: folds", "*** FLOP *** [Kd 7c 2s]", "Co: checks", "Btn: bets $3", "Co: calls $3"],
      stack,
    );

  it("is the stored fit: weights in 0..1, a shape the charts do not have", () => {
    expect(POPULATION_RANGES).toBe("population/1");
    for (const line of LINES) {
      const range = populationRange(line);
      expect(range.size).toBe(169);
      for (const w of range.values()) {
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThan(1);
      }
      // Suited aces and connectors over offsuit trash, on every line.
      expect(range.get("A5s")!).toBeGreaterThan(range.get("K4o")!);
      expect(range.get("T9s")!).toBeGreaterThan(range.get("72o")!);
      expect(populationRange(line)).toBe(range);
    }
    // A cold call is wide (about 40% of hands) and flats small pairs more than aces, which re-raise.
    const cold = populationRange("cold-call");
    expect(combos(cold)).toBeGreaterThan(500);
    expect(combos(cold)).toBeLessThan(580);
    expect(cold.get("22")!).toBeGreaterThan(cold.get("AA")!);
    // The big blind defends wider than a cold caller, and limpers limp wider still.
    expect(combos(populationRange("bb-defence"))).toBeGreaterThan(combos(cold));
    expect(combos(populationRange("first-limp"))).toBeGreaterThan(combos(populationRange("bb-defence")));
  });

  it("names the line: cold call, big blind defence, first limp, over-limp, limp-call; nothing else", () => {
    const lineOf = (h: PhfHand, name: string) => populationLine(h, buildContext(structuredClone(h)), seatOf(h, name), Number.MAX_SAFE_INTEGER);
    const flat = coldCall();
    expect(lineOf(flat, "Btn")).toBe("cold-call");
    expect(lineOf(flat, "Co")).toBeNull();
    const bb = hand("Co", "Ah Qd", ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: folds", "Sb: folds", "Bb: calls $1.5", "*** FLOP *** [Kd 7c 2s]", "Bb: checks", "Co: checks"]);
    expect(lineOf(bb, "Bb")).toBe("bb-defence");
    const limps = hand("Co", "Ah Qd", ["Utg: calls $1", "Hj: calls $1", "Co: folds", "Btn: folds", "Sb: calls $0.5", "Bb: checks", "*** FLOP *** [Kd 7c 2s]", "Sb: checks", "Bb: checks", "Utg: checks", "Hj: checks"]);
    expect(lineOf(limps, "Utg")).toBe("first-limp");
    expect(lineOf(limps, "Hj")).toBe("over-limp");
    // The small blind's completion and the big blind's check are the charts' (blind against blind).
    expect(lineOf(limps, "Sb")).toBeNull();
    expect(lineOf(limps, "Bb")).toBeNull();
    const lc = limpCall();
    expect(lineOf(lc, "Utg")).toBe("limp-call");
    expect(lineOf(lc, "Bb")).toBe("bb-defence");
    // A call of an all-in is another decision.
    const shove = hand("Co", "Ah Qd", ["Utg: folds", "Hj: folds", "Co: raises $99 to $100 and is all-in", "Btn: calls $100 and is all-in", "Sb: folds", "Bb: folds", "*** FLOP *** [Kd 7c 2s]"]);
    expect(lineOf(shove, "Btn")).toBeNull();
  });

  it("is read for opponents only, and only when the analysis asks", () => {
    const h = coldCall();
    const context = buildContext(structuredClone(h));
    const hero = heroSeatOf(context)!;
    const btn = seatOf(h, "Btn");
    const read = preflopClassRange(h, context, btn, firstPostflop(h), LIBRARY, { populationHero: hero })!;
    expect(read).toMatchObject({ source: "placeholder", label: "cold-call:BTN", approx: ["range-population"] });
    expect([...read.range]).toEqual([...populationRange("cold-call")]);
    // Without the option (the trainers) the line reads as before analysis/19.
    expect(preflopClassRange(h, context, btn, firstPostflop(h), LIBRARY)?.approx).not.toContain("range-population");
    // The hero's own flat call is never the population's.
    const heroFlat = hand("Btn", "Ah Qd", ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: calls $2.5", "Sb: folds", "Bb: folds", "*** FLOP *** [Kd 7c 2s]", "Co: checks", "Btn: checks"]);
    const heroContext = buildContext(structuredClone(heroFlat));
    const heroSeat = heroSeatOf(heroContext)!;
    expect(preflopClassRange(heroFlat, heroContext, heroSeat, firstPostflop(heroFlat), LIBRARY, { populationHero: heroSeat })?.approx).not.toContain(
      "range-population",
    );
  });

  it("starts the heads-up walk from it, and the decision says so in both languages", () => {
    const h = coldCall();
    const context = buildContext(structuredClone(h));
    const hero = heroSeatOf(context)!;
    const walk = walkRanges(h, context, hero, seatOf(h, "Btn"), LIBRARY, undefined, { populationHero: hero });
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.labels.villain).toBe("cold-call:BTN");
    expect(walk.approx).toEqual({ hero: [], villain: ["range-population"] });
    const call = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false }).decisions, "flop", "call");
    expect(call.approximations).toEqual(expect.arrayContaining(["range-population", "placeholder-range"]));
    expect(en.analysis.approximations["range-population"]).toBeTruthy();
    expect(hr.analysis.approximations["range-population"]).toBeTruthy();
  });
});
