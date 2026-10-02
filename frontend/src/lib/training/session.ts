/**
 * A training session's score: answers, the Perfect…Blunder count, streaks,
 * EV lost and the mean move score — the trainer's stats line, like GTO
 * Wizard's trainer keeps per session (§0.1), in Rail's own five classes.
 *
 * A **streak** is answers in a row graded Perfect or Good: both are moves the
 * reference plays (§2), so a correct mixed answer does not break it.
 */

import { GRADES, type Grade } from "../analysis";

export const STREAK_GRADES: readonly Grade[] = ["perfect", "good"];

export interface TrainerAnswer {
  grade: Grade;
  /** bb. */
  evLoss: number;
  /** Share of the pot. */
  evLossPot: number;
  /** 0–100 (§2). */
  score: number;
}

export interface SessionStats {
  answers: number;
  counts: Record<Grade, number>;
  streak: number;
  bestStreak: number;
  evLoss: number;
  evLossPot: number;
  scoreSum: number;
}

export function emptySession(): SessionStats {
  return {
    answers: 0,
    counts: Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>,
    streak: 0,
    bestStreak: 0,
    evLoss: 0,
    evLossPot: 0,
    scoreSum: 0,
  };
}

/** The session after one more answer. Pure. */
export function addAnswer(stats: SessionStats, answer: TrainerAnswer): SessionStats {
  const streak = STREAK_GRADES.includes(answer.grade) ? stats.streak + 1 : 0;
  return {
    answers: stats.answers + 1,
    counts: { ...stats.counts, [answer.grade]: stats.counts[answer.grade] + 1 },
    streak,
    bestStreak: Math.max(stats.bestStreak, streak),
    evLoss: stats.evLoss + Math.max(0, answer.evLoss),
    evLossPot: stats.evLossPot + (Number.isFinite(answer.evLossPot) ? Math.max(0, answer.evLossPot) : 1),
    scoreSum: stats.scoreSum + answer.score,
  };
}

/** Mean move score, or null before the first answer. */
export function sessionScore(stats: SessionStats): number | null {
  return stats.answers > 0 ? stats.scoreSum / stats.answers : null;
}

/** Share of answers the reference plays (Perfect or Good), or null. */
export function sessionAccuracy(stats: SessionStats): number | null {
  if (stats.answers === 0) return null;
  return STREAK_GRADES.reduce((sum, g) => sum + stats.counts[g], 0) / stats.answers;
}
