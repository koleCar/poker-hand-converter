/**
 * "What would you do?" (#51) graded against the reference (A7.1).
 *
 * A poll asks about one hero decision, its `stopIndex`. When the hand's owner
 * has shared its analysis, the stored decision at that index carries the
 * reference's options; each poll answer is read against them:
 *
 *   fold / check / call   the reference's option of that action;
 *   bet / raise           every sized option of that action that is not the
 *                         all-in: the frequencies add up (the reference's
 *                         total for "bet"), and the grade and EV are those of
 *                         its best size — a vote names an action, and its size
 *                         is optional and coarse, so it is given the benefit
 *                         of the best one;
 *   all-in                the option marked all-in.
 *
 * An answer the reference has no option for (an all-in in a tree without one)
 * says so instead of being graded. The grade of a non-chosen option is the
 * drill's rule (`gradeDrill`): the same `grade()`, the same caps, and the move
 * the hero actually made keeps its stored grade exactly.
 */

import type { DecisionAnalysis, Grade } from "../analysis/types";
import { gradeDrill } from "../training/grade";
import type { PollChoice } from "./types";

export interface PollOptionReference {
  /** The reference's total frequency for the answer, 0–1. */
  freq: number;
  /** EV of its best option, bb. */
  ev: number;
  /** Index into `decision.options` of that best option. */
  option: number;
  grade: Grade;
  /** bb lost against the reference's best option. */
  evLoss: number;
}

/** The options of `decision` a poll answer stands for. */
export function optionsForChoice(decision: Pick<DecisionAnalysis, "options">, choice: PollChoice): number[] {
  const out: number[] = [];
  decision.options.forEach((option, index) => {
    const allIn = option.allIn === true;
    const match =
      choice === "allin"
        ? allIn
        : choice === "bet" || choice === "raise"
          ? option.action === choice && !allIn
          : option.action === choice;
    if (match) out.push(index);
  });
  return out;
}

/** The reference's verdict on each answer a poll offers; null for an answer it has no option for. */
export function pollReference(
  decision: DecisionAnalysis,
  choices: readonly PollChoice[],
): Partial<Record<PollChoice, PollOptionReference | null>> {
  const out: Partial<Record<PollChoice, PollOptionReference | null>> = {};
  const graded =
    decision.grade !== null &&
    decision.chosen !== null &&
    decision.options.length > 0 &&
    decision.evLoss !== null &&
    decision.evLossPot !== null &&
    decision.freqDiff !== null &&
    decision.score !== null;
  for (const choice of choices) {
    const indices = graded ? optionsForChoice(decision, choice) : [];
    if (indices.length === 0 || decision.grade === null) {
      out[choice] = null;
      continue;
    }
    // Ties go to the earlier option, which is the hero's own when it is tied
    // for best: `gradeDrill` then returns the grade the hero was given.
    const best = indices.reduce(
      (top, index) =>
        decision.options[index].ev > decision.options[top].ev ||
        (decision.options[index].ev === decision.options[top].ev && index === decision.chosen)
          ? index
          : top,
      indices[0],
    );
    const result = gradeDrill(
      {
        options: decision.options,
        chosen: decision.chosen ?? -1,
        grade: decision.grade,
        evLoss: decision.evLoss ?? 0,
        evLossPot: decision.evLossPot ?? 0,
        freqDiff: decision.freqDiff ?? 0,
        score: decision.score ?? 0,
        potBb: decision.facts.potBb,
        source: decision.source,
        approximations: decision.approximations,
      },
      best,
    );
    out[choice] = {
      freq: indices.reduce((sum, index) => sum + decision.options[index].freq, 0),
      ev: decision.options[best].ev,
      option: best,
      grade: result.grade,
      evLoss: result.evLoss,
    };
  }
  return out;
}
