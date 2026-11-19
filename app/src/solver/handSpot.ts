/**
 * The replayer's "Open in Solver": the Solver tab at the spot the hand is at,
 * read off the hand's analysis (`spot.ts` says what the library holds of a
 * decision), or the nearest thing to it the library has.
 *
 * - The hero's decision the replayer stands at, or the next one (the last,
 *   past them all): its spot, exact when the library graded it.
 * - A turn or river the library cannot follow onto (a representative flop):
 *   the hero's last flop decision there (`flop`).
 * - A postflop decision the library has no tree for - multiway, a preflop line
 *   or table it does not solve: the hero's last preflop decision in the
 *   charts, the ranges the hand went to the flop with (`preflop`).
 *
 * A table at a depth no set covers is read on the nearest charted one (the
 * analysis does that itself); `depth` names the set's when it is not the
 * hand's own, so the button can say the spot is approximate.
 */
import type { ReplayPosition } from "@rail/ui/replayer/position";

import type { DecisionAnalysis } from "../analysis/library";
import type { StrategyHero } from "./door";
import { spotParam } from "./param";
import { solverSpotOf } from "./spot";

export interface HandSpot {
  /** The Solver tab's parameter (`param.ts`). */
  param: string;
  /** What the link stands in for: the decision itself, or the nearest the library holds. */
  approx: "exact" | "flop" | "preflop";
  /** The set's stack depth in bb, when it is not the hand's own (more than 10 % off). */
  depth: number | null;
  /** The hand's effective stack in bb at its first decision. */
  handDepth: number | null;
}

const STREETS = ["preflop", "flop", "turn", "river"] as const;

/** The hero's decision at the replayer's position, else the next one, else the last. */
export function decisionAt(decisions: readonly DecisionAnalysis[], position: ReplayPosition | null): DecisionAnalysis | null {
  if (!decisions.length) return null;
  const ordered = [...decisions].sort((a, b) => a.order - b.order);
  if (!position || position.kind === "start") return ordered[0];
  if (position.kind === "end") return ordered[ordered.length - 1];
  if (position.kind === "street") {
    const at = STREETS.indexOf(position.street as (typeof STREETS)[number]);
    return ordered.find((d) => STREETS.indexOf(d.street as (typeof STREETS)[number]) >= at) ?? ordered[ordered.length - 1];
  }
  return ordered.find((d) => d.actionIndex >= position.actionIndex) ?? ordered[ordered.length - 1];
}

function heroOf(decision: DecisionAnalysis): StrategyHero | null {
  const facts = decision.facts;
  return facts.holeCards.length === 2 && facts.position ? { cards: facts.holeCards.join(""), position: facts.position } : null;
}

function setDepth(set: string | null): number | null {
  const match = set ? /-(\d{1,3})bb(?:-|$)/.exec(set) : null;
  return match ? Number(match[1]) : null;
}

export function handSpotOf(decisions: readonly DecisionAnalysis[], hand: unknown, position: ReplayPosition | null): HandSpot | null {
  const decision = decisionAt(decisions, position);
  if (!decision) return null;
  const first = [...decisions].sort((a, b) => a.order - b.order)[0];
  const handDepth = first ? first.facts.effStackBb : null;
  const done = (spot: ReturnType<typeof solverSpotOf>, from: DecisionAnalysis, approx: HandSpot["approx"]): HandSpot | null => {
    if (!spot) return null;
    const depth = setDepth(spot.set);
    const off = depth !== null && handDepth !== null && handDepth > 0 && Math.abs(depth - handDepth) / handDepth > 0.1;
    const final = approx === "exact" && spot.fromFlop ? "flop" : approx;
    const query = new URLSearchParams(spotParam(spot, heroOf(from)));
    if (final !== "exact") query.set("approx", final);
    if (off && handDepth !== null) query.set("eff", String(Math.round(handDepth)));
    return {
      param: query.toString(),
      approx: final,
      depth: off ? depth : null,
      handDepth,
    };
  };

  const own = done(solverSpotOf(decisions, decision, hand), decision, "exact");
  if (own) return own;
  if (decision.street === "preflop") return null;
  // Postflop with no tree: the ranges the hand went to the flop with.
  const preflop = decisions.filter((d) => d.street === "preflop" && d.order < decision.order && d.facts.chart);
  const last = preflop[preflop.length - 1];
  return last ? done(solverSpotOf(decisions, last, hand), last, "preflop") : null;
}
