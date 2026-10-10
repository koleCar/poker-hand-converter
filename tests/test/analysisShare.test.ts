/**
 * Sharing a hand's analysis (A7.1): the pure halves.
 *
 * - `analysisFitsHand` is the guard every public page runs before drawing a
 *   stored analysis beside a *copy* of the hand. On the hand it was computed
 *   from it must always pass — and on the share page's copy, which is the
 *   hand re-read from its standard text, it must pass too, or shared links
 *   would show nothing.
 * - `pollReference` reads each poll answer against the reference at the
 *   polled decision, with the drill's grading rule.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { analyzeHand, grade, type DecisionAnalysis } from "../../frontend/src/lib/analysis/index.js";
import { analysisFitsHand, withoutOwnerFacts } from "../../frontend/src/lib/analysis/share.js";
import { optionsForChoice, pollReference } from "../../frontend/src/lib/forum/pollReference.js";
import { gradeDrill } from "../../frontend/src/lib/training/grade.js";
import { parseHand } from "../../frontend/src/lib/phf/index.js";
import { toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { ggCorpusFiles, readTree } from "./support/psggCorpus.js";

const ROOT = join(import.meta.dirname, "../..");

const FILES = [...ggCorpusFiles(), ...readTree(join(ROOT, "fixtures/samples"), "fixtures/samples")];
const HANDS: PhfHand[] = (
  await Promise.all(
    FILES.map(async (file) => {
      try {
        return (await convertAny(file.text, { sourceFilename: file.name })).hands;
      } catch {
        return [];
      }
    }),
  )
).flat();

describe("analysisFitsHand", () => {
  // Cheap analyses (no equities, no charts): the decisions and their action
  // indices are what the guard checks, and those do not depend on either.
  const analysed = HANDS.map((hand) => ({ hand, analysis: analyzeHand(structuredClone(hand), { equity: false, charts: null }) }))
    .filter(({ analysis }) => analysis.decisions.length > 0);

  it("runs over a real corpus", () => {
    expect(analysed.length).toBeGreaterThan(500);
  });

  it("always fits the hand it was computed from", () => {
    const misfits = analysed.filter(({ hand, analysis }) => !analysisFitsHand(analysis, hand));
    expect(misfits.map(({ hand }) => hand.meta.handKey)).toEqual([]);
  });

  it("fits the share page's copy: the hand re-read from its standard text", () => {
    const misfits = analysed.filter(({ hand, analysis }) => {
      const copy = parseHand(toStandardText(hand));
      return !copy || !analysisFitsHand(analysis, copy);
    });
    expect(misfits.map(({ hand }) => hand.meta.handKey)).toEqual([]);
  });

  it("refuses a copy whose actions moved", () => {
    const { hand, analysis } = analysed[0];
    const shifted = { ...hand, actions: hand.actions.map((action) => ({ ...action, index: action.index + 1 })) };
    expect(analysisFitsHand(analysis, shifted)).toBe(false);
    const noHero = { ...hand, players: hand.players.map((player) => ({ ...player, isHero: false })) };
    expect(analysisFitsHand(analysis, noHero)).toBe(false);
  });
});

/** A flop decision: check 80%, bet a third 10%, bet three quarters 10% — the hero bet three quarters. */
function flopBet(overrides: Partial<DecisionAnalysis> = {}): DecisionAnalysis {
  const options = [
    { action: "check" as const, freq: 0.8, ev: 3.1 },
    { action: "bet" as const, size: 4, sizePot: 0.33, freq: 0.1, ev: 2.5 },
    { action: "bet" as const, size: 9, sizePot: 0.75, freq: 0.1, ev: 2.4 },
    { action: "bet" as const, size: 40, allIn: true, freq: 0, ev: -1 },
  ];
  const result = grade({ options, chosen: 2, pot: 12, capAtMistake: true });
  return {
    order: 2,
    actionIndex: 4,
    street: "flop",
    action: "bet",
    status: "analysed",
    reason: null,
    node: "n",
    options,
    chosen: 2,
    evLoss: result.evLoss,
    evLossPot: result.evLossPot,
    freqDiff: result.freqDiff,
    grade: result.grade,
    score: result.score,
    source: "solver",
    approximations: ["narrowing-heuristic"],
    facts: { potBb: 12 } as DecisionAnalysis["facts"],
    flags: [],
    worstFlag: null,
    ...overrides,
  };
}

