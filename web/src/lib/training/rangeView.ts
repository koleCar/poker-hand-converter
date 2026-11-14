/**
 * The hero's whole range at a trainer decision, for the Trainer's range
 * panel (T3, `docs/TRAINER.md` §5): 169 cells in grid order, each with how
 * much of the class reaches the node and how the reference plays it, and
 * the node's options with the share of the range that takes each.
 *
 * Read from the same reference the answer is graded by: preflop the chart
 * node, the flop the library chunk (`flopStudy`), the turn its solve
 * (`turnStudy`), the river its solve on the heuristic-narrowed ranges
 * (`riverStudy`, as the river trainer grades). Pure apart from the solve.
 */

import { flopStudy, riverStudy, turnStudy, type DecisionAnalysis, type FlopLibrary, type OptionAnalysis, type RiverStudy } from "../analysis";
import type { ChartNode, ChartSet } from "../charts";
import type { PhfHand } from "../phf/types";
import { HAND_CLASSES } from "../solver";
import { flopAnswer, type FlopTrainerSpot } from "./flop";
import { trainerSet, type PreflopTrainerSpot } from "./preflop";
import { riverAnswer, type RiverTrainerSpot } from "./river";
import { turnAnswer, type TurnTrainerSpot } from "./turn";

export interface RangeCell {
  /** `AKs`, `72o`, `TT`. */
  name: string;
  /** Weighted combos of the class that reach the node. */
  combos: number;
  /** Per option: the reference's frequency for the class. */
  freq: number[];
}

export interface RangeView {
  options: Array<Pick<OptionAnalysis, "action" | "allIn" | "sizeBb" | "sizePot">>;
  /** Per option: the share of the whole range that takes it. */
  shares: number[];
  /** 169 cells in grid order (`HAND_CLASSES`). */
  cells: RangeCell[];
  /** The hero's class (highlighted). */
  heroClass: string;
}

/** A chart node as a range view. */
export function chartRange(node: ChartNode, heroClass: string): RangeView {
  const n = HAND_CLASSES.length;
  const options = node.options.map((option) =>
    option.action === "allin"
      ? { action: (node.toMatchBb > node.inBb ? "raise" : "bet") as OptionAnalysis["action"], allIn: true, sizeBb: option.toBb }
      : { action: option.action as OptionAnalysis["action"], sizeBb: option.action === "raise" ? option.toBb : undefined },
  );
  const cells: RangeCell[] = HAND_CLASSES.map((klass, k) => ({
    name: klass.name,
    combos: klass.combos * node.range[k],
    freq: node.options.map((_, a) => node.freq[a * n + k]),
  }));
  const total = cells.reduce((sum, cell) => sum + cell.combos, 0);
  const shares = options.map((_, a) => (total > 0 ? cells.reduce((sum, cell) => sum + cell.combos * cell.freq[a], 0) / total : 0));
  return { options, shares, cells, heroClass };
}

/** A solved node's study as a range view. */
export function studyRange(study: RiverStudy): RangeView {
  return {
    options: study.options.map((o) => ({
      action: o.action,
      ...(o.allIn ? { allIn: true } : {}),
      ...(o.sizeBb !== null ? { sizeBb: o.sizeBb } : {}),
      ...(o.sizePot !== null ? { sizePot: o.sizePot } : {}),
    })),
    shares: study.options.map((o) => o.share),
    cells: HAND_CLASSES.map((klass, k) => ({ name: klass.name, combos: study.cells[k]?.combos ?? 0, freq: study.cells[k]?.freq ?? [] })),
    heroClass: study.heroClass,
  };
}

const isStudy = (value: unknown): value is RiverStudy => Boolean(value) && Array.isArray((value as RiverStudy).cells);

/**
 * The range at a hero decision of `hand` (the decision at `actionIndex`, with
 * any answer appended): postflop the study of its street, preflop the chart
 * node the analysis read (`decision.facts.chart`).
 */
export function decisionRange(
  hand: PhfHand,
  actionIndex: number,
  street: "preflop" | "flop" | "turn" | "river",
  charts: ChartSet,
  flopLibrary: FlopLibrary | null,
  decision: DecisionAnalysis | null = null,
): RangeView | null {
  if (street === "preflop") {
    const ref = decision?.facts.chart;
    if (!ref) return null;
    const node = trainerSet(charts, ref.set).nodes.get(ref.line);
    return node ? chartRange(node, decision?.facts.handClass ?? "") : null;
  }
  const study =
    street === "flop"
      ? flopLibrary
        ? flopStudy(structuredClone(hand), actionIndex, { charts, flopLibrary })
        : null
      : street === "turn"
        ? turnStudy(structuredClone(hand), actionIndex, { charts, turn: true })
        : riverStudy(structuredClone(hand), actionIndex, { charts, turn: false });
  return isStudy(study) ? studyRange(study) : null;
}

/** The range at a dealt spot's decision. */
export function spotRange(spot: PreflopTrainerSpot | FlopTrainerSpot | TurnTrainerSpot | RiverTrainerSpot, charts: ChartSet, flopLibrary: FlopLibrary | null): RangeView | null {
  if (spot.kind === "preflop") {
    const node = trainerSet(charts, spot.set).nodes.get(spot.line);
    return node ? chartRange(node, spot.handClass) : null;
  }
  const { hand, actionIndex } = spot.kind === "flop" ? flopAnswer(spot, 0) : spot.kind === "turn" ? turnAnswer(spot, 0) : riverAnswer(spot, 0);
  return decisionRange(hand, actionIndex, spot.kind, charts, flopLibrary);
}
