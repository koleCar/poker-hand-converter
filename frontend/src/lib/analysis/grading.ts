/**
 * Grading: §2 of `docs/ANALYSIS-PLAN.md`, as constants and one function.
 *
 * Every threshold lives here and nowhere else, and every one of them is part of
 * `ANALYSIS_VERSION`: moving `GOOD_MIN_FREQ` from 3.5% to 3% re-grades stored
 * hands, so it is a version bump, not a tweak.
 *
 * Phase A1 has no reference strategy, so nothing calls `grade()` on a real
 * decision yet. It exists now, tested, so that A2 wires preflop charts into a
 * function whose behaviour is already pinned rather than writing the rules and
 * the first caller in the same change.
 */

import { GRADES, type FlagSeverity, type Grade, type OptionAnalysis } from "./types";

/** Within this many frequency points of the most frequent option: Perfect. */
export const PERFECT_FREQ_BAND = 0.05;
/** EV loss at or under this share of the pot: Perfect, whatever the frequency. */
export const PERFECT_EV_LOSS_POT = 0.001;
/** Played at least this often by the reference: Good. */
export const GOOD_MIN_FREQ = 0.035;
/** Rarely played and costing at most this share of the pot: Inaccurate. */
export const INACCURATE_MAX_EV_LOSS_POT = 0.02;
/** At most this share of the pot: Mistake. Anything more is a Blunder. */
export const MISTAKE_MAX_EV_LOSS_POT = 0.08;

/** `max(0, 100 − SCORE_PER_POT · evLossPot)` once EV loss is not negligible. */
export const SCORE_PER_POT = 1000;

export interface GradeInput {
  options: readonly OptionAnalysis[];
  /** Index into `options` of what the hero did, after size mapping. */
  chosen: number;
  /** Pot before the decision, in big blinds. EV loss is quoted against it. */
  pot: number;
  /**
   * Cap the result at Inaccurate: the size played was off the solved tree
   * (§3.3) or the source is a heuristic (§3.6). A grade we cannot stand behind
   * must not be the one that calls a move a Blunder.
   */
  capAtInaccurate?: boolean;
  /**
   * Cap the result at Mistake: a river grade from ranges a heuristic narrowed
   * (A4) can call a move a Mistake, never a Blunder, unless the move loses
   * whatever the opponent holds — the caller decides that and leaves this off.
   */
  capAtMistake?: boolean;
  /** Never award Perfect — the heuristic source's rule (§3.6). */
  noPerfect?: boolean;
}

export interface GradeResult {
  grade: Grade;
  /** bb: max(ev) − ev[chosen]. Never negative. */
  evLoss: number;
  /** `evLoss / pot`. */
  evLossPot: number;
  /** max(freq) − freq[chosen]. */
  freqDiff: number;
  /** 0–100, for averages (§2 "move score"). */
  score: number;
}

/**
 * Grades one decision against its reference options. First matching rule wins:
 *
 * | Perfect    | freq ≥ max(freq) − 0.05, or evLoss ≤ 0.1% pot |
 * | Good       | freq ≥ 3.5%                                   |
 * | Inaccurate | evLossPot ≤ 2%                                |
 * | Mistake    | evLossPot ≤ 8%                                |
 * | Blunder    | everything else                               |
 *
 * EV loss is judged in **% of pot**, not bb: the same 2bb is a disaster in a
 * limped pot and noise in a 4-bet pot. Throws on an empty option list or an
 * out-of-range `chosen`, because grading a decision against nothing is a bug in
 * the caller, never a decision.
 */
export function grade(input: GradeInput): GradeResult {
  const { options, chosen } = input;
  if (options.length === 0 || chosen < 0 || chosen >= options.length) {
    throw new RangeError(`grade(): chosen ${chosen} is not one of ${options.length} options`);
  }
  const maxFreq = Math.max(...options.map((option) => option.freq));
  const maxEv = Math.max(...options.map((option) => option.ev));
  const picked = options[chosen];
  const evLoss = Math.max(0, maxEv - picked.ev);
  const evLossPot = input.pot > 0 ? evLoss / input.pot : evLoss > 0 ? Infinity : 0;
  const freqDiff = Math.max(0, maxFreq - picked.freq);
  const negligible = evLossPot <= PERFECT_EV_LOSS_POT;

  let result: Grade;
  if (picked.freq >= maxFreq - PERFECT_FREQ_BAND || negligible) {
    result = "perfect";
  } else if (picked.freq >= GOOD_MIN_FREQ) {
    result = "good";
  } else if (evLossPot <= INACCURATE_MAX_EV_LOSS_POT) {
    result = "inaccurate";
  } else if (evLossPot <= MISTAKE_MAX_EV_LOSS_POT) {
    result = "mistake";
  } else {
    result = "blunder";
  }

  if (input.capAtInaccurate && gradeRank(result) > gradeRank("inaccurate")) {
    result = "inaccurate";
  }
  if (input.capAtMistake && gradeRank(result) > gradeRank("mistake")) {
    result = "mistake";
  }
  if (input.noPerfect && result === "perfect") {
    result = "good";
  }

  const score = negligible
    ? maxFreq > 0
      ? (100 * picked.freq) / maxFreq
      : 100
    : Math.max(0, 100 - SCORE_PER_POT * evLossPot);

  return { grade: result, evLoss, evLossPot, freqDiff, score };
}

/** 0 for Perfect … 4 for Blunder. */
export function gradeRank(value: Grade): number {
  return GRADES.indexOf(value);
}

/** The worse of a list of grades, or null for an empty list (nothing graded). */
export function worstGrade(values: Iterable<Grade | null>): Grade | null {
  let worst: Grade | null = null;
  for (const value of values) {
    if (value !== null && (worst === null || gradeRank(value) > gradeRank(worst))) {
      worst = value;
    }
  }
  return worst;
}

/** The louder of a list of flag severities, or null. */
export function worstSeverity(values: Iterable<FlagSeverity | null>): FlagSeverity | null {
  let worst: FlagSeverity | null = null;
  for (const value of values) {
    if (value === "inaccurate") {
      return "inaccurate";
    }
    if (value === "note") {
      worst = "note";
    }
  }
  return worst;
}

/** Mean of the move scores, or null when nothing is graded (§2: hand score). */
export function meanScore(scores: Iterable<number | null>): number | null {
  let sum = 0;
  let count = 0;
  for (const value of scores) {
    if (value !== null) {
      sum += value;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}
