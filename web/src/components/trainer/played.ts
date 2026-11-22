/**
 * "Play it ▸" from the Analytics drill-down (docs/ANALYTICS.md Step 9): one
 * of the player's own decisions dealt once as a fixed spot - the seats, the
 * line, the board and the hero's cards as they were played, nothing after
 * the decision shown (`handUpTo`, the drills' spoiler-free rule).
 *
 * The reference is the one the analysis used for that decision: the chart
 * node preflop, the flop library, the turn solve or the river solve
 * after it. Its options were stored with the grade (`decision_analysis`,
 * the desktop's store), so an answer is graded against them exactly as a
 * drill of your own mistakes is (`gradeDrill`, `asAnswered`): no solve runs
 * again, and the move really made keeps its stored grade.
 *
 * Pure; the host loads the hand and its analysis (the web: `get_hand` and
 * `analysis_hand`, what the hand's analysis page loads; the desktop: the
 * store's PHF and stored analysis).
 */

import type { DecisionAnalysis } from "../../lib/analysis/types";
import type { GradeResult } from "../../lib/analysis";
import { primaryBoard, type PhfHand } from "../../lib/phf/types";
import { asAnswered, gradeDrill, handUpTo } from "../../lib/training";
import type { PlayedRef } from "./analytics";

/** What the host loads for a played decision: the hand and its analysed decisions. */
export interface PlayedHand {
  phf: PhfHand;
  decisions: readonly DecisionAnalysis[];
}

export interface PlayedSpot {
  /** The hand up to the decision, as the hero saw it. */
  hand: PhfHand;
  /** The whole hand (the study under the answer reads it). */
  full: PhfHand;
  decision: DecisionAnalysis;
  street: "preflop" | "flop" | "turn" | "river";
  cards: [string, string];
  /** The board at the decision. */
  board: string[];
}

const STREETS = ["preflop", "flop", "turn", "river"] as const;

/**
 * The fixed spot of a played decision: the decision at `ref.action` (and
 * `ref.ord` when given), graded with options. Null when the hand has no such
 * analysed decision, no options or no hero cards.
 */
export function playedSpot(played: PlayedHand, ref: Pick<PlayedRef, "ord" | "action">): PlayedSpot | null {
  const decision =
    played.decisions.find((d) => d.actionIndex === ref.action && (ref.ord < 0 || d.order === ref.ord)) ??
    played.decisions.find((d) => d.actionIndex === ref.action) ??
    null;
  if (!decision || decision.grade === null || decision.chosen === null || decision.options.length === 0) return null;
  const street = (STREETS as readonly string[]).includes(decision.street) ? (decision.street as PlayedSpot["street"]) : null;
  if (!street) return null;
  const hero = played.phf.players.find((player) => player.isHero);
  if (!hero || hero.holeCards.length !== 2) return null;
  const hand = handUpTo(played.phf, decision.actionIndex);
  return { hand, full: played.phf, decision, street, cards: [hero.holeCards[0], hero.holeCards[1]], board: primaryBoard(hand) };
}

/** An answer to a played decision: graded against its stored options, and the decision as if it had been played. */
export function gradePlayed(spot: PlayedSpot, index: number): { result: GradeResult; shown: DecisionAnalysis } {
  const d = spot.decision;
  const result = gradeDrill(
    {
      options: d.options,
      chosen: d.chosen ?? 0,
      grade: d.grade ?? "mistake",
      evLoss: d.evLoss ?? 0,
      evLossPot: d.evLossPot ?? 0,
      freqDiff: d.freqDiff ?? 0,
      score: d.score ?? 0,
      potBb: d.facts.potBb,
      source: d.source,
      approximations: d.approximations,
    },
    index,
  );
  return { result, shown: asAnswered(d, index, result) };
}
