/**
 * The concept library (`frontend/src/lib/learn`), pinned.
 *
 * Three kinds of check:
 *
 * 1. **The formulas** — each calculator function against numbers worked out
 *    by hand, plus the identities that tie them together (MDF + alpha = 1,
 *    a bluff-catcher's EV is zero exactly at the polar bluff share, a
 *    geometric bet really does get the stacks in).
 * 2. **The worked examples** — every number a concept page quotes in its
 *    example is recomputed here from the same functions, so the prose and the
 *    calculators cannot drift apart. The ones that come from a seeded sample
 *    are checked with the tolerance the text rounds to.
 * 3. **The catalogue** — every concept has a page in both languages with the
 *    same structure, every related link and preset points somewhere real, every
 *    heuristic flag links to a concept.
 */

import { describe, expect, it } from "vitest";

import { boardTexture, toIndices } from "../../frontend/src/lib/analysis/texture.js";
import { grade } from "../../frontend/src/lib/analysis/grading.js";
import { FLAG_CODES, type DecisionAnalysis, type SpotFacts } from "../../frontend/src/lib/analysis/types.js";
import { equityVsRange, parseRange, rangeShare } from "../../frontend/src/lib/equity/range.js";
import { CONCEPT_IDS, CONCEPTS, conceptsIn, CONCEPT_GROUPS, isConceptId } from "../../frontend/src/lib/learn/concepts.js";
import { CONCEPT_TEXT } from "../../frontend/src/lib/learn/content/index.js";
import { FLAG_CONCEPTS, conceptsForDecision } from "../../frontend/src/lib/learn/links.js";
import {
  alpha,
  bluffCatcherEv,
  bluffEv,
  bluffShare,
  callEv,
  countCombos,
  geometricBet,
  mdf,
  nutShare,
  potOddsRatio,
  potSizedBets,
  rangeVsRange,
  realisedEquity,
  requiredEquity,
  spr,
  valueBetGain,
  valuePerBluff,
} from "../../frontend/src/lib/learn/math.js";
import {
  BOARD_PRESETS,
  COMBO_PRESETS,
  MATCHUP_PRESETS,
  RANGE_TEXT,
  presetRange,
  type RangeId,
} from "../../frontend/src/lib/learn/presets.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";

const close = (actual: number, expected: number, digits = 3) => expect(actual).toBeCloseTo(expected, digits);
const texture = (codes: string) => boardTexture(toIndices(codes.split(" ")))!;

/* ------------------------------------------------------------- formulas - */

describe("pot odds", () => {
  it("prices a call against the pot including the bet", () => {
    // 12 in the pot, 6 bet: call 6 to win 18 -> 6 / 24.
    close(requiredEquity(18, 6), 0.25);
    expect(potOddsRatio(18, 6)).toBe(3);
    // Third pot, half pot, pot, double pot.
    close(requiredEquity(1 + 1 / 3, 1 / 3), 0.2);
    close(requiredEquity(1.5, 0.5), 0.25);
    close(requiredEquity(2, 1), 1 / 3);
    close(requiredEquity(3, 2), 0.4);
  });
  it("makes the EV of a call zero exactly at the required equity", () => {
    close(callEv(18, 6, requiredEquity(18, 6)), 0, 9);
    close(callEv(18, 6, 9 / 46), -1.304, 3);
  });
  it("has sane limits", () => {
    expect(requiredEquity(0, 0)).toBe(0);
    expect(potOddsRatio(10, 0)).toBe(Infinity);
  });
});

