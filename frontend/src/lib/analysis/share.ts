/**
 * A shared analysis on a hand somebody else is looking at (A7.1, §6.1, §8.4).
 *
 * The analysis is stored against the owner's private hand; a stranger sees it
 * beside a *copy* — the published (scrubbed) document, a forum post's hand, or
 * a share link's hand re-read from its standard text. The decisions point into
 * the hand by `PhfAction.index`, and pips, chips and the sheet seek by it, so
 * before drawing anything the page checks that every decision still lands on
 * a hero action of the same street and kind. A copy that does not line up shows
 * no analysis rather than grades on the wrong actions.
 */

import type { PhfHand } from "../phf/types";
import type { HandAnalysis } from "./types";

/** True when every decision of `analysis` names a hero action of `hand` on the same street, of the same kind. */
export function analysisFitsHand(analysis: Pick<HandAnalysis, "decisions">, hand: PhfHand): boolean {
  const hero = hand.players.find((player) => player.isHero);
  if (!hero) return false;
  return analysis.decisions.every((decision) => {
    const action = hand.actions.find((candidate) => candidate.index === decision.actionIndex);
    return Boolean(action && action.seat === hero.seat && action.street === decision.street && action.type === decision.action);
  });
}

/**
 * The analysis without the facts that are the owner's and not the hand's:
 * `facts.villain` (analysis/20), the owner's statistics on an opponent from
 * their private library. `read_shared_analysis` leaves it out
 * (`20270407090000`); every reader of a shared analysis drops it again, so a
 * stale server or a cached row cannot put it in a public page. Takes a stored
 * row (`decisions[].facts`) or a mapped `HandAnalysis` alike; returns the
 * same object when there is nothing to drop.
 */
export function withoutOwnerFacts<T extends object>(analysis: T): T {
  const decisions = (analysis as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) return analysis;
  let changed = false;
  const stripped = decisions.map((decision: unknown) => {
    if (!decision || typeof decision !== "object") return decision;
    const facts = (decision as { facts?: unknown }).facts;
    if (!facts || typeof facts !== "object" || Array.isArray(facts) || !("villain" in facts)) return decision;
    changed = true;
    return { ...decision, facts: Object.fromEntries(Object.entries(facts).filter(([key]) => key !== "villain")) };
  });
  return changed ? ({ ...analysis, decisions: stripped } as T) : analysis;
}
