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
 *
 * **Perfect is the best move** (#417). The analysis calls a move Perfect
 * when the reference plays it within five points of its most frequent
 * option, whatever it costs; the trainer, which tells a player what to play,
 * keeps Perfect for an answer that loses no EV it shows (`bestMoveGrade`).
 * Any other move the reference plays that often is Good, the best move
 * named beside it. Drills keep their stored grades (above).
 */

import type { ChartSet } from "../charts";
import {
  analyzeHand,
  grade,
  type AnalysisSource,
  type Approximation,
  type DecisionAnalysis,
  type FlopLibrary,
  type Grade,
  type GradeResult,
  type OptionAnalysis,
} from "../analysis";
import type { PhfHand } from "../phf/types";

/**
 * The analysis' verdict on one hero decision of `hand`, or null when the hand
 * has no hero decision at `actionIndex`. Does not mutate `hand`.
 */
export function gradeAnswer(
  hand: PhfHand,
  actionIndex: number,
  charts: ChartSet | null,
  options: { turn?: boolean; flopLibrary?: FlopLibrary | null } = {},
): DecisionAnalysis | null {
  // `turn: false` (the default): a trainer river is built on ranges the
  // heuristic narrowed through the flop and turn (`river.ts`), so it is graded
  // on them too; a turn solve per answer would also cost a second or two
  // (A5a). A trainer turn (`turn.ts`) is graded by the turn solve itself, and
  // a trainer flop (`flop.ts`, Learn L2) by the flop library it was dealt from.
  const analysis = analyzeHand(structuredClone(hand), {
    charts,
    only: actionIndex,
    turn: options.turn ?? false,
    flopLibrary: options.flopLibrary ?? null,
  });
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
  source: AnalysisSource;
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
    // Every grade but the charts' and the push/fold game's (R5.5) is postflop: the big-blind floor (analysis/33).
    bbFloor: decision.source !== "chart" && decision.source !== "icm",
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
      bbFloor: true,
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

/** EV lost up to this many big blinds reads as none: the verdict's "No EV lost". */
export const NO_LOSS_BB = 0.005;

/**
 * The trainer's Perfect: a Perfect that loses EV the verdict shows (more
 * than `NO_LOSS_BB`) is a move the reference mixes in, not the best one,
 * so it is Good. Every other grade comes back as it is.
 */
export function bestMoveGrade<T extends { grade: Grade | null; evLoss: number | null }>(graded: T): T {
  return graded.grade === "perfect" && (graded.evLoss ?? 0) > NO_LOSS_BB ? { ...graded, grade: "good" } : graded;
}

/**
 * Every option of a graded decision as the trainer would grade it had it
 * been the answer: the answer's own grade for the answer, the others as a
 * drill grades them (the same caps, `gradeDrill`) with the trainer's
 * Perfect. Empty when the decision is not graded.
 */
export function optionGrades(decision: DecisionAnalysis): Grade[] {
  const { grade: own, chosen } = decision;
  if (own === null || chosen === null || decision.options.length === 0) return [];
  const stored: DrillDecision = {
    options: decision.options,
    chosen,
    grade: own,
    evLoss: decision.evLoss ?? 0,
    evLossPot: decision.evLossPot ?? 0,
    freqDiff: decision.freqDiff ?? 0,
    score: decision.score ?? 0,
    potBb: decision.facts.potBb,
    source: decision.source,
    approximations: decision.approximations,
  };
  return decision.options.map((_, i) => (i === chosen ? own : bestMoveGrade(gradeDrill(stored, i)).grade));
}
