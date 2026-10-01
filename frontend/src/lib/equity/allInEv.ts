/**
 * All-in EV: what each seat would have netted had the pot been split by equity
 * at the moment the money went in, rather than by the board that came.
 *
 * ```
 * evNet(seat) = Σ over pots  equity(seat, pot) x pot  -  contributed(seat)
 * ```
 *
 * **When it applies.** Only when there is variance left to remove: some action
 * leaves at least two players live, every one of them all-in except at most one
 * who has matched the largest bet, and at least one street still to deal. From
 * that action on nobody can make a decision, so the pots are fixed and only the
 * cards are left to fall. Anything else - no all-in, an all-in called on the
 * river, everybody folding - returns a skip, and the caller uses `net`.
 *
 * **Side pots.** The pot layers are built from what each seat finally put in,
 * one layer per distinct contribution level among the live seats, and a layer
 * is contested only by the live seats that reached it. A folded seat's chips are
 * in every layer they reach, but the seat is eligible for none. Equity in each
 * layer is computed against that layer's eligible set alone, which is why
 * `equity()` takes pots rather than being called once per player.
 *
 * **Rake.** Equity is a share of the pot *actually awarded*, so evNet and `net`
 * (`stats/money.ts`) are two divisions of the same money and always sum to the
 * same total. The awarded total is read the way `money.ts` reads it - the
 * collects, less the fees when the room states its collects gross - and the gap
 * between that and the chips put in (the fees, net of any house drop) is taken
 * from the pots in proportion to their size. That is a uniform rate on every
 * chip, which is also what `money.ts` assumes when it charges each winner fees
 * in proportion to what they collected. Rooms that take the rake from the main
 * pot first would split a few cents differently between pots; the per-seat
 * difference is bounded by the rake and the hand total is unaffected.
 *
 * **Folded cards stay in the deck**, even when the summary shows them: the
 * calculation knows the live hands and the board, and nothing else.
 *
 * **Run it twice** needs nothing: equity is taken at the all-in, before any
 * board is dealt, so one runout or two gives the same adjusted line.
 */

import {
  houseIntoPot,
  runoutThroughStreet,
  seatOutOfPot,
  totalFees,
  type Amount,
  type PhfAction,
  type PhfHand,
  type Street,
} from "../phf/types";
import {
  equity,
  EquityInputError,
  holeCardsFor,
  type EquityGame,
  type EquityRequest,
} from "./enumerate";

/**
 * Schema tag for EV rows, versioned separately from `STATS_VERSION`: an
 * equity or side-pot fix re-derives EV and nothing else.
 */
export const EV_VERSION = "ev/1" as const;
export type EvVersion = typeof EV_VERSION;

/** Why a hand has no EV adjustment. Every one of them means "use `net`". */
export type AllInSkipReason =
  /** Stud, draw, razz or anything else without a community board we evaluate. */
  | "unsupported-variant"
  /** A split-pot game; nothing here scores a low half. */
  | "hi-lo"
  /** Two boards dealt before the betting, as in a double-board bomb pot. */
  | "double-board"
  /** No action ever left two or more players with no decision left to make. */
  | "no-all-in"
  /** The all-in was called on the river: there are no cards left to come. */
  | "no-street-to-come"
  /** A live player's hole cards were never shown. */
  | "unknown-hole-cards"
  /** The board the all-in happened on is not in the hand. */
  | "unknown-board"
  /** Cards are present but impossible together (a duplicate, a deuce in short deck). */
  | "invalid-cards"
  /** The stream has betting after the point where none should be possible. */
  | "action-after-all-in";

export interface EvPot {
  /** What this pot paid out: its chips, plus any house drop, less its share of the fees. */
  amount: Amount;
  /** Chips the players put into this layer. */
  gross: Amount;
  /** Seats that can win it, ascending. */
  eligibleSeats: number[];
  /** Equity of each eligible seat in this pot, aligned with `eligibleSeats`. */
  equity: number[];
  /** `amount` divided by equity, aligned with `eligibleSeats`. Sums to `amount` exactly. */
  shares: Amount[];
}

export interface EvSeat {
  seat: number;
  player: string;
  /** Live at the all-in. Seats that had folded have no equity. */
  live: boolean;
  contributed: Amount;
  /** Sum of this seat's shares of every pot. */
  evWon: Amount;
  /** `evWon - contributed`, in the hand's minor units. */
  evNet: Amount;
}

