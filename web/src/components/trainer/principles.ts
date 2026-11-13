/**
 * Which rule of thumb explains a spot: the idea behind the reference's play
 * in this kind of situation, shown above the analysis' own sentences for the
 * hand. Keyed by the preflop family (and the seat where it changes the idea:
 * the small and the big blind facing an open), or postflop by the street,
 * what the hero faces and the preflop role. The words are the dictionary's
 * (`trainer.principles`). Pure.
 */

import type { DecisionAnalysis } from "../../lib/analysis/types";
import type { TrainerSpot } from "../../lib/training";

export type PrincipleKey =
  | "rfi"
  | "vs-open"
  | "vs-open-sb"
  | "vs-open-bb"
  | "vs-3bet"
  | "squeeze"
  | "bvb"
  | "vs-limp"
  | "vs-4bet"
  | "flop-cbet"
  | "flop-check-to-raiser"
  | "flop-vs-bet"
  | "flop-vs-raise"
  | "turn-barrel"
  | "turn-first"
  | "turn-vs-bet"
  | "river-first"
  | "river-vs-bet"
  | "river-vs-raise";

/** A preflop decision's family, read off the analysis' scenario (a whole hand's decisions have no dealt family). */
const SCENARIO_FAMILY: Partial<Record<string, PrincipleKey>> = {
  unopened: "rfi",
  "vs-open": "vs-open",
  squeeze: "squeeze",
  "vs-3bet": "vs-3bet",
  "vs-3bet-cold": "vs-3bet",
  "vs-4bet": "vs-4bet",
  "vs-limp": "vs-limp",
  "bb-option": "bvb",
};

/** The rule of thumb for a decision: a dealt spot's family, else what the analysis read the spot as. */
export function principleOf(spot: TrainerSpot | null, decision: DecisionAnalysis): PrincipleKey | null {
  if (decision.street === "preflop") {
    const family = spot?.kind === "preflop" ? spot.family : (SCENARIO_FAMILY[decision.facts.preflopScenario ?? ""] ?? null);
    const hero = spot?.kind === "preflop" ? spot.hero : decision.facts.position;
    if (family === "vs-open" && hero === "SB") return "vs-open-sb";
    if (family === "vs-open" && hero === "BB") return "vs-open-bb";
    return family;
  }
  const facing = decision.facts.facing;
  const raiser = decision.facts.role === "pfr";
  const street = decision.street;
  if (street === "flop") {
    if (facing === "vs-raise") return "flop-vs-raise";
    if (facing === "vs-bet") return "flop-vs-bet";
    return raiser ? "flop-cbet" : "flop-check-to-raiser";
  }
  if (street === "turn") {
    if (facing === "vs-bet" || facing === "vs-raise") return "turn-vs-bet";
    return raiser ? "turn-barrel" : "turn-first";
  }
  if (street === "river") {
    if (facing === "vs-raise") return "river-vs-raise";
    if (facing === "vs-bet") return "river-vs-bet";
    return "river-first";
  }
  return null;
}
