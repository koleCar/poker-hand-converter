/**
 * The HUD editor's problems (R3.9, `rail_hud::design::Problem`) in the
 * user's words. Which problems refuse a design and which only say what a
 * room leaves out is the Rust side's (`Severity`): a note is the player's
 * words, every other problem refuses.
 */
import type { Dict } from "../../i18n/types";
import type { DesignProblem, HudStat } from "../../lib/ipc";

/** A problem a room only notes (the design may still be used there). */
export function isNote(problem: DesignProblem): boolean {
  return problem.code === "labels";
}

/** The problem as a sentence; `label` names a statistic by id. */
export function problemText(problem: DesignProblem, t: Dict["hudEditor"]["problems"], label: (id: string) => string): string {
  switch (problem.code) {
    case "version":
    case "nameTooLong":
    case "noCells":
    case "tooManyCells":
    case "columns":
    case "tooManyPopup":
    case "titleTooLong":
    case "labels":
    case "roomNotAllowed":
      return t[problem.code];
    case "colourThresholds":
      return t.colourThresholds(label(problem.stat), problem.count, problem.max);
    default:
      return t[problem.code](label(problem.stat));
  }
}

/** A statistic's short label in `locale`, else its id. */
export function statLabel(stats: readonly HudStat[], locale: "en" | "hr"): (id: string) => string {
  return (id) => stats.find((stat) => stat.id === id)?.label[locale] ?? id;
}