describe("pollReference", () => {
  it("maps answers onto the reference's options", () => {
    const decision = flopBet();
    expect(optionsForChoice(decision, "check")).toEqual([0]);
    expect(optionsForChoice(decision, "bet")).toEqual([1, 2]);
    expect(optionsForChoice(decision, "allin")).toEqual([3]);
    expect(optionsForChoice(decision, "fold")).toEqual([]);
  });

  it("adds the sizes' frequencies and grades a bet by its best size, with the drill's rule", () => {
    const decision = flopBet();
    const ref = pollReference(decision, ["check", "bet", "allin", "fold"]);
    expect(ref.check).toMatchObject({ freq: 0.8, ev: 3.1, option: 0, grade: "perfect", evLoss: 0 });
    expect(ref.bet?.freq).toBeCloseTo(0.2, 10);
    expect(ref.bet).toMatchObject({ ev: 2.5, option: 1 });
    expect(ref.bet?.grade).toBe(gradeDrill({ ...decision, chosen: 2, grade: decision.grade!, evLoss: decision.evLoss!, evLossPot: decision.evLossPot!, freqDiff: decision.freqDiff!, score: decision.score!, potBb: 12 }, 1).grade);
    expect(ref.allin?.option).toBe(3);
    // A solver grade is capped at Mistake for any answer, as in drills.
    expect(ref.allin?.grade).toBe("mistake");
    expect(ref.fold).toBeNull();
  });

  it("gives the hero's own option the grade the hero was given", () => {
    // The hero's three-quarter bet ties for best among the bets: it stands for "bet".
    const decision = flopBet({
      options: [
        { action: "check", freq: 0.8, ev: 3.1 },
        { action: "bet", size: 4, sizePot: 0.33, freq: 0.1, ev: 2.4 },
        { action: "bet", size: 9, sizePot: 0.75, freq: 0.1, ev: 2.4 },
      ],
      grade: "inaccurate",
    });
    expect(pollReference(decision, ["bet"]).bet).toMatchObject({ option: 2, grade: "inaccurate" });
  });

  it("answers nothing for an ungraded decision", () => {
    const decision = flopBet({ grade: null, chosen: null, evLoss: null, evLossPot: null, freqDiff: null, score: null });
    expect(pollReference(decision, ["check", "bet"])).toEqual({ check: null, bet: null });
  });
});

describe("withoutOwnerFacts", () => {
  const villain = {
    position: "BB",
    range: "bb-defence:BB",
    hands: 312,
    passive: 0.24,
    shrunk: 0.23,
    stats: { vpipOpp: 312, vpip: 110, pfr: 35 },
  };
  // The turn's and river's own `villain` is the range's shape, read from the hand: it stays.
  const river = { role: "bluff-catcher", villain: { strong: 0.3, medium: 0.3, weak: 0.4, shape: "polar" } };

  it("drops an opponent's statistics from a stored row, and nothing else", () => {
    const row = {
      analysisVersion: "analysis/20",
      grade: "good",
      decisions: [
        { ord: 0, facts: { potBb: 12, villain, river } },
        { ord: 1, facts: { potBb: 20 } },
      ],
    };
    const out = withoutOwnerFacts(row);
    expect(out.decisions.map((decision) => "villain" in decision.facts)).toEqual([false, false]);
    expect(out.decisions[0]).toEqual({ ord: 0, facts: { potBb: 12, river } });
    expect(out.decisions[1]).toBe(row.decisions[1]);
    expect(out.grade).toBe("good");
    expect(row.decisions[0].facts.villain).toBe(villain);
  });

  it("drops them from a mapped analysis on its way to the read-only sheet", () => {
    const decision = flopBet({ facts: { potBb: 12, villain, river } as unknown as DecisionAnalysis["facts"] });
    const mapped = withoutOwnerFacts({ decisions: [decision] });
    expect(mapped.decisions[0].facts).toEqual({ potBb: 12, river });
    expect(mapped.decisions[0].grade).toBe(decision.grade);
  });

  it("hands back the same object when there is nothing to drop", () => {
    const row = { decisions: [{ ord: 0, facts: { potBb: 12, river } }, { ord: 1, facts: null }] };
    expect(withoutOwnerFacts(row)).toBe(row);
    const bare = { grade: "good" };
    expect(withoutOwnerFacts(bare)).toBe(bare);
  });
});
