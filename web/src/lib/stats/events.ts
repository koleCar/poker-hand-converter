/**
 * Per-seat decision events (docs/STATS-SPEC.md §14.1): every decision of a
 * hand with the betting state it was made in, read from the same
 * `StatsContext` the counters walk. A custom statistic and the Analytics
 * catalogue (`analytics.ts`) are filters over these (`predicate.ts`).
 *
 * A port of the desktop's `core/rail-stats/src/events.rs`, line for line, so
 * a predicate counts the same seats in both apps (docs/ANALYTICS.md Step 1).
 * `npm run golden:emit` writes every corpus hand's events (as a hash), its
 * catalogue counts and its membership to `testdata/golden-analytics/`, and
 * `core/rail-stats/tests/analytics_corpus.rs` derives the Rust ones and
 * compares.
 *
 * Sizes are integers in **thousandths** (of a big blind, or of a percentage
 * point), rounded down - in BigInt, as Rust's i128 does them; a size the hand
 * cannot give (no big blind, an empty pot) is null.
 *
 * Nothing here changes a counter: the counters do not read events.
 */

import type { Amount, PhfHand, Position, Street } from "../phf/types";
import { isPostingAction } from "../phf/types";
import type { Decision, PostflopStreet, StatsContext } from "./context";
import { buildContext, liveOnStreet } from "./context";
import { moneyBySeat } from "./money";
import { cbetChain } from "./postflop";
import { stealAttempt } from "./preflop";

/** What a decision faced (`Facing`). */
export type Facing = "none" | "limp" | "bet" | "raise";

/** The five decision actions. */
export type EventAction = "fold" | "check" | "call" | "bet" | "raise";

/** One decision of one seat (`DecisionEvent`). */
export interface DecisionEvent {
  /** `Decision.order`: what a stored analysis row's `ord` is. */
  order: number;
  street: Street;
  action: EventAction;
  allIn: boolean;
  facing: Facing;
  raiseLevel: number;
  limpers: number;
  callers: number;
  firstOnStreet: boolean;
  firstAtLevel: boolean;
  checkedBefore: boolean;
  ownRaise: number;
  facingSteal: boolean;
  facingCbet: boolean;
  barrels: number;
  initiative: boolean;
  aheadOfAggressor: boolean;
  /** The street before (the flop for the turn, the turn for the river) was dealt and nobody bet on it. */
  checkedThrough: boolean;
  /** Postflop: the seat is the last to make its first decision on the street; null preflop. */
  inPosition: boolean | null;
  players: number;
  /** Thousandths of a big blind. */
  potBb: number | null;
  sizeBb: number | null;
  /** Thousandths of a percentage point. */
  sizePot: number | null;
  facingSizePot: number | null;
}

/** A seat and its decisions (`SeatEvents`). */
export interface SeatEvents {
  seat: number;
  hero: boolean;
  position: Position | null;
  postedBlind: boolean;
  bigBlind: boolean;
  preflopAggressor: boolean;
  stackBb: number | null;
  effectiveBb: number | null;
  sawFlop: boolean;
  sawTurn: boolean;
  sawRiver: boolean;
  showdown: boolean;
  won: boolean;
  cardsKnown: boolean;
  pocketPair: boolean | null;
  suited: boolean | null;
  events: DecisionEvent[];
}

/** One hand's events, per dealt-in seat in `statsRows` order (`HandEvents`). */
export interface HandEvents {
  bombPot: boolean;
  straddle: boolean;
  buttonBlind: boolean;
  walk: boolean;
  dealt: number;
  maxSeats: number;
  preflopRaises: number;
  seats: SeatEvents[];
}

/** `amount * 1000 / unit`, rounded down; null unless `unit > 0` and `amount >= 0`. */
function thousandthsOf(amount: bigint, unit: bigint): number | null {
  if (unit <= 0n || amount < 0n) {
    return null;
  }
  return Number((amount * 1000n) / unit);
}

/** The betting state before an action: the pot, and per seat the street total. */
interface Money {
  pot: Amount;
  street: Street | null;
  totals: Map<number, Amount>;
  lastSize: number | null;
}

function high(money: Money): Amount {
  let out = 0;
  for (const total of money.totals.values()) {
    out = Math.max(out, total);
  }
  return out;
}

interface Sizes {
  potBb: number | null;
  sizeBb: number | null;
  sizePot: number | null;
  facingSizePot: number | null;
}

