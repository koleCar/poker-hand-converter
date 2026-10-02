/**
 * Grading a trainer answer, and a drill answer.
 *
 * **Trainer spots** (preflop and river) are graded by the analysis itself:
 * the spot's hand with the hero's answer appended goes through
 * `analyzeHand(hand, { only })`, the same walk, chart lookup, solve, caps and
 * sensitivity check a real hand gets. A trainer grade and an analysis grade
 * of the same spot are therefore one computation, not two that agree - with
 * one difference since A5a: a trainer river is narrowed through the turn by
 * the heuristic (`turn: false`), the way the trainer built it, where a real
 * hand's river starts from its solved turn.
 *
 * **Drills** replay one of the player's own graded decisions. The options
 * were stored with the grade (`decision_analysis.options`), so an answer is
 * graded against them with the same `grade()` and the same caps:
 *
 * - the answer the player actually made keeps its stored grade exactly;
 * - an off-tree size anywhere in the line (`off-tree-size`) caps at
 *   Inaccurate, as it did for the stored grade (§3.3);
 * - a solver grade is capped at Mistake (A4's `range-cap`): the exceptions
 *   that kept a Blunder (folding a hand that cannot lose, calling with one
 *   that beats nothing) were judged for the action taken, and a different
 *   answer is never assumed to be one of them.
 */

import type { ChartSet } from "../charts";
import { analyzeHand, grade, type Approximation, type DecisionAnalysis, type Grade, type GradeResult, type OptionAnalysis } from "../analysis";
import type { PhfHand } from "../phf/types";

/**
 * The analysis' verdict on one hero decision of `hand`, or null when the hand
 * has no hero decision at `actionIndex`. Does not mutate `hand`.
 */
export function gradeAnswer(hand: PhfHand, actionIndex: number, charts: ChartSet | null): DecisionAnalysis | null {
  // `turn: false`: a trainer river is built on ranges the heuristic narrowed
  // through the flop and turn (`river.ts`), so it is graded on them too; a
  // turn solve per answer would also cost a second or two (A5a).
  const analysis = analyzeHand(structuredClone(hand), { charts, only: actionIndex, turn: false });
  return analysis.decisions.find((decision) => decision.actionIndex === actionIndex) ?? null;
}

/** What a drill keeps of a graded decision. */
export interface DrillDecision {
  options: readonly OptionAnalysis[];
  /** The option the player chose when they played the hand. */
  chosen: number;
  grade: Grade;
  evLoss: number;
  evLossPot: number;
  freqDiff: number;
  score: number;
  /** Pot before the decision, bb: EV loss is quoted against it. */
  potBb: number;
  source: "chart" | "solver" | "heuristic" | "approx";
  approximations: readonly (Approximation | string)[];
}

/** Grades a drill answer against the stored options (see the module comment for the caps). */
export function gradeDrill(decision: DrillDecision, answer: number): GradeResult {
  if (answer === decision.chosen) {
    return {
      grade: decision.grade,
      evLoss: decision.evLoss,
      evLossPot: decision.evLossPot,
      freqDiff: decision.freqDiff,
      score: decision.score,
    };
  }
  return grade({
    options: decision.options,
    chosen: answer,
    pot: decision.potBb,
    capAtInaccurate: decision.approximations.includes("off-tree-size"),
    // A solver grade and an approximate multiway one (A9) rest on narrowed ranges.
    capAtMistake: decision.source === "solver" || decision.source === "approx",
  });
}

/**
 * The stored decision as if the answer had been played: the options table
 * marks it and the *why* describes it. The flags were about the move really
 * made, so they are dropped, and `range-cap` is re-judged for the answer;
 * the facts (board, ranges, price) are the spot's and stay. The move really
 * made comes back unchanged.
 */
export function asAnswered(decision: DecisionAnalysis, answer: number, result: GradeResult): DecisionAnalysis {
  if (answer === decision.chosen) return decision;
  const option = decision.options[answer];
  // `range-cap` says *this* grade was capped at Mistake: true of the answer
  // only when its own uncapped grade was a Blunder.
  const approximations: Approximation[] = decision.approximations.filter((code) => code !== "range-cap");
  if (decision.source === "solver" || decision.source === "approx") {
    const uncapped = grade({
      options: decision.options,
      chosen: answer,
      pot: decision.facts.potBb,
      capAtInaccurate: decision.approximations.includes("off-tree-size"),
    });
    if (uncapped.grade === "blunder" && result.grade === "mistake") approximations.push("range-cap");
  }
  return {
    ...decision,
    approximations: approximations.sort(),
    action: option ? option.action : decision.action,
    chosen: answer,
    grade: result.grade,
    evLoss: Math.round(result.evLoss * 1000) / 1000,
    evLossPot: Number.isFinite(result.evLossPot) ? Math.round(result.evLossPot * 10_000) / 10_000 : 1,
    freqDiff: Math.round(result.freqDiff * 10_000) / 10_000,
    score: Math.round(result.score * 100) / 100,
    flags: [],
    worstFlag: null,
  };
}
