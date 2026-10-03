/**
 * From an analysed decision to the concepts that explain it.
 *
 * The Analysis sheet's *why* is built from facts and flags (`explain()` in
 * `ns/analysis.*.ts`); every sentence it can say leans on a concept, and this
 * file names which. The rules mirror `explain()` sentence by sentence, so a
 * link appears exactly when the sentence it explains does: the pot-odds
 * sentence when there was a price, the SPR sentence when SPR was 3 or less
 * before the river, the grading page under a chart or solver grade, MDF never
 * preflop, a river grade's role and range shape (bluff-catching, sizing and
 * polarisation, thin value, blockers), a turn grade's (equity realisation for
 * draws, protection and playing out of position, dynamic boards for the
 * river cards that change it, bluff-catching, sizing against a polar range),
 * and so on. Flags come first — they are the reason the reader opened the
 * decision.
 */

import { modelCaveat } from "../analysis/reference";
import type { DecisionAnalysis, FlagCode, SpotFacts } from "../analysis/types";
import type { ConceptId } from "./concepts";

/** The concepts behind each heuristic flag, the one that explains it best first. */
export const FLAG_CONCEPTS: Readonly<Record<FlagCode, readonly ConceptId[]>> = {
  "fold-nuts": ["ev-and-grading"],
  "free-fold": ["ev-and-grading"],
  "call-beats-nothing": ["bluff-catching", "ranges"],
  "call-without-odds": ["pot-odds"],
  "fold-with-odds": ["pot-odds", "bluff-catching"],
  "check-back-nuts": ["thin-value", "bet-sizing"],
  "thin-stack-behind": ["spr"],
  "committed-fold": ["spr", "pot-odds"],
};

/** The SPR at or under which `explain()` says the next bet commits the stacks. */
const SHORT_SPR = 3;

/** The preflop spot as a concept: who opened, who 3-bet, who squeezed. */
function preflopConcept(facts: SpotFacts, action: DecisionAnalysis["action"]): ConceptId | null {
  switch (facts.preflopScenario) {
    case "unopened":
      if (action === "raise" || action === "bet") {
        return facts.position === "CO" || facts.position === "BTN" || facts.position === "SB" ? "steal" : "rfi";
      }
      return "rfi";
    case "vs-open":
      if (action === "raise") return "three-bet";
      return facts.position === "BB" || facts.position === "SB" ? "blind-defence" : "three-bet";
    case "squeeze":
      return "squeeze";
    case "vs-3bet":
    case "vs-3bet-cold":
    case "vs-4bet":
      return "three-bet";
    case "bb-option":
    case "vs-limp":
      return null;
    default:
      return null;
  }
}

/** The postflop line as a concept: a c-bet, a donk bet, a check-raise. */
function lineConcept(facts: SpotFacts, action: DecisionAnalysis["action"]): ConceptId | null {
  if (facts.street === "preflop" || facts.players !== 2) return null;
  if (action === "bet" && facts.facing === "first") {
    if (facts.role === "pfr" && facts.street === "flop") return "continuation-bet";
    if (facts.role === "caller" && facts.inPosition === false) return "donk-bet";
  }
  if (action === "raise" && facts.facing === "vs-bet" && facts.inPosition === false) return "check-raise";
  if (action === "call" && facts.street === "river") return "bluff-catching";
  return null;
}

/**
 * The concepts one decision's explanation uses, most relevant first, without
 * repeats, at most `limit` of them — a sheet with nine links is a sheet with
 * none.
 */
export function conceptsForDecision(decision: DecisionAnalysis, limit = 4): ConceptId[] {
  const facts = decision.facts;
  const out: ConceptId[] = [];
  const add = (id: ConceptId | null) => {
    if (id && !out.includes(id)) out.push(id);
  };
  if (decision.status === "not-analysed") return out;

  for (const flag of decision.flags) {
    for (const id of FLAG_CONCEPTS[flag.code] ?? []) add(id);
  }
  add(facts.street === "preflop" ? preflopConcept(facts, decision.action) : lineConcept(facts, decision.action));
  // The chart sentences: the grade itself, a hand outside the range, and the
  // realisation model's known weakness under a bad grade.
  if (decision.source === "chart" && decision.grade) {
    add("ev-and-grading");
    if (decision.approximations.includes("out-of-range")) add("ranges");
    if (decision.approximations.includes("limp-tremble")) add("ranges");
    if (modelCaveat(decision)) add("equity-realisation");
  }
  // The river solver's sentences (A4): the grade, the hand's role against the
  // range it faces and that range's shape, blockers, and the narrowed ranges.
  if (decision.source === "solver" && decision.grade) {
    add("ev-and-grading");
    const river = facts.river;
    if (river) {
      if (river.role === "bluff-catcher") add("bluff-catching");
      if (river.role === "bluff-catcher" && river.villain.shape === "polar") add("bet-sizing");
      if (river.role === "thin-value" || (river.role === "value" && facts.toCallBb === 0 && river.villain.shape === "merged")) {
        add("thin-value");
      }
      if (Math.abs(river.blocks.strong - river.blocks.weak) >= 0.05) add("blockers");
    }
    // The turn solver's sentences (A5a): the hand's role (a draw or a hand
    // that wants protection realise or deny equity; a bluff-catcher), playing
    // it out of position, the river cards that change the board, a polar range.
    const turn = facts.turn;
    if (turn) {
      if (turn.role === "bluff-catcher") add("bluff-catching");
      if (turn.role === "draw" || turn.role === "vulnerable") add("equity-realisation");
      if (facts.inPosition === false && (turn.role === "draw" || turn.role === "medium" || turn.role === "bluff-catcher")) {
        add("equity-realisation");
      }
      if (facts.texture && facts.texture.volatility !== null && facts.texture.volatility >= 0.25) add("dynamic-boards");
      if (turn.villain.shape === "polar") add("bet-sizing");
    }
    add("ranges");
  }
  if (facts.potOdds !== null) add("pot-odds");
  // MDF is postflop only (ANALYSIS-PLAN §4), exactly as `explain()` quotes it.
  if (facts.mdf !== null && facts.street !== "preflop") add("mdf-alpha");
  if (facts.betPot !== null && (decision.action === "bet" || decision.action === "raise")) add("bet-sizing");
  if (facts.spr !== null && facts.spr <= SHORT_SPR && facts.street !== "river") add("spr");
  if (facts.blockers.length > 0) add("blockers");
  if (facts.texture) add(facts.texture.dynamism === "dynamic" || facts.texture.dynamism === "static" ? "dynamic-boards" : "board-texture");
  if (facts.equity) add("ranges");
  return out.slice(0, limit);
}
