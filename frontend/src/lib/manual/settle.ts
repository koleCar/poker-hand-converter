/**
 * Manual hand entry: who gets the pot.
 *
 * The engine knows what everybody put in; this module turns that into pots and
 * payouts. The uncalled bet comes back first — by the same rule
 * `parsers/shared/p2-handbuilder.ts` uses to write the `Uncalled bet` line, so
 * the text and these numbers cannot disagree — then the rest is layered into a
 * main pot and side pots by contribution, and each pot goes to the best hand
 * among the players still in it.
 *
 * "Best hand" is the evaluator's answer when it can give one: every eligible
 * player's cards known and the board complete. Otherwise, or when the user
 * says so, the winners of each pot are whatever the user picked. A pot with
 * no winner leaves the hand unresolved, and the editor will not build it.
 */

import { categoryOf, evaluate, type HandCategory } from "../equity/evaluator";
import type { Amount } from "../phf/types";
import { HOLE_CARDS, MANUAL_STREETS, type EngineState, type ManualStreet } from "./engine";

export interface ManualPot {
  /** `pot` when there is only one; otherwise `main pot`, `side pot-1`, … */
  name: string;
  /** After rake. */
  amount: Amount;
  /** Seats still in the hand who put in enough to win this pot. */
  eligible: number[];
  /** Winners in seat order left of the button; empty when unresolved. */
  winners: number[];
  /** Whether `winners` came from the cards rather than from the user. */
  auto: boolean;
}

export interface ManualPayout {
  seat: number;
  name: string;
  amount: Amount;
  potName: string;
}

export interface ShowdownHand {
  seat: number;
  value: number;
  category: HandCategory;
}

export interface ManualSettlement {
  uncalled: { seat: number; name: string; amount: Amount; street: ManualStreet } | null;
  /** Pot before rake, after the uncalled bet. */
  totalPot: Amount;
  rake: Amount;
  pots: ManualPot[];
  payouts: ManualPayout[];
  /** Net result per seat, minor units. */
  net: Map<number, Amount>;
  /** Evaluated hands of everybody at showdown whose cards are known. */
  hands: Map<number, ShowdownHand>;
  resolved: boolean;
}

/** User-picked winners per pot index; a pot not listed is decided by the cards. */
export type WinnerPicks = Record<number, number[]>;

