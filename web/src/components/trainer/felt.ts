/**
 * The table at the hero's decision, as the Trainer draws it: every seat
 * (position, stack, what it has in front, folded or not), the board, the pot,
 * and the hand so far as a strip of actions. Pure: read off the replayer's
 * own frames (`lib/replay.ts`), so the trainer's table agrees with the
 * replayer about every stack and bet.
 */

import type { PhfHand } from "../../lib/phf/types";
import { primaryBoard, toBigBlinds } from "../../lib/phf/types";
import { buildReplay } from "../../lib/replay";

export interface FeltSeat {
  seatNo: number;
  position: string;
  stackBb: number;
  betBb: number;
  folded: boolean;
  hero: boolean;
  button: boolean;
  /** The seat whose action the hero answers (the last one to act), or the hero first to act. */
  acting: boolean;
}

export type StripItem =
  | { kind: "act"; position: string; action: "fold" | "check" | "call" | "bet" | "raise"; toBb: number; allIn: boolean; hero: boolean }
  | { kind: "street"; street: "flop" | "turn" | "river"; cards: string[]; potBb: number };

export interface Felt {
  seats: FeltSeat[];
  board: string[];
  /** In the middle, swept. */
  potBb: number;
  /** In the middle and in front of the players. */
  totalBb: number;
  strip: StripItem[];
}

const STREET_CARDS = { flop: 3, turn: 4, river: 5 } as const;
/** The cards a street turns over: the flop's three, the turn's and the river's one. */
const newCards = (board: readonly string[], street: "flop" | "turn" | "river") =>
  board.slice(street === "flop" ? 0 : STREET_CARDS[street] - 1, STREET_CARDS[street]);
const VOLUNTARY = new Set<string>(["fold", "check", "call", "bet", "raise"]);
const POSTS = new Set<string>(["small-blind", "big-blind", "straddle", "post"]);

/** `dealt`: the spot's board when the hand stops before its cards are turned (a first-to-act hero). */
export function feltOf(hand: PhfHand, dealt: readonly string[] = []): Felt {
  const frames = buildReplay(hand, { openOnDeal: true });
  const last = frames[frames.length - 1];
  const bigBlind = hand.game.bigBlind;
  const heroSeat = last.seats.find((seat) => seat.isHero)?.seatNo ?? null;
  // The last voluntary action before the hero's decision: whose move the hero answers.
  const lastActor = [...hand.actions].reverse().find((a) => VOLUNTARY.has(a.type) && a.type !== "fold");
  // The board as dealt to the decision: a first-to-act hero has no action on the street yet, so the
  // replay has not turned its cards over; the hand's own board has them.
  const own = primaryBoard(hand);
  const board = dealt.length > own.length ? [...dealt] : own;
  const strip: StripItem[] = [];
  let street = "preflop";
  for (const action of hand.actions) {
    if (!VOLUNTARY.has(action.type)) continue;
    if (action.street !== street && (action.street === "flop" || action.street === "turn" || action.street === "river")) {
      street = action.street;
      const at = frames.find((frame) => frame.kind === "street" && frame.street === action.street);
      strip.push({ kind: "street", street: action.street, cards: newCards(board, action.street), potBb: at?.potBb ?? 0 });
    }
    const seat = last.seats.find((s) => s.seatNo === action.seat);
    strip.push({
      kind: "act",
      position: seat?.position ?? action.player,
      action: action.type as "fold" | "check" | "call" | "bet" | "raise",
      toBb: toBigBlinds(action.streetTotal, bigBlind),
      allIn: action.allIn,
      hero: action.seat === heroSeat,
    });
  }
  // The street the hero decides on, when no one has acted on it yet (first to act on the flop).
  const boardStreet = board.length >= 5 ? "river" : board.length === 4 ? "turn" : board.length === 3 ? "flop" : null;
  if (boardStreet && boardStreet !== street) {
    strip.push({ kind: "street", street: boardStreet, cards: newCards(board, boardStreet), potBb: last.potWithBetsBb });
  }
  // What each seat has in front on the decision's street (the last frame may have swept it in already).
  const decisionStreet = boardStreet ?? "preflop";
  const front = new Map<number, number>();
  for (const action of hand.actions) {
    if (action.street !== decisionStreet || action.seat === null) continue;
    if (action.type === "fold" || action.type === "uncalled" || action.type === "ante") continue;
    if (POSTS.has(action.type) || VOLUNTARY.has(action.type)) front.set(action.seat, toBigBlinds(action.streetTotal, bigBlind));
  }
  const inFront = [...front.values()].reduce((sum, value) => sum + value, 0);
  return {
    seats: last.seats.map((seat) => ({
      seatNo: seat.seatNo,
      position: seat.position ?? seat.name,
      stackBb: seat.stackBb,
      betBb: front.get(seat.seatNo) ?? 0,
      folded: seat.folded,
      hero: seat.isHero,
      button: seat.isButton,
      acting: lastActor ? seat.seatNo === lastActor.seat && !seat.isHero : false,
    })),
    board,
    potBb: Math.max(0, Math.round((last.potWithBetsBb - inFront) * 10) / 10),
    totalBb: last.potWithBetsBb,
    strip,
  };
}

/**
 * Where seat `k` of `n` sits around an oval, the hero at the bottom centre:
 * percentages of the felt's box, clockwise from the hero.
 */
export function seatSpot(k: number, n: number): { left: number; top: number } {
  const angle = Math.PI / 2 + (2 * Math.PI * k) / n;
  return { left: 50 + 43 * Math.cos(angle), top: 50 + 37 * Math.sin(angle) };
}

/** The seats in drawing order: the hero first, then clockwise (the order of play after the hero). */
export function aroundHero(seats: readonly FeltSeat[]): FeltSeat[] {
  const sorted = [...seats].sort((a, b) => a.seatNo - b.seatNo);
  const hero = sorted.findIndex((seat) => seat.hero);
  if (hero <= 0) return sorted;
  return [...sorted.slice(hero), ...sorted.slice(0, hero)];
}