describe("alpha, MDF and polar bets", () => {
  it("are one number seen from two sides", () => {
    for (const size of [0.25, 0.33, 0.5, 0.75, 1, 1.5, 2]) {
      close(alpha(1, size) + mdf(1, size), 1, 12);
    }
    close(alpha(10, 7.5), 7.5 / 17.5);
    close(mdf(10, 7.5), 10 / 17.5);
    close(alpha(1, 1), 0.5);
    close(mdf(1, 0.5), 2 / 3);
  });
  it("puts bet / (pot + 2 bet) bluffs in a polarised bet, equal to the caller's price", () => {
    close(bluffShare(10, 5), 0.25);
    close(bluffShare(10, 10), 1 / 3);
    close(bluffShare(10, 20), 0.4);
    expect(valuePerBluff(10, 5)).toBe(3);
    expect(valuePerBluff(10, 10)).toBe(2);
    expect(valuePerBluff(10, 20)).toBe(1.5);
    // The caller faces pot + bet and pays bet: the same number.
    for (const [pot, bet] of [[10, 5], [10, 7.5], [20, 15], [6, 13]]) {
      close(bluffShare(pot, bet), requiredEquity(pot + bet, bet), 12);
    }
  });
  it("makes a bluff-catcher indifferent exactly at the polar bluff share", () => {
    for (const [pot, bet] of [[10, 7.5], [20, 15], [10, 25]]) {
      close(bluffCatcherEv(pot, bet, bluffShare(pot, bet)), 0, 9);
    }
    close(bluffCatcherEv(10, 7.5, 0.15), -3.75);
    close(bluffCatcherEv(10, 7.5, 0.45), 3.75);
    close(bluffCatcherEv(20, 15, 0.25), -2.5);
    close(bluffCatcherEv(20, 15, 0.4), 5);
  });
  it("breaks a bluff even at alpha", () => {
    close(bluffEv(1.5, 2.5, alpha(1.5, 2.5)), 0, 9);
    close(alpha(1.5, 2.5), 0.625);
    close(alpha(4, 8), 2 / 3);
    close(alpha(6.5, 12), 12 / 18.5);
    close(alpha(8, 7), 7 / 15);
  });
});

describe("value, realisation, SPR", () => {
  it("gains on a thin value bet exactly when more than half the calls are worse", () => {
    close(valueBetGain(7, 0.4, 0.6), 0.56);
    close(valueBetGain(7, 0.4, 0.45), -0.28);
    expect(valueBetGain(7, 0.4, 0.5)).toBe(0);
  });
  it("scales equity by realisation and caps it", () => {
    close(realisedEquity(0.4, 0.8), 0.32);
    expect(realisedEquity(0.9, 1.3)).toBe(1);
  });
  it("finds the bet that gets the stacks in", () => {
    // Walk the streets: each bet f * pot is called; the stack must hit zero.
    for (const [pot, stack, streets] of [[21.5, 90, 3], [21.5, 90, 2], [5.5, 97.5, 3], [10, 0.1, 1]]) {
      const f = geometricBet(pot, stack, streets);
      let p = pot;
      let s = stack;
      for (let street = 0; street < streets; street += 1) {
        const bet = f * p;
        s -= bet;
        p += 2 * bet;
      }
      close(s, 0, 9);
    }
    close(geometricBet(10, 130, 3), 1); // SPR 13: three pot-sized bets
    close(potSizedBets(10, 130), 3);
    close(spr(90, 21.5), 4.186);
  });
});

describe("combos", () => {
  it("removes the combos your cards block", () => {
    const rows = countCombos(["AA", "KK", "QQ", "AKs", "AKo"], ["As", "5s"]);
    expect(rows.map((row) => [row.name, row.total, row.left])).toEqual([
      ["AA", 6, 3],
      ["KK", 6, 6],
      ["QQ", 6, 6],
      ["AKs", 4, 3],
      ["AKo", 12, 9],
    ]);
    expect(rows.reduce((sum, row) => sum + row.left, 0)).toBe(27);
    expect(countCombos(["KK"], ["Kd", "Kh"])[0].left).toBe(1);
  });
});

/* ------------------------------------------------------ worked examples - */