/** The uncalled bet, by `p2-handbuilder`'s `deriveUncalled` rule. */
function deriveUncalled(state: EngineState): ManualSettlement["uncalled"] {
  for (let i = MANUAL_STREETS.length - 1; i >= 0; i -= 1) {
    const street = MANUAL_STREETS[i];
    const entries = [...(state.streetCommits.get(street) ?? new Map<number, Amount>()).entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;
    const [seat, top] = entries[0];
    const second = entries[1]?.[1] ?? 0;
    if (top <= second) return null;
    const name = state.players.find((player) => player.seat === seat)?.name ?? "";
    return { seat, name, amount: top - second, street };
  }
  return null;
}

/** Best value of `hole` on `board`: any five for Hold'em, exactly two plus three for Omaha. */
export function handValue(hole: readonly string[], board: readonly string[], omaha: boolean): number {
  if (!omaha) {
    return evaluate([...hole, ...board]);
  }
  let best = -1;
  for (let a = 0; a < hole.length; a += 1) {
    for (let b = a + 1; b < hole.length; b += 1) {
      for (let x = 0; x < board.length; x += 1) {
        for (let y = x + 1; y < board.length; y += 1) {
          for (let z = y + 1; z < board.length; z += 1) {
            const value = evaluate([hole[a], hole[b], board[x], board[y], board[z]]);
            if (value > best) best = value;
          }
        }
      }
    }
  }
  return best;
}

export function settleManual(
  state: EngineState,
  board: readonly string[],
  cardsBySeat: ReadonlyMap<number, readonly string[]>,
  rake: Amount,
  picks: WinnerPicks,
): ManualSettlement {
  const { setup, players } = state;
  const uncalled = deriveUncalled(state);
  const contributed = new Map(players.map((player) => [player.seat, player.contributed]));
  if (uncalled) {
    contributed.set(uncalled.seat, (contributed.get(uncalled.seat) ?? 0) - uncalled.amount);
  }
  const totalPot = [...contributed.values()].reduce((sum, value) => sum + value, 0);
  const live = players.filter((player) => !player.folded);

  // Showdown hands, when there is a showdown to have.
  const showdown = state.status.kind === "complete" && state.status.ending === "showdown";
  const omaha = setup.variant !== "holdem";
  const hands = new Map<number, ShowdownHand>();
  if (showdown && board.length === 5) {
    for (const player of live) {
      const cards = cardsBySeat.get(player.seat) ?? [];
      if (cards.length !== HOLE_CARDS[setup.variant]) continue;
      const value = handValue(cards, board, omaha);
      hands.set(player.seat, { seat: player.seat, value, category: categoryOf(value) });
    }
  }

  // Layer the contributions into pots.
  const levels = [...new Set(live.map((player) => contributed.get(player.seat) ?? 0))]
    .filter((level) => level > 0)
    .sort((a, b) => a - b);
  const raw: Array<{ amount: Amount; eligible: number[] }> = [];
  let previous = 0;
  for (const level of levels) {
    let amount = 0;
    for (const value of contributed.values()) {
      amount += Math.max(0, Math.min(value, level) - previous);
    }
    const eligible = live
      .filter((player) => (contributed.get(player.seat) ?? 0) >= level)
      .map((player) => player.seat);
    const last = raw[raw.length - 1];
    if (last && last.eligible.length === eligible.length) {
      // Same players as the layer below: the same pot.
      last.amount += amount;
    } else {
      raw.push({ amount, eligible });
    }
    previous = level;
  }
  // Anything above the top live level (only folded money can be) joins the last pot.
  const layered = raw.reduce((sum, pot) => sum + pot.amount, 0);
  if (raw.length > 0 && layered < totalPot) {
    raw[raw.length - 1].amount += totalPot - layered;
  }
  if (raw.length === 0 && live.length > 0) {
    raw.push({ amount: totalPot, eligible: live.map((player) => player.seat) });
  }

  // Rake comes out of the main pot first.
  let rakeLeft = Math.max(0, Math.min(rake, totalPot));
  for (const pot of raw) {
    const take = Math.min(rakeLeft, pot.amount);
    pot.amount -= take;
    rakeLeft -= take;
  }

  const order = players.map((player) => player.seat);
  const pots: ManualPot[] = raw.map((pot, index) => {
    const name = raw.length === 1 ? "pot" : index === 0 ? "main pot" : `side pot-${index}`;
    const picked = picks[index]?.filter((seat) => pot.eligible.includes(seat));
    if (picked && picked.length > 0) {
      return { name, amount: pot.amount, eligible: pot.eligible, winners: sortSeats(picked, order), auto: false };
    }
    if (pot.eligible.length === 1) {
      return { name, amount: pot.amount, eligible: pot.eligible, winners: [...pot.eligible], auto: true };
    }
    const known = pot.eligible.every((seat) => hands.has(seat));
    if (showdown && known) {
      const best = Math.max(...pot.eligible.map((seat) => hands.get(seat)!.value));
      const winners = pot.eligible.filter((seat) => hands.get(seat)!.value === best);
      return { name, amount: pot.amount, eligible: pot.eligible, winners: sortSeats(winners, order), auto: true };
    }
    return { name, amount: pot.amount, eligible: pot.eligible, winners: [], auto: false };
  });

  const nameOf = new Map(players.map((player) => [player.seat, player.name]));
  const payouts: ManualPayout[] = [];
  for (const pot of pots) {
    if (pot.winners.length === 0 || pot.amount === 0) continue;
    const share = Math.floor(pot.amount / pot.winners.length);
    // The odd chip goes to the first winner left of the button.
    let odd = pot.amount - share * pot.winners.length;
    for (const seat of pot.winners) {
      const amount = share + (odd > 0 ? 1 : 0);
      odd = Math.max(0, odd - 1);
      payouts.push({ seat, name: nameOf.get(seat) ?? "", amount, potName: pot.name });
    }
  }

  const net = new Map<number, Amount>();
  for (const player of players) {
    const won = payouts.filter((payout) => payout.seat === player.seat).reduce((sum, p) => sum + p.amount, 0);
    net.set(player.seat, won - (contributed.get(player.seat) ?? 0));
  }

  return {
    uncalled,
    totalPot,
    rake: Math.max(0, Math.min(rake, totalPot)),
    pots,
    payouts,
    net,
    hands,
    resolved: state.status.kind === "complete" && pots.every((pot) => pot.winners.length > 0),
  };
}

function sortSeats(seats: number[], order: number[]): number[] {
  return [...seats].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
