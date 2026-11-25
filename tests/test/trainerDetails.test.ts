/**
 * The Trainer's Details (#424, `web/src/lib/training/details.ts`): the size
 * against the other options, a river bluff's good and bad blockers, and the
 * analysis' sentences without what the Trainer already shows.
 */

import { describe, expect, it } from "vitest";
import type { DecisionAnalysis, OptionAnalysis } from "../../web/src/lib/analysis/types.js";
import { bluffBlockers, sizingNotes } from "../../web/src/lib/training/details.js";
import { analysisEn } from "../../web/src/lib/i18n/ns/analysis.en.js";
import { trainerEn } from "../../web/src/lib/i18n/ns/trainer.en.js";
import { trainerHr } from "../../web/src/lib/i18n/ns/trainer.hr.js";

function option(action: OptionAnalysis["action"], freq: number, ev: number, sizePot: number | null = null): OptionAnalysis {
  return { action, freq, ev, sizeBb: sizePot === null ? undefined : 17.5 * sizePot, sizePot: sizePot ?? undefined, allIn: false } as OptionAnalysis;
}

/**
 * The issue's spot: the river checked to the preflop raiser with K♠4♠, no
 * pair, on a broadway, two-tone board the spades missed; the solver mixes
 * check 72%, bet 33% 19% and bet 75% 9%.
 */
function bluff(chosen: number, evs = [0, 0.04, 0.01]): DecisionAnalysis {
  return {
    street: "river",
    source: "solver",
    grade: "good",
    status: "analysed",
    chosen,
    action: chosen === 0 ? "check" : "bet",
    reason: null,
    approximations: [],
    flags: [],
    evLoss: 0.03,
    evLossPot: 0.002,
    options: [option("check", 0.72, evs[0]), option("bet", 0.19, evs[1], 0.33), option("bet", 0.09, evs[2], 0.75)],
    facts: {
      street: "river",
      scenario: "srp",
      role: "pfr",
      facing: "first",
      inPosition: false,
      players: 2,
      preflopScenario: null,
      position: "CO",
      toCallBb: 0,
      potBb: 17.5,
      potOdds: null,
      mdf: null,
      spr: 5.2,
      betPot: chosen === 0 ? null : 0.75,
      allIn: false,
      holeCards: ["Ks", "4s"],
      handClass: "K4s",
      board: ["Qd", "Js", "8h", "2s", "Tc"],
      texture: null,
      made: { class: "nothing" },
      draws: [],
      blockers: ["nut-straight"],
      equity: null,
      river: {
        heroBeats: 0.04,
        role: "air",
        villain: { strong: 0.3, medium: 0.3, weak: 0.4, shape: "mixed" },
        blocks: { strong: 0.05, weak: 0.06 },
        capped: null,
        converged: true,
        exploitabilityPct: 0.4,
        iterations: 400,
        narrowing: "heuristic",
      },
    },
  } as unknown as DecisionAnalysis;
}

const label = (decision: DecisionAnalysis) => (index: number) => {
  const o = decision.options[index];
  return trainerEn.words.option(o.action, o.sizeBb, o.allIn, o.sizePot);
};

describe("the Trainer's Details", () => {
  it("names the better size when the hero bet the worse one", () => {
    const decision = bluff(2);
    const notes = sizingNotes(decision);
    expect(notes[0]).toMatchObject({ kind: "size-better", better: 1, chosen: 2, raise: false, sizes: 2 });
    expect(trainerEn.details.sizing(notes[0], label(decision))).toMatch(/^Bet .* \(33%\) is the better size: it earns 0\.03 bb more than your bet .* \(75%\)\.$/);
  });

  it("says a check beats every bet when it does", () => {
    const decision = bluff(1, [0.1, 0.04, 0.01]);
    const notes = sizingNotes(decision);
    expect(notes.map((n) => n.kind)).toEqual(["size-best", "passive-better"]);
    expect(trainerEn.details.sizing(notes[1], label(decision))).toMatch(/^Check beats every bet here/);
  });

  it("says a bet beats the check, and names the best size", () => {
    const decision = bluff(0);
    const notes = sizingNotes(decision);
    expect(notes).toEqual([expect.objectContaining({ kind: "aggressive-better", best: 1, chosen: 0 })]);
    expect(trainerEn.details.sizing(notes[0], label(decision))).toMatch(/^Betting is better here: bet .* \(33%\), the best size, earns 0\.04 bb more than your check\.$/);
  });

  it("explains a river bluff's blockers: the straight good, the missed spades bad", () => {
    const b = bluffBlockers(bluff(2));
    expect(b).not.toBeNull();
    expect(b!.good).toEqual([
      { kind: "straight", ranks: ["A", "K"] },
      { kind: "top-pair", ranks: ["Q"] },
    ]);
    expect(b!.bad).toContainEqual({ kind: "missed-flush", suit: "s" });
    expect(b!.mine).toEqual({ good: ["Ks"], bad: ["4s"] });
    const words = trainerEn.details.blockers(b!);
    expect(words.at(-1)).toBe("Your K♠ is a good blocker, your 4♠ is a bad blocker.");
    expect(trainerHr.details.blockers(b!).at(-1)).toBe("Tvoj K♠ je dobar bloker, a 4♠ je loš bloker.");
  });

  it("lists the missed open-enders as bad blockers", () => {
    const decision = bluff(2);
    decision.facts.board = ["Kd", "Qs", "7h", "2c", "4d"];
    decision.facts.holeCards = ["Tc", "3h"];
    const b = bluffBlockers(decision);
    expect(b!.bad).toContainEqual({ kind: "missed-straight", ranks: ["J", "T"] });
    expect(b!.mine).toEqual({ good: [], bad: ["Tc"] });
  });

  it("has no bluff blockers for a hand that is not a bluff, or facing a bet", () => {
    const value = bluff(2);
    value.facts.river!.role = "value";
    expect(bluffBlockers(value)).toBeNull();
    const facing = bluff(2);
    facing.facts.toCallBb = 5;
    expect(bluffBlockers(facing)).toBeNull();
  });

  it("drops the spot, the mix, the size played, the solve's caveat and the blockers from the sentences", () => {
    const decision = bluff(2);
    const full = analysisEn.explain(decision).join(" ");
    const details = analysisEn.details(decision).join(" ");
    expect(full).toContain("River:");
    expect(full).toContain("heuristic model");
    expect(full).toContain("You bet 75% of the pot.");
    expect(full).toContain("Your cards block");
    for (const gone of ["River:", "heuristic model", "You bet 75%", "Your cards block", "Good:"]) expect(details).not.toContain(gone);
    expect(details).toContain("it wins only by making better hands fold");
  });
});
