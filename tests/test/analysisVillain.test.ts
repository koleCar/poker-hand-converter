/**
 * Opponents' own statistics moving their population range (`analysis/20`,
 * ANALYSIS-PLAN §10 2026-10-10, villain statistics; `lib/analysis/villain.ts`):
 *
 * - a big blind who flat-called a raise, with at least `VILLAIN_MIN_HANDS`
 *   hands behind their statistics, starts from the population range moved
 *   by their VPIP − PFR, shrunk toward the pool's rate by the sample
 *   (`range-villain`); no other line moves (held out, none gained);
 * - fewer hands, no statistics, or statistics of somebody else: nothing moves;
 * - the decision shows the sample (`SpotFacts.villain`), and the study views
 *   can hand the same statistics back (`villainsOfFacts`);
 * - both languages name the flag, the sample and the population lines.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeHand,
  heroSeatOf,
  populationRange,
  preflopClassRange,
  VILLAIN_LINES,
  VILLAIN_MIN_HANDS,
  VILLAIN_POOL_PASSIVE,
  VILLAIN_PRIOR_HANDS,
  VILLAIN_RANGES,
  villainKey,
  villainRange,
  villainSample,
  villainsOfFacts,
  walkRanges,
  type DecisionAnalysis,
  type PopulationLine,
  type VillainStats,
} from "../../frontend/src/lib/analysis/index.js";
import type { ClassWeights } from "../../frontend/src/lib/equity/range.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
import { fullLibrary } from "./charts/support.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const FEES = "| Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0";
const SEATS = ["Btn", "Sb", "Bb", "Utg", "Hj", "Co"];
const LIBRARY = fullLibrary();

let serial = 0;
/** A six-handed $0.5/$1 hand from its action lines. */
function hand(hero: string, cards: string, lines: string[]): PhfHand {
  serial += 1;
  const text = [
    `Poker Hand #NV${serial}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    "Table 'Nv' 6-max Seat #1 is the button",
    ...SEATS.map((name, i) => `Seat ${i + 1}: ${name} ($100 in chips)`),
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
const combos = (range: ClassWeights) => {
  let total = 0;
  for (const [name, w] of range) total += w * (name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12);
  return total;
};
const decisionOn = (decisions: DecisionAnalysis[], street: string, action: string) => {
  const found = decisions.find((d) => d.street === street && d.action === action);
  if (!found) throw new Error(`no ${street} ${action}`);
  return found;
};

/** CO (hero) opens, the big blind flats; heads-up flop: the big blind bets, the hero calls. */
const bbDefence = () =>
  hand("Co", "Ah Qd", ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: folds", "Sb: folds", "Bb: calls $1.5", "*** FLOP *** [Kd 7c 2s]", "Bb: bets $3", "Co: calls $3"]);
/** CO (hero) opens, the button flats. */
const coldCall = () =>
  hand("Co", "Ah Qd", ["Utg: folds", "Hj: folds", "Co: raises $1.5 to $2.5", "Btn: calls $2.5", "Sb: folds", "Bb: folds", "*** FLOP *** [Kd 7c 2s]", "Co: checks", "Btn: bets $3", "Co: calls $3"]);

/** A player who calls far more than the pool: VPIP 60%, PFR 10% over `hands`. */
const loose = (hands: number): VillainStats => ({ vpipOpp: hands, vpip: Math.round(hands * 0.6), pfr: Math.round(hands * 0.1) });
/** A player who almost never calls: VPIP 14%, PFR 12%. */
const tight = (hands: number): VillainStats => ({ vpipOpp: hands, vpip: Math.round(hands * 0.14), pfr: Math.round(hands * 0.12) });

describe("villain statistics (analysis/20)", () => {
  it("is the stored rule: the big blind's defence only, 30 hands at least, shrunk by 15", () => {
    expect(VILLAIN_RANGES).toBe("villain/1");
    expect(VILLAIN_LINES).toEqual(["bb-defence"]);
    expect(VILLAIN_MIN_HANDS).toBe(30);
    expect(VILLAIN_PRIOR_HANDS).toBe(15);
    expect(VILLAIN_POOL_PASSIVE).toBeGreaterThan(0.1);
    expect(VILLAIN_POOL_PASSIVE).toBeLessThan(0.3);
    const others: PopulationLine[] = ["cold-call", "first-limp", "over-limp", "limp-call"];
    for (const line of others) expect(villainSample(line, loose(500))).toBeNull();
  });

  it("does nothing below the minimum sample, without statistics, or with nonsense", () => {
    expect(villainSample("bb-defence", loose(VILLAIN_MIN_HANDS - 1))).toBeNull();
    expect(villainSample("bb-defence", loose(VILLAIN_MIN_HANDS))).not.toBeNull();
    expect(villainSample("bb-defence", null)).toBeNull();
    expect(villainSample("bb-defence", undefined)).toBeNull();
    expect(villainSample("bb-defence", { vpipOpp: Number.NaN, vpip: 10, pfr: 2 })).toBeNull();
    expect(villainSample("bb-defence", { vpipOpp: 100, vpip: -1, pfr: 2 })).toBeNull();
    // More PFR than VPIP (a broken row) reads as no passive money at all, not a negative rate.
    expect(villainSample("bb-defence", { vpipOpp: 100, vpip: 10, pfr: 20 })!.passive).toBe(0);
  });

  it("shrinks the player's rate toward the pool's by the sample", () => {
    const small = villainSample("bb-defence", loose(30))!;
    const large = villainSample("bb-defence", loose(3000))!;
    // (made + k·pool) / (hands + k), exactly.
    expect(small.shrunk).toBeCloseTo((15 + VILLAIN_PRIOR_HANDS * VILLAIN_POOL_PASSIVE) / (30 + VILLAIN_PRIOR_HANDS), 4);
    expect(small.passive).toBe(0.5);
    expect(large.passive).toBe(0.5);
    // The same rate moves the range further on a larger sample, and the shrunk rate tends to the player's.
    expect(small.shrunk).toBeLessThan(large.shrunk);
    expect(large.shrunk).toBeCloseTo(0.5, 2);
    expect(large.shift).toBeGreaterThan(small.shift);
    expect(small.shift).toBeGreaterThan(0);
    // A tight player narrows the range, a loose one widens it.
    const narrow = villainSample("bb-defence", tight(400))!;
    expect(narrow.shift).toBeLessThan(0);
    const population = combos(populationRange("bb-defence"));
    expect(combos(villainRange("bb-defence", large))).toBeGreaterThan(population);
    expect(combos(villainRange("bb-defence", narrow))).toBeLessThan(population);
    for (const w of villainRange("bb-defence", large).values()) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThan(1);
    }
    // Deterministic: the same counters, the same range.
    expect([...villainRange("bb-defence", large)]).toEqual([...villainRange("bb-defence", villainSample("bb-defence", loose(3000))!)]);
  });

  it("moves an opponent's big blind defence only, looked up by room and name", () => {
    const h = bbDefence();
    const context = buildContext(structuredClone(h));
    const hero = heroSeatOf(context)!;
    const bb = seatOf(h, "Bb");
    const villains = { [villainKey("standard", "Bb")]: loose(400) };
    const read = preflopClassRange(h, context, bb, firstPostflop(h), LIBRARY, { populationHero: hero, villains })!;
    expect(read).toMatchObject({ source: "placeholder", label: "bb-defence:BB", approx: ["range-population", "range-villain"] });
    expect(read.villain).toMatchObject({ hands: 400, passive: 0.5, stats: loose(400) });
    expect(combos(read.range)).toBeGreaterThan(combos(populationRange("bb-defence")));
    // No statistics, somebody else's, another room's: the population range.
    for (const other of [undefined, null, { [villainKey("standard", "Btn")]: loose(400) }, { [villainKey("weplay", "Bb")]: loose(400) }]) {
      const plain = preflopClassRange(h, context, bb, firstPostflop(h), LIBRARY, { populationHero: hero, villains: other })!;
      expect(plain.approx).toEqual(["range-population"]);
      expect(plain.villain).toBeUndefined();
      expect([...plain.range]).toEqual([...populationRange("bb-defence")]);
    }
    // A cold caller's statistics do not move their range (held out, no gain).
    const flat = coldCall();
    const flatContext = buildContext(structuredClone(flat));
    const flatRead = preflopClassRange(flat, flatContext, seatOf(flat, "Btn"), firstPostflop(flat), LIBRARY, {
      populationHero: heroSeatOf(flatContext)!,
      villains: { [villainKey("standard", "Btn")]: loose(400) },
    })!;
    expect(flatRead.approx).toEqual(["range-population"]);
  });

  it("carries the flag and the sample to the decision, and nothing without statistics", () => {
    const h = bbDefence();
    const context = buildContext(structuredClone(h));
    const hero = heroSeatOf(context)!;
    const villains = { [villainKey("standard", "Bb")]: tight(250) };
    const walk = walkRanges(h, context, hero, seatOf(h, "Bb"), LIBRARY, undefined, { populationHero: hero, villains });
    expect(walk.ok && walk.approx.villain).toEqual(["range-population", "range-villain"]);

    const plain = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false }).decisions, "flop", "call");
    expect(plain.approximations).toContain("range-population");
    expect(plain.approximations).not.toContain("range-villain");
    expect(plain.facts.villain).toBeUndefined();

    const moved = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false, villains }).decisions, "flop", "call");
    expect(moved.approximations).toEqual(expect.arrayContaining(["range-population", "range-villain"]));
    expect(moved.facts.villain).toMatchObject({ position: "BB", range: "bb-defence:BB", hands: 250, stats: tight(250) });
    // A tighter range: the hero's equity against it is lower.
    expect(moved.facts.equity!.value).toBeLessThan(plain.facts.equity!.value);
    // The preflop decision read no range the statistics moved.
    const open = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false, villains }).decisions, "preflop", "raise");
    expect(open.facts.villain).toBeUndefined();

    // Below the minimum sample the analysis is exactly the population's.
    const few = analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false, villains: { [villainKey("standard", "Bb")]: tight(VILLAIN_MIN_HANDS - 1) } });
    expect(JSON.stringify(few)).toBe(JSON.stringify(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false })));
  });

  it("hands the stored statistics back for a study re-run", () => {
    const h = bbDefence();
    const villains = { [villainKey("standard", "Bb")]: loose(120) };
    const moved = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false, villains }).decisions, "flop", "call");
    expect(villainsOfFacts(h, moved.facts.villain)).toEqual(villains);
    expect(villainsOfFacts(h, null)).toEqual({});
    const again = decisionOn(analyzeHand(structuredClone(h), { charts: LIBRARY, turn: false, villains: villainsOfFacts(h, moved.facts.villain) }).decisions, "flop", "call");
    expect(again).toEqual(moved);
  });

  it("is named in both languages, with the sample, and the population lines read as lines", () => {
    for (const dict of [en, hr]) {
      expect(dict.analysis.approximations["range-villain"]).toBeTruthy();
      expect(dict.analysis.sheet.facts.villain).toBeTruthy();
      const text = dict.analysis.sheet.villainValue("bb-defence:BB", 0.25, 312);
      expect(text).toContain("312");
      expect(text).toContain("25");
      expect(text).toContain("BB");
    }
    // analysis/19's labels used to fall through to "any two cards".
    expect(en.analysis.sheet.equityValue(0.5, "bb-defence:BB")).not.toContain("any two");
    expect(en.analysis.sheet.equityValue(0.5, "cold-call:BTN")).toContain("BTN cold call");
    expect(hr.analysis.sheet.equityValue(0.5, "limp-call:UTG")).not.toContain("bilo koje");
  });
});
