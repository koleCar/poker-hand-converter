/**
 * The one answer to "what colour is this decision".
 *
 * A grade wins when there is one (A2 onwards). Without one, the loudest flag
 * decides — and a flag can only ever be a `note` or `inaccurate` (§3.6), so a
 * heuristic can never paint a decision the red of a Blunder. A decision with
 * nothing to say is `neutral`; one the analysis skipped is `skipped`, which
 * the list draws struck-through rather than coloured, because "not analysed"
 * must not look like "fine".
 */

import type { ReplayMarkTone } from "../replayer/ReplayViewer";

export type DecisionTone = ReplayMarkTone | "skipped";

export interface Toned {
  status: string;
  grade: string | null;
  worstFlag: string | null;
}

const GRADE_TONES = new Set(["perfect", "good", "inaccurate", "mistake", "blunder"]);

export function toneOf(decision: Toned): DecisionTone {
  if (decision.status === "not-analysed") return "skipped";
  if (decision.grade && GRADE_TONES.has(decision.grade)) return decision.grade as DecisionTone;
  if (decision.worstFlag === "inaccurate") return "inaccurate";
  if (decision.worstFlag === "note") return "note";
  return "neutral";
}

/** Louder first: what a hand's worst decision is chosen by. */
const LOUDNESS: Record<DecisionTone, number> = {
  blunder: 7,
  mistake: 6,
  inaccurate: 5,
  note: 4,
  good: 3,
  perfect: 2,
  neutral: 1,
  skipped: 0,
};

export function loudness(tone: DecisionTone): number {
  return LOUDNESS[tone];
}