describe("the examples' numbers", () => {
  it("pot odds: the turn flush draw", () => {
    close(requiredEquity(18, 6), 0.25);
    close(9 / 46, 0.196, 3);
    close(callEv(18, 6, 9 / 46), -1.3, 1);
    // Implied odds needed: 9/46 * (24 + x) = 6.
    close(6 / (9 / 46) - 24, 6.67, 2);
  });

  it("equity realisation and blind defence: the big blind's price", () => {
    close(requiredEquity(4, 1.5), 0.273, 3);
    close(requiredEquity(3.5, 1), 0.222, 3);
    close(requiredEquity(4.5, 2), 0.308, 3);
    const btn = presetRange("open-btn");
    // The same request the widget makes preflop (`CardWidgets.tsx`), so the
    // page's text and its calculator show the same number.
    const eq = (hand: string[]) => equityVsRange({ hero: hand, range: btn, trials: 100_000 }).equity;
    close(eq(["7h", "6h"]), 0.395, 2.7);
    close(eq(["Kd", "4c"]), 0.403, 2.7);
    close(eq(["Jc", "5d"]), 0.36, 2.3);
    close(realisedEquity(0.395, 0.9), 0.3555, 3);
    close(realisedEquity(0.403, 0.65), 0.262, 3);
    close(realisedEquity(0.36, 0.65), 0.234, 3);
  });

  it("grading: the flop decision, through grade() itself", () => {
    const options = [
      { action: "fold" as const, freq: 0, ev: 0 },
      { action: "call" as const, freq: 0.52, ev: 1.2 },
      { action: "raise" as const, freq: 0.48, ev: 1.17 },
    ];
    const raise = grade({ options, chosen: 2, pot: 10 });
    expect(raise.grade).toBe("perfect");
    close(raise.score, 97, 6);
    const fold = grade({ options, chosen: 0, pot: 10 });
    expect(fold.grade).toBe("blunder");
    close(fold.evLossPot, 0.12, 9);
    expect(fold.score).toBe(0);
    const rare = grade({
      options: [options[0], { ...options[1], freq: 0.98 }, { ...options[2], freq: 0.02, ev: 1.05 }],
      chosen: 2,
      pot: 10,
    });
    expect(rare.grade).toBe("inaccurate");
    close(rare.score, 85, 6);
  });

  it("GTO vs exploitative and position", () => {
    close(bluffShare(10, 7.5), 0.3);
    close(0.9 ** 5, 0.59, 2);
    close(0.9 ** 2, 0.81, 9);
  });

  it("ranges: jacks against QQ+ and AK", () => {
    const eq = (range: string) => equityVsRange({ hero: ["Jh", "Jd"], range: parseRange(range), trials: 200_000 }).equity;
    close(eq("QQ+"), 0.184, 2);
    close(eq("AK"), 0.561, 2);
    close(eq("QQ+, AK"), 0.362, 2);
    expect(countCombos(["AA", "KK", "QQ", "AKs", "AKo"], []).reduce((s, r) => s + r.total, 0)).toBe(34);
  });

  it("board texture and dynamism: the boards the pages describe", () => {
    const k72 = texture("Kd 7c 2h");
    expect([k72.paired, k72.suits, k72.connectedness, k72.highCard, k72.dynamism]).toEqual([
      false, "rainbow", "disconnected", "broadway", "static",
    ]);
    close(k72.volatility!, 0.041, 3);
    const t876 = texture("8h 7h 6c");
    expect([t876.suits, t876.connectedness, t876.straightCombos, t876.highCard, t876.dynamism]).toEqual([
      "two-tone", "connected", 3, "middle", "dynamic",
    ]);
    close(t876.volatility!, 0.592, 3);
    expect(texture("Qc 5d 5h")).toMatchObject({ paired: true, suits: "rainbow", connectedness: "disconnected" });
    expect(texture("Js Ts 9s")).toMatchObject({ suits: "monotone", connectedness: "connected", flushPossible: true });
    const turn = texture("Kd 7c 2h 3s");
    close(turn.volatility!, 0.208, 3);
    expect(turn.dynamism).toBe("static");
    // "A two-tone K-7-2 is not static": a third diamond changes it.
    expect(texture("Kd 7d 2c").dynamism).toBe("medium");
    expect(texture("9h 8d 7c").straightCombos).toBeGreaterThanOrEqual(3);
  });

  it("range and nut advantage: the illustrative matchups", () => {
    const rvr = (a: RangeId, b: RangeId, board: string) => rangeVsRange(presetRange(a), presetRange(b), board.split(" "), 60_000).equity;
    close(rvr("open-btn", "call-bb", "Kd 7c 2h"), 0.53, 1.6);
    close(rvr("open-btn", "call-bb", "8h 7h 6c"), 0.49, 1.6);
    close(rvr("open-utg", "call-bb-vs-utg", "Kd 7c 2h"), 0.59, 1.6);
    close(rvr("open-utg", "call-bb-vs-utg", "8h 7h 6c"), 0.535, 1.6);
    close(rvr("open-btn", "call-bb", "Js Ts 9s"), 0.48, 1.6);
    const nuts = (id: RangeId, board: string) => nutShare(presetRange(id), board.split(" "));
    close(nuts("open-utg", "As 8d 3c"), 0.345, 2);
    close(nuts("call-bb-vs-utg", "As 8d 3c"), 0.191, 2);
    close(nuts("open-btn", "Js Ts 9s"), 0.178, 2);
    close(nuts("call-bb", "Js Ts 9s"), 0.241, 2);
    expect(nuts("call-bb", "Js Ts 9s")).toBeGreaterThan(nuts("open-btn", "Js Ts 9s"));
    // Same seed, same answer: the widgets must not wobble between renders.
    expect(rangeVsRange(presetRange("open-btn"), presetRange("call-bb"), ["Kd", "7c", "2h"]).equity).toBe(
      rangeVsRange(presetRange("open-btn"), presetRange("call-bb"), ["Kd", "7c", "2h"]).equity,
    );
  });

  it("preflop: RFI, 3-bets, squeezes, steals", () => {
    close(rangeShare(presetRange("open-utg")), 162 / 1326, 9);
    close(rangeShare(presetRange("open-btn")), 0.42, 2);
    close(rangeShare(presetRange("3bet")), 86 / 1326, 9);
    close(rangeShare(parseRange("TT+, AJs+, AKo, AQo, KQs")), 70 / 1326, 9);
    close(alpha(4, 8), 0.667, 3);
    close(alpha(6.5, 12), 0.649, 3);
    close(0.8 * 0.9, 0.72, 9);
    close(alpha(1.5, 3), 0.667, 3);
    close(alpha(2.1, 2.5), 0.543, 3);
    close(spr(90, 21.5), 4.2, 1);
    close(geometricBet(21.5, 90, 3), 0.55, 2);
    close(geometricBet(21.5, 90, 2), 1.03, 2);
    close(spr(97.5, 5.5), 17.7, 1);
    close(geometricBet(5.5, 97.5, 3), 1.16, 2);
    close(mdf(10, 7.5) ** 3, 0.19, 2);
    close(alpha(6, 2), 0.25, 9);
  });
});

