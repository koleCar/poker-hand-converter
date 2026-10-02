/**
 * Reading a graded decision's options: which one is best, how the reference
 * mixes, what a bad move should have been. Shared by the explanation
 * templates (`ns/analysis.*.ts`), the Learn links and the Analysis sheet, so
 * "the best alternative" under a chip and the sentence that names it are the
 * same option by construction.
 */

import type { DecisionAnalysis, OptionAnalysis } from "./types";
import { PERFECT_FREQ_BAND } from "./grading";

/** An option is part of the reference's mix from this frequency up (the grading band). */
export const MIX_MIN_FREQ = PERFECT_FREQ_BAND;

/** Index of the highest-EV option: what EV loss is measured against. Null with no options. */
export function bestOption(decision: Pick<DecisionAnalysis, "options">): number | null {
  let best: number | null = null;
  decision.options.forEach((option, index) => {
    if (best === null || option.ev > decision.options[best].ev) best = index;
  });
  return best;
}

/** Index of the reference's most frequent option. */
export function mostFrequent(decision: Pick<DecisionAnalysis, "options">): number | null {
  let top: number | null = null;
  decision.options.forEach((option, index) => {
    if (top === null || option.freq > decision.options[top].freq) top = index;
  });
  return top;
}

/** The reference's mix: options played at least `MIX_MIN_FREQ`, most frequent first. */
export function referenceMix(decision: Pick<DecisionAnalysis, "options">): Array<{ option: OptionAnalysis; index: number }> {
  return decision.options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.freq >= MIX_MIN_FREQ)
    .sort((a, b) => b.option.freq - a.option.freq || a.index - b.index);
}

/**
 * The alternative a bad move shows underneath it (§6.1: "Fold → Call 1.8 ✓"):
 * the highest-EV option, when the hero did not take it and the move was graded
 * worse than Good. Null otherwise.
 */
export function betterAlternative(decision: DecisionAnalysis): OptionAnalysis | null {
  if (decision.chosen === null || !decision.grade) return null;
  if (decision.grade === "perfect" || decision.grade === "good") return null;
  const best = bestOption(decision);
  return best === null || best === decision.chosen ? null : decision.options[best];
}

const RANK_ORDER = "23456789TJQKA";

/**
 * Hands whose value is mostly implied odds and which `charts/2` still
 * under-rates (`docs/CHARTS.md` §9): the small pairs 22–55, the suited
 * connectors 54s–87s, and A5s. With the flop checked in the realisation
 * measurement, a set or a straight is paid less than it is at the table, so
 * a bad grade for *playing* one carries an extra sentence and link saying so.
 */
export function impliedOddsClass(handClass: string | null): boolean {
  if (!handClass || handClass.length < 2) return false;
  const high = RANK_ORDER.indexOf(handClass[0]);
  const low = RANK_ORDER.indexOf(handClass[1]);
  if (high < 0 || low < 0) return false;
  if (handClass.length === 2) return high === low && high <= RANK_ORDER.indexOf("5");
  if (handClass[2] !== "s") return false;
  if (handClass === "A5s") return true;
  return high - low === 1 && high >= RANK_ORDER.indexOf("5") && high <= RANK_ORDER.indexOf("8");
}

/**
 * The model caveat applies to this graded decision: the chart set carries the
 * `model` note, the move was to play the hand (call or raise) and was graded
 * worse than Good, and it is one `charts/2` gets wrong — an implied-odds hand
 * (`impliedOddsClass`), or the button flatting a cutoff open, which the
 * charts almost never do (line `ffr`: UTG and HJ folded, CO raised).
 */
export function modelCaveat(decision: DecisionAnalysis): boolean {
  const flatVsCutoff =
    // The cutoff open folded to the button: 6-max "ffr", 9-max "fffffr" (A2c).
    decision.action === "call" && decision.facts.position === "BTN" && ["ffr", "fffffr"].includes(decision.facts.chart?.line ?? "");
  return (
    decision.approximations.includes("model") &&
    (decision.action === "call" || decision.action === "raise") &&
    (decision.grade === "inaccurate" || decision.grade === "mistake" || decision.grade === "blunder") &&
    (impliedOddsClass(decision.facts.handClass) || flatVsCutoff)
  );
}

/** The hero's hand never reaches this node in the reference: options are its best response. */
export function outOfRange(decision: Pick<DecisionAnalysis, "approximations">): boolean {
  return decision.approximations.includes("out-of-range");
}
