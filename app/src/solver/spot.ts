/**
 * Where a hand's decision sits in the Solver library, for the analysis'
 * split view: what the analysis itself recorded about it.
 *
 * - A preflop decision graded from the charts (`facts.chart`): the set and
 *   the line before it - the chart node the Solver shows preflop.
 * - A flop decision the flop library graded (`facts.flop`): the library line
 *   (its chart key), the flop - the hand's own, in its suits, unless the
 *   library read a representative flop - and the decision's path in the
 *   solve.
 * - A turn or river decision, with the hand at hand: the hand's line to it
 *   (`solverLinkOf`), which the Solver follows onto the turn it solves live
 *   and that turn's river. Without the hand, the hero's last flop decision
 *   the library graded before it.
 *
 * Anything else (multiway, a depth or line the library does not hold, a flop
 * not graded by the library) has no spot.
 */
import type { DecisionAnalysis } from "../analysis/library";
import { CHART_SETS, flopLinesFor, solverLinkOf } from "./door";
import type { SolverStart } from "./param";

export interface SolverSpot extends SolverStart {
  /** A flop decision's path in the solve (`X-B1.82`); null preflop. */
  path: string | null;
  /** The hand's line to the decision (`?walk=`), in place of `path`; null without the hand. */
  walk: string | null;
  /** Shown for a later street: the spot is the hero's last flop decision, not this one. */
  fromFlop: boolean;
  /** Changes with the spot: the panel starts over when it does. */
  id: string;
}

/** The chart set the hand was read from: any of its decisions' chart reference. */
function setOf(decisions: readonly DecisionAnalysis[]): string | null {
  for (const d of decisions) if (d.facts.chart?.set) return d.facts.chart.set;
  return null;
}

function flopSpot(d: DecisionAnalysis, set: string): Omit<SolverSpot, "fromFlop" | "id" | "walk"> | null {
  const facts = d.facts.flop;
  if (!facts) return null;
  const players = CHART_SETS.find((s) => s.id === set)?.players;
  if (!players) return null;
  const line = flopLinesFor(players).find((l) => l.id === facts.line);
  if (!line) return null;
  const own = d.facts.board.slice(0, 3).join("");
  return {
    set,
    line: line.key,
    flop: !facts.mapped && own.length === 6 ? own : facts.flop,
    node: null,
    turn: null,
    path: facts.path,
  };
}

export function solverSpotOf(decisions: readonly DecisionAnalysis[], decision: DecisionAnalysis, hand?: unknown): SolverSpot | null {
  const set = setOf(decisions);
  if (!set) return null;
  const done = (spot: Omit<SolverSpot, "fromFlop" | "id" | "walk"> | null, fromFlop: boolean, walk: string | null = null): SolverSpot | null =>
    spot ? { ...spot, walk, fromFlop, id: [spot.set, spot.line, spot.flop, spot.path, walk].join("|") } : null;

  if (hand && decision.street !== "preflop") {
    // The web's PHF: the app's own model is the same shape (`handAnalysisOf` passes it the same way).
    const link = solverLinkOf(decisions, decision, hand as Parameters<typeof solverLinkOf>[2]);
    if (link) return done({ set: link.set, line: link.line, flop: link.flop, node: null, turn: null, path: null }, !link.exact, link.walk || null);
  }

  if (decision.street === "preflop") {
    const chart = decision.facts.chart;
    return chart ? done({ set: chart.set, line: chart.line, flop: null, node: null, turn: null, path: null }, false) : null;
  }
  if (decision.street === "flop") return done(flopSpot(decision, set), false);
  // A turn or river decision: the last flop decision before it the library graded.
  const before = decisions.filter((d) => d.street === "flop" && d.order < decision.order && d.facts.flop);
  const last = before[before.length - 1];
  return last ? done(flopSpot(last, set), true) : null;
}
