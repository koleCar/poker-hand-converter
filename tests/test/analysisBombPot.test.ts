/**
 * analysis/28 (ANALYSIS-PLAN §10, 2026-10-19, bomb pots): a bomb pot - every
 * player antes and sees the flop, no preflop betting - is analysed from any
 * two cards instead of refused. Every range starts from all 1,326 combos and
 * is narrowed by the multiway heuristic; a call or fold facing a bet gets the
 * multiway approximate grade, a street that began heads-up the heads-up
 * solve (`multiway-history`); every decision carries `bomb-pot` (not
 * `antes`) and no grade is worse than Mistake unless the move is dominated.
 * A bomb pot on two boards stays refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeHand, gradeRank, heroSeatOf, rangeWeight, walkMultiway, type HandAnalysis } from "../../frontend/src/lib/analysis/index.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { NUM_COMBOS } from "../../frontend/src/lib/solver/index.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
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

const notWorseThanMistake = (analysis: HandAnalysis) => {
  for (const d of analysis.decisions) if (d.grade) expect(gradeRank(d.grade)).toBeLessThanOrEqual(gradeRank("mistake"));
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
    notWorseThanMistake(analysis);
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
    notWorseThanMistake(analysis);
  });

  it("still refuses a bomb pot on two boards", async () => {
    const hand = await weplay(FOLD);
    hand.game.bombPot = { ...(hand.game.bombPot as NonNullable<PhfHand["game"]["bombPot"]>), doubleBoard: true };
    const analysis = analyzeHand(hand, { charts: CHARTS });
    expect(analysis.status).toBe("not-analysed");
    expect(analysis.reason).toBe("bomb-pot");
  });
});