function sizes(
  money: Money,
  seat: number,
  kind: string,
  amount: Amount,
  total: Amount,
  bigBlind: Amount,
): Sizes {
  const bb = BigInt(bigBlind);
  const pot = BigInt(money.pot);
  const sizeBb = kind === "call" || kind === "bet" || kind === "raise" ? thousandthsOf(BigInt(total), bb) : null;
  let sizePot: number | null = null;
  if (kind === "bet") {
    sizePot = thousandthsOf(BigInt(amount) * 100n, pot);
  } else if (kind === "raise") {
    const top = BigInt(high(money));
    const call = top - BigInt(money.totals.get(seat) ?? 0);
    sizePot = thousandthsOf((BigInt(total) - top) * 100n, pot + call);
  }
  return { potBb: thousandthsOf(pot, bb), sizeBb, sizePot, facingSizePot: money.lastSize };
}

function previousAggressor(context: StatsContext, street: Street): number | null {
  switch (street) {
    case "flop":
      return context.preflopAggressor;
    case "turn":
      return context.streetAggressor.get("flop") ?? null;
    case "river":
      return context.streetAggressor.get("turn") ?? null;
    default:
      return null;
  }
}

function barrelsBefore(chain: ReturnType<typeof cbetChain>, street: Street): number {
  let barrels = 0;
  for (const earlier of ["flop", "turn"] as const) {
    if (earlier === street || (earlier === "turn" && street === "flop")) {
      break;
    }
    const link = chain[earlier];
    if (link.made === null || !link.called) {
      break;
    }
    barrels += 1;
  }
  return barrels;
}

function twoCards(hole: readonly string[] | undefined): [[string, string], [string, string]] | null {
  if (!hole || hole.length !== 2) {
    return null;
  }
  const card = (text: string): [string, string] | null => {
    const chars = [...text];
    return chars.length === 2 ? [chars[0], chars[1]] : null;
  };
  const a = card(hole[0]);
  const b = card(hole[1]);
  return a && b ? [a, b] : null;
}

/** Every seat's decision events in one hand (`hand_events`). Positions are assigned on a copy when the hand has none. */
export function handEvents(hand: PhfHand): HandEvents {
  const positioned =
    hand.players.length > 0 && hand.players.every((player) => player.position === null)
      ? (structuredClone(hand) as PhfHand)
      : hand;
  return eventsOf(positioned);
}