export interface AllInEv {
  evVersion: EvVersion;
  /** Street the all-in was completed on. */
  street: "preflop" | "flop" | "turn";
  /** `PhfAction.index` of the action that completed it. */
  actionIndex: number;
  /** Board cards out at that moment. */
  board: string[];
  method: "exhaustive" | "monte-carlo";
  /** Boards enumerated or sampled. */
  boards: number;
  /** Main pot first, then each side pot. */
  pots: EvPot[];
  /** One entry per seat that appears in the action stream, ascending. */
  seats: EvSeat[];
}

export type AllInEvOutcome =
  | { applicable: true; ev: AllInEv }
  | { applicable: false; reason: AllInSkipReason; detail: string };

/** Passed through to `equity()`; the defaults are what stored rows use. */
export type AllInEvOptions = Pick<EquityRequest, "method" | "exhaustiveLimit" | "trials" | "seed">;

/* ------------------------------------------------------------- helpers - */

const GAMES: Partial<Record<PhfHand["game"]["variant"], EquityGame>> = {
  holdem: "holdem",
  shortdeck: "shortdeck",
  omaha: "omaha",
  omaha5: "omaha5",
  omaha6: "omaha6",
};

/** Forced money that does not count toward the bet a player has to match. */
const DEAD_POSTS = new Set<PhfAction["type"]>(["ante", "bomb-ante"]);

/** Action types that can put chips in or take a player out of the hand. */
const BETTING = new Set<PhfAction["type"]>([
  "ante",
  "small-blind",
  "big-blind",
  "straddle",
  "post",
  "missed-blind",
  "bomb-ante",
  "fold",
  "call",
  "bet",
  "raise",
]);

function skip(reason: AllInSkipReason, detail: string): AllInEvOutcome {
  return { applicable: false, reason, detail };
}

/**
 * Chips each seat put in, net of uncalled returns - the same arithmetic as
 * `contributedBySeat` in `stats/money.ts`, which `lib/equity` may not import.
 * The two must agree, or evNet and net stop summing to the same total.
 */
function contributions(hand: PhfHand): Map<number, Amount> {
  const out = new Map<number, Amount>();
  for (const action of hand.actions) {
    if (action.seat === null || action.amount === 0) {
      continue;
    }
    if (action.type === "collect" || action.type === "cashout-pay") {
      continue;
    }
    out.set(action.seat, (out.get(action.seat) ?? 0) + action.amount);
  }
  return out;
}

/**
 * What the pots paid out in total, read the way `money.ts` reads it: the
 * collects, less the fees when the room wrote its collect lines gross.
 */
function awardedTotal(hand: PhfHand): Amount {
  let collected = 0;
  for (const action of hand.actions) {
    if (action.type === "collect" && action.seat !== null) {
      collected += action.amount;
    }
  }
  const fees = totalFees(hand.results.fees);
  const pot = hand.results.totalPot;
  if (fees > 0 && pot > 0 && Math.abs(collected - pot) < Math.abs(collected - (pot - fees))) {
    return collected - fees;
  }
  return collected;
}

/**
 * Splits `total` in proportion to `weights` so the parts sum to `total`
 * exactly: floor every share, then hand the remaining units to the largest
 * fractional parts, ties to the lower index. Deterministic, and never off by
 * more than one unit per part from the exact share.
 */
function apportion(total: Amount, weights: number[]): Amount[] {
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (magnitude === 0 || sum <= 0) {
    return weights.map(() => 0);
  }
  const exact = weights.map((weight) => (Math.max(0, weight) * magnitude) / sum);
  const parts = exact.map((value) => Math.floor(value));
  let left = magnitude - parts.reduce((acc, part) => acc + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; left > 0 && i < order.length; i += 1) {
    parts[order[i].index] += 1;
    left -= 1;
  }
  return parts.map((part) => sign * part);
}

/** Hole cards for a seat from wherever the hand recorded them, or null. */
function holeCardsOf(hand: PhfHand, seat: number, count: number): string[] | null {
  const player = hand.players.find((entry) => entry.seat === seat);
  if (player && player.holeCards.length === count) {
    return player.holeCards;
  }
  const result = hand.results.players.find((entry) => entry.seat === seat);
  if (result && result.shownCards.length === count) {
    return result.shownCards;
  }
  const shown = hand.actions.find(
    (action) => action.seat === seat && action.type === "show" && action.cards?.length === count,
  );
  return shown?.cards ?? null;
}

/* ---------------------------------------------------------- the moment - */

interface AllInMoment {
  action: PhfAction;
  /** Position of `action` in `hand.actions`. */
  position: number;
  live: number[];
}

