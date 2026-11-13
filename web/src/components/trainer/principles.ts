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

export function principleOf(spot: TrainerSpot, decision: DecisionAnalysis): PrincipleKey | null {
  if (spot.kind === "preflop") {
    if (spot.family === "vs-open" && spot.hero === "SB") return "vs-open-sb";
    if (spot.family === "vs-open" && spot.hero === "BB") return "vs-open-bb";
    return spot.family;
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
