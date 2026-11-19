/**
 * analysis/28 (ANALYSIS-PLAN §10, 2026-10-19, bomb pots): a bomb pot - every
 * player antes and sees the flop, no preflop betting - is analysed from any
 * two cards instead of refused. Every range starts from all 1,326 combos and
 * is narrowed by the multiway heuristic; a call or fold facing a bet gets the
 * multiway approximate grade, a street that began heads-up the heads-up
 * solve (`multiway-history`); every decision carries `bomb-pot` (not
 * `antes`). Since analysis/45 a bomb pot is its own postflop role (`bomb`,
 * never "limped") and no grade there is worse than Inaccurate: no bomb pot
 * was ever solved. A bomb pot on two boards stays refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { en } from "../../web/src/lib/i18n/en.js";
import { hr } from "../../web/src/lib/i18n/hr.js";
import { analyzeHand, gradeRank, heroSeatOf, rangeWeight, walkMultiway, type HandAnalysis } from "../../web/src/lib/analysis/index.js";
import { convertAny } from "../../web/src/lib/parsers/index.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import { NUM_COMBOS } from "../../web/src/lib/solver/index.js";
import { buildContext } from "../../web/src/lib/stats/context.js";
import { fullLibrary } from "./charts/support.js";

const CHARTS = fullLibrary();

async function weplay(text: string): Promise<PhfHand> {
  const result = await convertAny(text, { sourceFilename: "bomb.txt", cashOnly: true, skipBombPots: false });
  expect(result.hands).toHaveLength(1);
  return result.hands[0];
}

/** The WePlay fixture: three anted, the hero folds 8c9d to a flop bet on KcKd7h. */
const FOLD = readFileSync(join(import.meta.dirname, "fixtures/weplay/bomb-pot-ante.txt"), "utf8");

/** Four anted; the hero calls a flop bet three ways (one folds behind), then plays a heads-up turn and river. */
const HEADS_UP_LATER = `Weplay Hand #90000201:  Hold'em No Limit ($0.25/$0.50) - 2026/01/03 15:00:00 UTC
Table 'Liverpool Bomb Pot (3BB-5BB) #1'(11403800) 8-max (Money 3) Seat #8 is the button
Seat 2: Pbomb ($60 in chips)
Seat 4: Allinfans72 ($60 in chips)
Seat 6: ryzenn ($60 in chips)
Seat 8: kole1992 ($60 in chips)
Pbomb: posts the ante $2
Allinfans72: posts the ante $2
ryzenn: posts the ante $2
kole1992: posts the ante $2
*** HOLE CARDS ***
Dealt to kole1992 [Ah Kd]
*** FLOP *** [Ac 7d 2s]
Pbomb: checks
Allinfans72: bets $4
ryzenn: folds
kole1992: calls $4
Pbomb: folds
*** TURN *** [Ac 7d 2s] [9h]
Allinfans72: checks
kole1992: bets $8
Allinfans72: calls $8
*** RIVER *** [Ac 7d 2s 9h] [3c]
Allinfans72: bets $20
kole1992: calls $20
*** SHOW DOWN ***
Allinfans72: shows [Qc Qh] (a pair of Queens)
kole1992: shows [Ah Kd] (a pair of Aces)
kole1992 collected $72 from pot
*** SUMMARY ***
Total pot $72 | Rake $0
Board [Ac 7d 2s 9h 3c]
Seat 4: Allinfans72 showed [Qc Qh] and lost
Seat 8: kole1992 (button) showed [Ah Kd] and won ($72)`;

/** Four anted; heads-up from the turn, the hero folds top pair top kicker to a river bet (what the solver calls a big loss). */
const RIVER_FOLD = `Weplay Hand #90000202:  Hold'em No Limit ($0.50/$1) - 2026/01/03 15:05:00 UTC
Table 'Nish Bomb Pot 1 (3BB)'(11506800) 8-max (Money 3) Seat #8 is the button
Seat 2: Pbomb ($100 in chips)
Seat 4: Allinfans72 ($100 in chips)
Seat 6: ryzenn ($100 in chips)
Seat 8: kole1992 ($100 in chips)
Pbomb: posts the ante $3
Allinfans72: posts the ante $3
ryzenn: posts the ante $3
kole1992: posts the ante $3
*** HOLE CARDS ***
Dealt to kole1992 [Ah Kd]
*** FLOP *** [Ac 7d 2s]
Pbomb: checks
Allinfans72: checks
ryzenn: checks
kole1992: bets $4
Pbomb: folds
Allinfans72: calls $4
ryzenn: folds
*** TURN *** [Ac 7d 2s] [9h]
Allinfans72: checks
kole1992: checks
*** RIVER *** [Ac 7d 2s 9h] [3c]
Allinfans72: bets $10
kole1992: folds
Uncalled bet ($10) returned to Allinfans72
Allinfans72 collected $20 from pot
*** SUMMARY ***
Total pot $20 | Rake $0
Board [Ac 7d 2s 9h 3c]
Seat 4: Allinfans72 collected ($20)
Seat 8: kole1992 (button) folded on the River`;