/* ------------------------------------------------------------ catalogue - */

describe("the catalogue", () => {
  it("has a page in both languages for every concept, with the same shape", () => {
    for (const id of CONCEPT_IDS) {
      const [a, b] = [CONCEPT_TEXT.en[id], CONCEPT_TEXT.hr[id]];
      expect(a, id).toBeTruthy();
      expect(b, id).toBeTruthy();
      expect(b.definition.length, `${id} definition`).toBe(a.definition.length);
      expect(b.why.length, `${id} why`).toBe(a.why.length);
      expect(b.example.steps.length, `${id} steps`).toBe(a.example.steps.length);
      expect(b.mistakes.length, `${id} mistakes`).toBe(a.mistakes.length);
      expect(b.formulas?.length ?? 0, `${id} formulas`).toBe(a.formulas?.length ?? 0);
      expect(Boolean(b.tryIt), `${id} tryIt`).toBe(Boolean(a.tryIt));
      expect(en.learn.titles[id], id).toBeTruthy();
      expect(hr.learn.titles[id], id).toBeTruthy();
      // A widget page says what to try with it.
      if (CONCEPTS[id].widget) expect(a.tryIt, id).toBeTruthy();
    }
    expect(Object.keys(CONCEPT_TEXT.en).sort()).toEqual([...CONCEPT_IDS].sort());
    expect(Object.keys(CONCEPT_TEXT.hr).sort()).toEqual([...CONCEPT_IDS].sort());
  });

  it("keeps the summaries short enough for a meta description", () => {
    for (const locale of ["en", "hr"] as const) {
      for (const id of CONCEPT_IDS) {
        expect(CONCEPT_TEXT[locale][id].summary.length, `${locale} ${id}`).toBeLessThanOrEqual(170);
      }
    }
  });

  it("links only to concepts that exist, never to itself", () => {
    for (const id of CONCEPT_IDS) {
      const meta = CONCEPTS[id];
      expect(meta.id).toBe(id);
      expect(meta.related.length).toBeGreaterThanOrEqual(2);
      for (const related of meta.related) {
        expect(isConceptId(related), `${id} -> ${related}`).toBe(true);
        expect(related).not.toBe(id);
      }
    }
    expect(CONCEPT_GROUPS.flatMap((group) => conceptsIn(group)).sort()).toEqual([...CONCEPT_IDS].sort());
  });

  it("opens every widget on presets that exist", () => {
    const boards = new Set(BOARD_PRESETS.map((b) => b.id));
    expect(boards.size).toBe(BOARD_PRESETS.length);
    for (const id of CONCEPT_IDS) {
      const widget = CONCEPTS[id].widget;
      if (!widget) continue;
      if (widget.id === "equity") expect(Object.keys(RANGE_TEXT), id).toContain(widget.preset);
      if (widget.id === "range-vs-range") expect(MATCHUP_PRESETS.map((m) => m.id), id).toContain(widget.preset);
      if (widget.id === "combos") expect(COMBO_PRESETS.map((p) => p.id), id).toContain(widget.preset);
      if (widget.board) expect(() => toIndices([...widget.board!])).not.toThrow();
      if (widget.hand) expect(widget.hand.length).toBe(2);
    }
  });

  it("parses every illustrative range", () => {
    for (const id of Object.keys(RANGE_TEXT) as RangeId[]) {
      expect(presetRange(id).size, id).toBeGreaterThan(0);
    }
  });

  it("explains every heuristic flag with a concept, and every flag concept links back to its hands", () => {
    for (const code of FLAG_CODES) {
      expect(FLAG_CONCEPTS[code].length, code).toBeGreaterThan(0);
      for (const id of FLAG_CONCEPTS[code]) expect(isConceptId(id)).toBe(true);
    }
    for (const id of CONCEPT_IDS) {
      for (const flag of CONCEPTS[id].flags) expect(FLAG_CODES).toContain(flag);
    }
  });
});