/**
 * The first action after which no live player has a decision left.
 *
 * Replays the stream keeping, per seat, the chips committed in total (for the
 * stack check) and on this street (for "has matched"). Antes are dead money and
 * do not count toward the bet to match.
 *
 * A seat is all-in when the room said so or when its committed chips reach its
 * starting stack; either alone misses cases, since not every parser sets the
 * flag and not every room prints a stack. The seats in play are the seats that
 * appear in the stream at all - the same rule `stats/context.ts` uses - so a
 * player who has yet to act still counts as live and still blocks the moment.
 */
function findMoment(hand: PhfHand): AllInMoment | null {
  const inPlay = [
    ...new Set(hand.actions.flatMap((action) => (action.seat === null ? [] : [action.seat]))),
  ].sort((a, b) => a - b);
  const stacks = new Map(
    hand.players.map((player) => [
      player.seat,
      player.startingStack - seatOutOfPot(hand, player.seat),
    ]),
  );
  const committed = new Map<number, Amount>();
  const onStreet = new Map<number, Amount>();
  const allIn = new Set<number>();
  const folded = new Set<number>();
  let street: Street | null = null;

  for (let position = 0; position < hand.actions.length; position += 1) {
    const action = hand.actions[position];
    if (action.seat === null || !BETTING.has(action.type)) {
      continue;
    }
    if (action.street !== street) {
      street = action.street;
      onStreet.clear();
    }
    const seat = action.seat;
    if (action.type === "fold") {
      folded.add(seat);
    } else {
      const total = (committed.get(seat) ?? 0) + action.amount;
      committed.set(seat, total);
      if (!DEAD_POSTS.has(action.type)) {
        onStreet.set(seat, (onStreet.get(seat) ?? 0) + action.amount);
      }
      const stack = stacks.get(seat) ?? 0;
      if (action.allIn || (stack > 0 && total >= stack)) {
        allIn.add(seat);
      }
    }

    const live = inPlay.filter((entry) => !folded.has(entry));
    if (live.length < 2) {
      continue;
    }
    const open = live.filter((entry) => !allIn.has(entry));
    if (open.length > 1) {
      continue;
    }
    if (open.length === 1) {
      const highest = Math.max(...live.map((entry) => onStreet.get(entry) ?? 0));
      if ((onStreet.get(open[0]) ?? 0) < highest) {
        continue;
      }
    }
    return { action, position, live };
  }
  return null;
}

/* --------------------------------------------------------------- pots - */

/**
 * Pot layers from final contributions: one per distinct level a live seat put
 * in, each contested by the live seats that reached it. Chips above the top
 * live level - which only a malformed stream can leave there, since an
 * overbet is returned uncalled - go to the last layer rather than vanish.
 */
function buildPots(
  contributed: Map<number, Amount>,
  live: number[],
): Array<{ gross: Amount; eligible: number[] }> {
  const levels = [
    ...new Set(live.map((seat) => contributed.get(seat) ?? 0).filter((amount) => amount > 0)),
  ].sort((a, b) => a - b);
  const pots: Array<{ gross: Amount; eligible: number[] }> = [];
  let previous = 0;
  for (const level of levels) {
    let gross = 0;
    for (const amount of contributed.values()) {
      gross += Math.max(0, Math.min(amount, level) - Math.min(amount, previous));
    }
    pots.push({ gross, eligible: live.filter((seat) => (contributed.get(seat) ?? 0) >= level) });
    previous = level;
  }
  let above = 0;
  for (const amount of contributed.values()) {
    above += Math.max(0, amount - previous);
  }
  if (above > 0 && pots.length > 0) {
    pots[pots.length - 1].gross += above;
  }
  return pots;
}

/* ---------------------------------------------------------------- api - */

/**
 * The full EV analysis of a hand, or the reason there is none.
 *
 * Never throws for a hand that parsed: everything a real hand can get wrong is
 * a skip reason.
 */
