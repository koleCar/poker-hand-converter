/**
 * Where the felt opens on a trainer spot: the moment the decision is the
 * hero's — its last action, or, when the decision opens a street (first to
 * act on the river), that street's deal, so the card just dealt is on the
 * board. Never the replayer's "end", whose label ("End of hand") would be
 * wrong for a hand that stops at a decision.
 */

import type { PhfHand } from "../../../lib/phf/types";
import type { ReplayPosition } from "../../replayer/position";

const ORDER = ["preflop", "flop", "turn", "river"] as const;

export function lastAction(hand: PhfHand): ReplayPosition {
  const run = hand.board.runouts[0];
  const dealt = run?.river ? "river" : run?.turn ? "turn" : run?.flop ? "flop" : "preflop";
  const last = hand.actions[hand.actions.length - 1];
  if (!last) return { kind: "start" };
  const lastStreet = ORDER.indexOf(last.street as (typeof ORDER)[number]);
  if (lastStreet >= 0 && lastStreet < ORDER.indexOf(dealt)) return { kind: "street", street: dealt };
  return { kind: "action", actionIndex: last.index };
}