/* ---------------------------------------------------------------- links - */

function decision(facts: Partial<SpotFacts>, rest: Partial<DecisionAnalysis> = {}): DecisionAnalysis {
  const base: SpotFacts = {
    street: "river",
    position: "BB",
    inPosition: false,
    players: 2,
    scenario: "caller-oop-vs-bet",
    preflopScenario: null,
    role: "caller",
    facing: "vs-bet",
    potBb: 15.5,
    toCallBb: 6,
    heroStackBb: 90,
    effStackBb: 90,
    spr: 10,
    potOdds: 0.279,
    mdf: 0.613,
    facingPot: 0.63,
    betPot: null,
    behindBb: null,
    allIn: false,
    holeCards: ["Kh", "Qd"],
    handClass: "KQo",
    board: ["Kd", "7c", "2h", "3s", "9d"],
    texture: null,
    made: null,
    draws: [],
    blockers: [],
    equity: null,
  };
  return {
    order: 1,
    actionIndex: 1,
    street: "river",
    action: "call",
    status: "analysed",
    reason: null,
    node: "",
    options: [],
    chosen: null,
    evLoss: null,
    evLossPot: null,
    freqDiff: null,
    grade: null,
    score: null,
    source: "heuristic",
    approximations: [],
    flags: [],
    worstFlag: null,
    ...rest,
    facts: { ...base, ...facts },
  };
}

describe("conceptsForDecision", () => {
  it("puts the flag's concept first, then the line, then the geometry", () => {
    const d = decision(
      {},
      { action: "fold", flags: [{ code: "fold-with-odds", severity: "note", params: {} }] },
    );
    expect(conceptsForDecision(d)).toEqual(["pot-odds", "bluff-catching", "mdf-alpha"]);
  });
  it("names a river call a bluff-catch", () => {
    expect(conceptsForDecision(decision({}))[0]).toBe("bluff-catching");
  });
  it("reads the preflop spot", () => {
    const pre = (preflopScenario: SpotFacts["preflopScenario"], position: SpotFacts["position"], action: DecisionAnalysis["action"]) =>
      conceptsForDecision(
        decision(
          { street: "preflop", preflopScenario, position, potOdds: null, mdf: null, spr: null, role: null, facing: null, inPosition: null },
          { street: "preflop", action },
        ),
      )[0];
    expect(pre("unopened", "BTN", "raise")).toBe("steal");
    expect(pre("unopened", "UTG", "raise")).toBe("rfi");
    expect(pre("vs-open", "BB", "call")).toBe("blind-defence");
    expect(pre("vs-open", "CO", "raise")).toBe("three-bet");
    expect(pre("squeeze", "BTN", "raise")).toBe("squeeze");
  });
  it("finds a c-bet, a donk bet and a check-raise", () => {
    const flop = { street: "flop" as const, potOdds: null, mdf: null, facing: "first" as const };
    expect(conceptsForDecision(decision({ ...flop, role: "pfr", inPosition: true }, { action: "bet", street: "flop" }))[0]).toBe(
      "continuation-bet",
    );
    expect(conceptsForDecision(decision({ ...flop, role: "caller", inPosition: false }, { action: "bet", street: "flop" }))[0]).toBe(
      "donk-bet",
    );
    expect(
      conceptsForDecision(decision({ street: "flop", facing: "vs-bet", inPosition: false }, { action: "raise", street: "flop" }))[0],
    ).toBe("check-raise");
  });
  it("says nothing about a decision that was not analysed, and never more than four", () => {
    expect(conceptsForDecision(decision({}, { status: "not-analysed", reason: "multiway" }))).toEqual([]);
    const busy = decision(
      { blockers: ["top-pair"], spr: 2, street: "turn", equity: { value: 0.4, range: "open:BTN", combos: 100, method: "exhaustive", strong: null } },
      { flags: [{ code: "committed-fold", severity: "note", params: {} }], action: "fold", street: "turn" },
    );
    expect(conceptsForDecision(busy).length).toBe(4);
  });
});