export function analyzeAllIn(hand: PhfHand, options: AllInEvOptions = {}): AllInEvOutcome {
  if (hand.game.hiLo) {
    return skip("hi-lo", "split-pot games are not evaluated");
  }
  const game = GAMES[hand.game.variant];
  if (!game) {
    return skip("unsupported-variant", `variant ${hand.game.variant}`);
  }
  const moment = findMoment(hand);
  if (!moment) {
    return skip("no-all-in", "no action left two players without a decision");
  }
  const street = moment.action.street;
  if (street !== "preflop" && street !== "flop" && street !== "turn") {
    return skip("no-street-to-come", `all-in completed on the ${street}`);
  }
  // Two boards dealt up front show up as a second runout with a flop of its
  // own. After a postflop all-in that cannot be run it twice, which re-deals
  // only the streets still to come. `bombPot.doubleBoard` alone is not the
  // test: the shared parser sets it for any bomb pot with two runouts, and a
  // bomb pot that is simply run twice has a shared flop and is fine.
  const firstFlop = (hand.board.runouts[0]?.flop ?? []).join(" ");
  const secondFlop = hand.board.runouts.some(
    (run) => run.flop !== null && run.flop.join(" ") !== firstFlop,
  );
  if (secondFlop && (street !== "preflop" || hand.game.bombPot?.doubleBoard)) {
    return skip("double-board", "a second flop was dealt before the all-in");
  }

  for (const action of hand.actions.slice(moment.position + 1)) {
    if (action.seat === null) {
      continue;
    }
    if (BETTING.has(action.type) && (action.amount !== 0 || action.type === "fold")) {
      return skip(
        "action-after-all-in",
        `${action.player} ${action.type} after the all-in at #${moment.action.index}`,
      );
    }
  }

  const holeCount = holeCardsFor(game);
  const hands: string[][] = [];
  const unknown: number[] = [];
  for (const seat of moment.live) {
    const cards = holeCardsOf(hand, seat, holeCount);
    if (cards) {
      hands.push(cards);
    } else {
      unknown.push(seat);
    }
  }
  if (unknown.length > 0) {
    return skip("unknown-hole-cards", `no hole cards for seat ${unknown.join(", ")}`);
  }

  const boardSize = street === "preflop" ? 0 : street === "flop" ? 3 : 4;
  const board = street === "preflop" ? [] : runoutThroughStreet(hand.board, 0, street);
  if (board.length !== boardSize) {
    return skip("unknown-board", `${board.length} board cards on the ${street}`);
  }

  const contributed = contributions(hand);
  const layers = buildPots(contributed, moment.live);
  if (layers.length === 0) {
    return skip("no-all-in", "the live players put no chips in");
  }

  // The house drop belongs to the main pot; the fees come off every pot at the
  // same rate. See the file header for why that rate is uniform.
  layers[0].gross += houseIntoPot(hand);
  const grossTotal = layers.reduce((sum, layer) => sum + layer.gross, 0);
  const deductions = apportion(
    grossTotal - awardedTotal(hand),
    layers.map((layer) => layer.gross),
  );

  const index = new Map(moment.live.map((seat, i) => [seat, i]));
  let result;
  try {
    result = equity({
      ...options,
      game,
      hands,
      board,
      pots: layers.map((layer) => layer.eligible.map((seat) => index.get(seat) ?? -1)),
    });
  } catch (error) {
    if (error instanceof EquityInputError) {
      return skip("invalid-cards", error.message);
    }
    throw error;
  }

  const won = new Map<number, Amount>();
  const pots: EvPot[] = layers.map((layer, p) => {
    const amount = layer.gross - deductions[p];
    const potEquity = layer.eligible.map((seat) => result.pots[p][index.get(seat) ?? -1]);
    const shares = apportion(amount, potEquity);
    layer.eligible.forEach((seat, i) => won.set(seat, (won.get(seat) ?? 0) + shares[i]));
    return { amount, gross: layer.gross, eligibleSeats: layer.eligible, equity: potEquity, shares };
  });

  const live = new Set(moment.live);
  const seats: EvSeat[] = [
    ...new Set(hand.actions.flatMap((action) => (action.seat === null ? [] : [action.seat]))),
  ]
    .sort((a, b) => a - b)
    .map((seat) => {
      const put = contributed.get(seat) ?? 0;
      const evWon = won.get(seat) ?? 0;
      return {
        seat,
        player: hand.players.find((player) => player.seat === seat)?.name ?? "",
        live: live.has(seat),
        contributed: put,
        evWon,
        evNet: evWon - put,
      };
    });

  return {
    applicable: true,
    ev: {
      evVersion: EV_VERSION,
      street,
      actionIndex: moment.action.index,
      board,
      method: result.method,
      boards: result.boards,
      pots,
      seats,
    },
  };
}

/** The EV analysis, or null when the hand has none and `ev_net = net`. */
export function allInEv(hand: PhfHand, options: AllInEvOptions = {}): AllInEv | null {
  const outcome = analyzeAllIn(hand, options);
  return outcome.applicable ? outcome.ev : null;
}

/** `evNet` per seat, or null when the hand has no adjustment and `ev_net = net`. */
export function evNetBySeat(
  hand: PhfHand,
  options: AllInEvOptions = {},
): Map<number, Amount> | null {
  const ev = allInEv(hand, options);
  return ev ? new Map(ev.seats.map((seat) => [seat.seat, seat.evNet])) : null;
}