function eventsOf(hand: PhfHand): HandEvents {
  const context = buildContext(hand);
  const money = moneyBySeat(context);
  const chain = cbetChain(context);
  const steal = stealAttempt(context);
  const bigBlind = context.bigBlind;

  // The size facts of every decision, from one walk of the stream.
  const sized: (Sizes | null)[] = [];
  {
    const state: Money = { pot: 0, street: null, totals: new Map(), lastSize: null };
    let next = 0;
    for (const action of hand.actions) {
      if (state.street !== action.street) {
        state.street = action.street;
        state.totals.clear();
        state.lastSize = null;
      }
      const decision = context.decisions[next]?.action === action ? context.decisions[next++] : undefined;
      const seat = action.seat;
      if (decision && seat !== null) {
        const facts = sizes(state, seat, decision.type, action.amount, action.streetTotal, bigBlind);
        sized.push(facts);
        if (decision.type === "bet" || decision.type === "raise") {
          state.lastSize = facts.sizePot;
        }
      }
      const movesChips =
        isPostingAction(action.type) ||
        action.type === "call" ||
        action.type === "bet" ||
        action.type === "raise" ||
        action.type === "uncalled";
      if (movesChips) {
        state.pot += action.amount;
      }
      if (
        seat !== null &&
        (action.type === "call" ||
          action.type === "bet" ||
          action.type === "raise" ||
          (isPostingAction(action.type) && action.type !== "ante" && action.type !== "bomb-ante"))
      ) {
        state.totals.set(seat, action.streetTotal);
      }
    }
    while (sized.length < context.decisions.length) {
      sized.push(null);
    }
  }

  const streetOf = (street: Street): Decision[] => context.byStreet.get(street) ?? [];
  const lastFirst = (street: Street): number | null => {
    const seen: number[] = [];
    for (const decision of streetOf(street)) {
      if (!seen.includes(decision.seat)) {
        seen.push(decision.seat);
      }
    }
    return seen.length > 0 ? seen[seen.length - 1] : null;
  };
  const lastToAct = new Map<Street, number | null>(
    (["flop", "turn", "river"] as const).map((street) => [street, lastFirst(street)]),
  );
  const playersOn = (street: Street): number => {
    if (street === "preflop") {
      return context.dealtInSeats.length;
    }
    return context.dealtInSeats.filter((seat) => liveOnStreet(context, seat, street as PostflopStreet)).length;
  };
  const stacks = context.dealtInSeats.map((seat) => [seat, context.players.get(seat)?.startingStack ?? 0] as const);

  const event = (decision: Decision, mine: Decision[]): DecisionEvent => {
    const { seat, street } = decision;
    const earlier = mine.filter((other) => other.street === street && other.order < decision.order);
    let facing: Facing;
    if (street === "preflop") {
      facing = decision.raisesBefore >= 1 ? "raise" : decision.enteredBefore.length === 0 ? "none" : "limp";
    } else {
      facing = decision.raisesBefore >= 1 ? "raise" : decision.betsBefore >= 1 ? "bet" : "none";
    }
    let ownRaise = 0;
    for (let i = earlier.length - 1; i >= 0; i -= 1) {
      if (earlier[i].type === "raise") {
        ownRaise = earlier[i].raisesBefore + 1;
        break;
      }
    }
    const facingSteal =
      street === "preflop" &&
      decision.raisesBefore === 1 &&
      steal !== null &&
      steal.seat !== seat &&
      decision.order > steal.order;
    const link = street === "preflop" || street === "showdown" ? null : chain[street];
    const facingCbet =
      street !== "preflop" &&
      seat !== context.preflopAggressor &&
      link !== null &&
      link.made !== null &&
      decision.order > link.made.order &&
      decision.raisesBefore === 0;
    const previous = previousAggressor(context, street);
    const aheadOfAggressor =
      previous !== null &&
      previous !== seat &&
      liveOnStreet(context, previous, street as PostflopStreet) &&
      !streetOf(street).some((other) => other.seat === previous && other.order < decision.order);
    const checkedThrough =
      (street === "turn" && context.dealt.has("flop") && (context.streetAggressor.get("flop") ?? null) === null) ||
      (street === "river" && context.dealt.has("turn") && (context.streetAggressor.get("turn") ?? null) === null);
    const facts = sized[decision.order] ?? null;
    return {
      order: decision.order,
      street,
      action: decision.type as EventAction,
      allIn: decision.action.allIn,
      facing,
      raiseLevel: decision.raisesBefore,
      limpers: street === "preflop" && decision.raisesBefore === 0 ? decision.enteredBefore.length : 0,
      callers: decision.callersSinceAggression,
      firstOnStreet: decision.firstOnStreet,
      firstAtLevel: !earlier.some((other) => other.raisesBefore === decision.raisesBefore),
      checkedBefore: decision.checkedBefore,
      ownRaise,
      facingSteal,
      facingCbet,
      barrels: street === "preflop" ? 0 : barrelsBefore(chain, street),
      initiative: previous === seat,
      aheadOfAggressor,
      checkedThrough,
      inPosition: street === "preflop" ? null : (lastToAct.get(street) ?? null) === seat,
      players: playersOn(street),
      potBb: facts?.potBb ?? null,
      sizeBb: facts?.sizeBb ?? null,
      sizePot: facts?.sizePot ?? null,
      facingSizePot: facts?.facingSizePot ?? null,
    };
  };

  const seats: SeatEvents[] = context.dealtInSeats.map((seat) => {
    const player = context.players.get(seat);
    const mine = context.decisions.filter((decision) => decision.seat === seat);
    const stack = player?.startingStack ?? 0;
    let others: number | null = null;
    for (const [other, otherStack] of stacks) {
      if (other !== seat) {
        others = others === null ? otherStack : Math.max(others, otherStack);
      }
    }
    const effective = others === null ? stack : Math.min(others, stack);
    const hole = player?.holeCards;
    const cards = twoCards(hole);
    const live = (street: PostflopStreet) => liveOnStreet(context, seat, street);
    return {
      seat,
      hero: player?.isHero ?? false,
      position: context.position.get(seat) ?? null,
      postedBlind: context.blindSeats.has(seat),
      bigBlind: context.bigBlindSeat === seat,
      preflopAggressor: context.preflopAggressor === seat,
      stackBb: thousandthsOf(BigInt(stack), BigInt(bigBlind)),
      effectiveBb: thousandthsOf(BigInt(effective), BigInt(bigBlind)),
      sawFlop: live("flop"),
      sawTurn: live("turn"),
      sawRiver: live("river"),
      showdown: context.liveSeats.length >= 2 && context.liveSeats.includes(seat),
      won: (money.get(seat)?.won ?? 0) > 0,
      cardsKnown: (hole?.length ?? 0) > 0,
      pocketPair: cards ? cards[0][0] === cards[1][0] : null,
      suited: cards ? cards[0][1] === cards[1][1] : null,
      events: mine.map((decision) => event(decision, mine)),
    };
  });

  return {
    bombPot: context.isBombPot,
    straddle: context.hasStraddle,
    buttonBlind: context.hasButtonBlind,
    walk: context.isWalk,
    dealt: context.dealtInSeats.length,
    maxSeats: hand.table.maxSeats,
    preflopRaises: streetOf("preflop").filter((decision) => decision.type === "raise").length,
    seats,
  };
}
