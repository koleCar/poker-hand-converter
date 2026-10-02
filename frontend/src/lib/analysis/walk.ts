/**
 * The decision walk: every hero decision, with the money state that existed
 * immediately before it.
 *
 * The stats engine already enumerates decisions (`buildContext` →
 * `Decision`), and this reuses that enumeration rather than walking the
 * stream a second way: `Decision.order` is the key a stored analysis row and a
 * stored statistics row would agree on. What stats never needed and analysis
 * does is **money at the decision** — the pot, the price, the stacks behind —
 * so this file replays the stream alongside and snapshots it at each hero
 * decision.
 *
 * Money rules, each one a place a pot-odds number goes quietly wrong:
 *
 * - **The pot is every chip in, including the current street's bets.** Pot
 *   odds are quoted against everything the call can win, so the bets still in
 *   front of players count.
 * - **Antes are dead money.** They are in the pot but they are nobody's bet: a
 *   player who anted and then faces the big blind owes the whole big blind.
 *   The same goes for a bomb-pot ante.
 * - **The price is capped by the stack.** Facing a bet bigger than the stack
 *   behind, the call is the stack.
 * - **An uncalled bet comes back** — but only after the street's last
 *   decision, so it never sits between a bet and the decision facing it.
 */

import type { PhfAction, PhfHand, Street } from "../phf/types";
import type { Decision, StatsContext } from "../stats/context";

export interface Spot {
  decision: Decision;
  action: PhfAction;
  street: Exclude<Street, "showdown">;
  /** Minor units. Every chip in the middle and in front of players before the action. */
  potBefore: number;
  /** What it costs the hero to continue; 0 when checking is possible. */
  toCall: number;
  /** The street's highest commitment before the action. */
  streetHigh: number;
  /** The hero's commitment on this street before the action. */
  heroStreet: number;
  /** The hero's stack behind before the action. */
  heroBehind: number;
  /** min(hero behind, the deepest live opponent behind). */
  effBehind: number;
  /** The pot when this street's first card came, minor units. */
  streetPot: number;
  /**
   * The effective stack when this street began: the hero's stack behind
   * against the deepest opponent still in. SPR is quoted on these two, as
   * players quote it — "four to one on the flop" — not re-measured after
   * every bet on the street.
   */
  streetEffBehind: number;
  /** Opponents who had not folded, with their stacks behind. */
  opponents: Array<{ seat: number; behind: number; allIn: boolean }>;
  /** Board cards out on this street, runout 0. */
  board: string[];
  /** Chips the hero's action moved in. */
  amount: number;
  /** The hero's street total after the action. */
  streetTotalAfter: number;
  /** The street had a decision before the hero's first one: the hero acts later. */
  inPosition: boolean | null;
  /** The hero's action is the street's last decision and it was a check. */
  closesStreet: boolean;
}

const DEAD_POSTS = new Set<PhfAction["type"]>(["ante", "bomb-ante"]);
const NOT_MONEY = new Set<PhfAction["type"]>(["collect", "cashout-pay", "cashout-choose", "show", "muck"]);

function boardFor(hand: PhfHand, street: Street): string[] {
  const first = hand.board.runouts[0];
  if (!first) return [];
  const flop = first.flop ?? [];
  if (street === "preflop") return [];
  if (street === "flop") return [...flop];
  if (street === "turn") return first.turn ? [...flop, first.turn] : [...flop];
  return [...flop, ...(first.turn ? [first.turn] : []), ...(first.river ? [first.river] : [])];
}

/**
 * One `Spot` per decision of `seat`, in stream order.
 *
 * Walks the raw action stream (posts, antes and returns included — they move
 * money) and matches each of the seat's decisions by identity with the stats
 * engine's own `Decision.action`, so the two cannot drift onto different
 * actions.
 */
export function heroSpots(context: StatsContext, seat: number): Spot[] {
  const hand = context.hand;
  const mine = new Map<PhfAction, Decision>();
  for (const decision of context.decisions) {
    if (decision.seat === seat) {
      mine.set(decision.action, decision);
    }
  }
  if (mine.size === 0) {
    return [];
  }

  const contributed = new Map<number, number>();
  const folded = new Set<number>();
  const allIn = new Set<number>();
  let pot = 0;
  let street: Street | null = null;
  let streetTotals = new Map<number, number>();
  let streetHigh = 0;
  let streetPot = 0;
  let streetBehind = new Map<number, number>();
  const out: Spot[] = [];

  const stackOf = (who: number) => hand.players.find((player) => player.seat === who)?.startingStack ?? 0;
  const behind = (who: number) => Math.max(0, stackOf(who) - (contributed.get(who) ?? 0));

  // Who acted first on each street, among decisions: the player out of position.
  const firstOnStreet = new Map<Street, number>();
  const lastOnStreet = new Map<Street, Decision>();
  for (const decision of context.decisions) {
    if (!firstOnStreet.has(decision.street)) firstOnStreet.set(decision.street, decision.seat);
    lastOnStreet.set(decision.street, decision);
  }

  for (const action of hand.actions) {
    if (action.street !== street) {
      street = action.street;
      streetTotals = new Map();
      streetHigh = 0;
      streetPot = pot;
      streetBehind = new Map(context.dealtInSeats.map((seat) => [seat, behind(seat)]));
    }
    if (action.seat === null || NOT_MONEY.has(action.type)) {
      continue;
    }
    const who = action.seat;

    const decision = mine.get(action);
    if (decision && action.street !== "showdown") {
      const heroStreet = streetTotals.get(who) ?? 0;
      const heroBehind = behind(who);
      const opponents = context.dealtInSeats
        .filter((other) => other !== who && !folded.has(other))
        .map((other) => ({ seat: other, behind: behind(other), allIn: allIn.has(other) }));
      const deepest = Math.max(0, ...opponents.map((opponent) => opponent.behind + (streetTotals.get(opponent.seat) ?? 0) - heroStreet));
      const startBehind = (seat: number) => streetBehind.get(seat) ?? behind(seat);
      const startDeepest = Math.max(0, ...opponents.map((opponent) => startBehind(opponent.seat)));
      const first = firstOnStreet.get(action.street);
      const last = lastOnStreet.get(action.street);
      out.push({
        decision,
        action,
        street: action.street,
        potBefore: pot,
        toCall: Math.min(Math.max(0, streetHigh - heroStreet), heroBehind),
        streetHigh,
        heroStreet,
        heroBehind,
        effBehind: Math.min(heroBehind, deepest),
        streetPot,
        streetEffBehind: Math.min(startBehind(who), startDeepest),
        opponents,
        board: boardFor(hand, action.street),
        amount: action.amount,
        streetTotalAfter: heroStreet + action.amount,
        inPosition: action.street === "preflop" || first === undefined ? null : first !== who,
        closesStreet: action.type === "check" && last?.action === action,
      });
    }

    pot += action.amount;
    contributed.set(who, (contributed.get(who) ?? 0) + action.amount);
    if (action.type === "fold") {
      folded.add(who);
    }
    if (action.allIn) {
      allIn.add(who);
    }
    if (!DEAD_POSTS.has(action.type) && action.type !== "uncalled") {
      const total = (streetTotals.get(who) ?? 0) + action.amount;
      streetTotals.set(who, total);
      streetHigh = Math.max(streetHigh, total);
    }
  }

  return out;
}