const notWorseThanInaccurate = (analysis: HandAnalysis) => {
  for (const d of analysis.decisions) {
    if (d.grade) expect(gradeRank(d.grade)).toBeLessThanOrEqual(gradeRank("inaccurate"));
    if (d.grade && d.score !== null) expect(d.score).toBeGreaterThanOrEqual(80);
  }
};

describe("bomb pots (analysis/28)", () => {
  it("starts every player who saw the flop from any two cards", async () => {
    const hand = await weplay(FOLD);
    const context = buildContext(structuredClone(hand));
    expect(context.isBombPot).toBe(true);
    const hero = heroSeatOf(context) as number;
    const walk = walkMultiway(structuredClone(hand), context, hero, CHARTS);
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.seats).toHaveLength(3);
    for (const seat of walk.seats) {
      expect(rangeWeight(walk.preflop.get(seat) as Float64Array)).toBeCloseTo(NUM_COMBOS, 6);
      expect(walk.sources.get(seat)).toBe("chart");
      expect(walk.labels.get(seat)).toMatch(/^unknown:/);
      expect(walk.approx.get(seat)).toEqual([]);
    }
  });

  it("grades a flop fold facing a bet approximately, flagged bomb-pot rather than antes", async () => {
    const analysis = analyzeHand(await weplay(FOLD), { charts: CHARTS });
    expect(analysis.status).toBe("full");
    expect(analysis.potType).toBe("bomb");
    expect(analysis.decisions).toHaveLength(1);
    const [fold] = analysis.decisions;
    expect(fold.street).toBe("flop");
    expect(fold.action).toBe("fold");
    expect(fold.source).toBe("approx");
    expect(fold.approximations).toContain("bomb-pot");
    expect(fold.approximations).toContain("flop-realisation");
    expect(fold.approximations).not.toContain("antes");
    expect(fold.approximations).not.toContain("placeholder-range");
    expect(fold.facts.multiway?.opponents.every((o) => o.range.startsWith("unknown:"))).toBe(true);
    // 8-high with no draw on a paired board, folding to a third of the pot: the fold is right.
    expect(fold.grade).toBe("perfect");
    notWorseThanInaccurate(analysis);
  });

  it("solves a river that began heads-up after a multiway bomb-pot flop", async () => {
    const analysis = analyzeHand(await weplay(HEADS_UP_LATER), { charts: CHARTS, turn: false });
    const flop = analysis.decisions.find((d) => d.street === "flop");
    const river = analysis.decisions.find((d) => d.street === "river");
    expect(flop?.source).toBe("approx");
    expect(river?.status).toBe("analysed");
    expect(river?.source).toBe("solver");
    expect(river?.approximations).toEqual(expect.arrayContaining(["bomb-pot", "multiway-history"]));
    for (const d of analysis.decisions) expect(d.approximations).toContain("bomb-pot");
    notWorseThanInaccurate(analysis);
  });

  it("reads a bomb pot as its own role, not a limped pot, and caps a costly fold at Inaccurate (analysis/45)", async () => {
    const analysis = analyzeHand(await weplay(RIVER_FOLD), { charts: CHARTS, turn: false });
    expect(analysis.potType).toBe("bomb");
    const fold = analysis.decisions.find((d) => d.street === "river" && d.action === "fold");
    expect(fold?.status).toBe("analysed");
    expect(fold?.source).toBe("solver");
    expect(fold?.facts.role).toBe("bomb");
    expect(fold?.facts.scenario).toMatch(/^bomb-/);
    // The solver's numbers call this fold a real loss; the bomb pot grade is a guide, not a verdict.
    expect(fold?.evLossPot ?? 0).toBeGreaterThan(0.02);
    expect(fold?.grade).toBe("inaccurate");
    expect(analysis.grade).toBe("inaccurate");
    notWorseThanInaccurate(analysis);
    for (const d of analysis.decisions) expect(d.facts.role).toBe("bomb");
    const textEn = en.analysis.explain(fold!).join(" ");
    expect(textEn).toContain("Bomb pot");
    expect(textEn).not.toContain("Limped pot");
    expect(textEn).not.toContain("capped at Mistake");
    expect(textEn).toContain("capped at Inaccurate");
    const textHr = hr.analysis.explain(fold!).join(" ");
    expect(textHr).toContain("Bomb pot");
    expect(textHr).not.toContain("Limpani pot");
    expect(textHr).not.toContain("ograničena na Grešku");
  });

  it("still refuses a bomb pot on two boards", async () => {
    const hand = await weplay(FOLD);
    hand.game.bombPot = { ...(hand.game.bombPot as NonNullable<PhfHand["game"]["bombPot"]>), doubleBoard: true };
    const analysis = analyzeHand(hand, { charts: CHARTS });
    expect(analysis.status).toBe("not-analysed");
    expect(analysis.reason).toBe("bomb-pot");
  });
});
