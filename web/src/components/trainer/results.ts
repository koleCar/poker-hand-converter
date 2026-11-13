/**
 * A graded trainer answer as the account keeps it (`trainer_results`,
 * written by `record_trainer_results`): one shape for the web
 * (`lib/db/training.ts`) and the desktop app (`app/src/trainer/outbox.ts`,
 * through Rust), so the study plan counts an answer the same wherever it
 * was given. Pure.
 *
 * The mode is the spot's street; the family the preflop family, else the
 * pot type; the spot the chart line, else the line id (a flop's library
 * line). Null for a turn spot: the table keeps preflop, flop, river and
 * drill answers only.
 */

import type { Grade } from "../../lib/analysis/types";
import type { TrainerAnswer, TrainerSpot } from "../../lib/training";

export interface TrainerResultRow {
  mode: "preflop" | "flop" | "river" | "drill";
  family: string;
  spot: string;
  position: string | null;
  handClass: string | null;
  grade: Grade;
  evLossBb: number;
  evLossPot: number;
  score: number;
}

export function trainerResultRow(spot: TrainerSpot, answer: TrainerAnswer, handClass: string | null): TrainerResultRow | null {
  if (spot.kind === "turn") return null;
  return {
    mode: spot.kind,
    family: spot.kind === "preflop" ? spot.family : spot.pot,
    spot: spot.kind === "preflop" ? spot.line : spot.lineId,
    position: spot.hero,
    handClass,
    grade: answer.grade,
    evLossBb: answer.evLoss,
    evLossPot: answer.evLossPot,
    score: answer.score,
  };
}
