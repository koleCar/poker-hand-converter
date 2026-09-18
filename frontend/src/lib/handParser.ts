/**
 * Legacy `ParsedHand` facade over PHF.
 *
 * PHF (`lib/phf/types.ts`) is the canonical representation now. This module
 * stays because `handStore.ts` and the replayer components are owned elsewhere
 * and still speak `ParsedHand`; it is a thin, lossless adapter, not a second
 * parser. Every value here is derived from the `PhfHand` hanging off
 * `ParsedHand.phf`, which new code should use directly.
 *
 * The integrator can delete this file once the components move to PHF.
 */

import { handClass } from "./cards";
import {
  parseStandardHand,
  splitStandardHands,
  toStandardText,
} from "./phf/serialize";
import {
  primaryBoard,
  secondBoard,
  toDisplayNumber,
  type PhfHand,
  type Street,
} from "./phf/types";

export type { Street };

export const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river", "showdown"];

export type ActionType =
  | "ante"
  | "small-blind"
  | "big-blind"
  | "straddle"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "uncalled"
  | "show"
  | "muck"
  | "collect";

export interface HandSeat {
  seatNo: number;
  name: string;
  stack: number;
  isHero: boolean;
  isButton: boolean;
  /** Hole cards when known (dealt to hero, or shown at showdown). */
  cards: string[];
  /** Filled from the SUMMARY block, e.g. "(small blind)". */
  positionLabel: string | null;
}

export interface HandAction {
  index: number;
  street: Street;
  player: string;
  type: ActionType;
  /** Chips this action moves into the pot (negative for an uncalled return). */
  amount: number;
  /** For bet/raise: the total street commitment the player is now at. */
  toAmount?: number;
  allIn: boolean;
  cards?: string[];
  /** Showdown hand description, e.g. "a pair of Aces". */
  description?: string;
  /** Human readable action label used by the replayer. */
  label: string;
  rawLine: string;
}

export interface ParsedHand {
  handId: string;
  handKey: string;
  gameLabel: string;
  gameType: "cash" | "tournament";
  currency: string;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  playedAt: string | null;
  tableName: string | null;
  maxSeats: number;
  buttonSeat: number | null;
  seats: HandSeat[];
  heroName: string | null;
  actions: HandAction[];
  /** Primary runout, up to five cards. */
  board: string[];
  /** Second runout when the hand was run twice. */
  boardSecond: string[];
  totalPot: number;
  rake: number;
  winners: Array<{ player: string; amount: number }>;
  /** Total chips each player put in, net of uncalled returns. */
  invested: Record<string, number>;
  /** GG "EV Cashout" entries; settled outside the pot. */
  cashouts: Array<{ player: string; risk: number }>;
  heroProfit: number | null;
  streetReached: Street;
  wentToShowdown: boolean;
  summaryLines: string[];
  /** Standard-format text for this hand; this is what gets stored and re-parsed. */
  rawText: string;
  warnings: string[];
  /** The canonical hand. New code should read this instead of the fields above. */
  phf: PhfHand;
}

/** Maps a PHF action type onto the narrower legacy vocabulary. */
function legacyActionType(type: string): ActionType {
  switch (type) {
    case "missed-blind":
    case "bomb-ante":
      return "ante";
    case "post":
      return "straddle";
    case "cashout-choose":
    case "cashout-pay":
      return "collect";
    default:
      return type as ActionType;
  }
}

/** Wraps a PHF hand in the legacy shape the components still consume. */
export function toParsedHand(hand: PhfHand): ParsedHand {
  const unit = hand.game.unit;
  const money = (amount: number) => toDisplayNumber(amount, unit);

  const seats: HandSeat[] = [...hand.players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => {
      const result = hand.results.players.find((entry) => entry.seat === player.seat);
      return {
        seatNo: player.seat,
        name: player.name,
        stack: money(player.startingStack),
        isHero: player.isHero,
        isButton: hand.table.buttonSeat === player.seat,
        cards: player.holeCards,
        positionLabel: result?.positionLabels[0] ?? null,
      };
    });

  const actions: HandAction[] = hand.actions.map((action, index) => ({
    index,
    // The old shape reported every reveal and award as "showdown"; the replayer
    // still keys its runout animation off that.
    street:
      action.type === "show" || action.type === "muck" || action.type === "collect"
        ? "showdown"
        : action.street,
    player: action.player,
    type: legacyActionType(action.type),
    amount: money(action.amount),
    toAmount: action.streetTotal ? money(action.streetTotal) : undefined,
    allIn: action.allIn,
    cards: action.cards,
    description: action.description,
    label: action.label,
    rawLine: action.rawLine,
  }));

  const invested: Record<string, number> = {};
  for (const result of hand.results.players) {
    if (result.contributed !== 0) {
      invested[result.player] = money(result.contributed);
    }
  }

  const winners = hand.results.winners.map((winner) => ({
    player: winner.player,
    amount: money(winner.amount),
  }));
  // Legacy callers expect one entry per player, not one per pot.
  const mergedWinners: Array<{ player: string; amount: number }> = [];
  for (const winner of winners) {
    const existing = mergedWinners.find((entry) => entry.player === winner.player);
    if (existing) {
      existing.amount = Math.round((existing.amount + winner.amount) * 100) / 100;
    } else {
      mergedWinners.push({ ...winner });
    }
  }

  const cashouts = hand.actions
    .filter((action) => action.type === "cashout-pay")
    .map((action) => ({
      player: action.player,
      risk: money(
        Number((action.description ?? "").replace(/[^\d.]/g, "")) * unit.minorUnits || 0,
      ),
    }));

  const summaryLines: string[] = [];
  for (const result of hand.results.players) {
    if (result.raw) {
      summaryLines.push(result.raw.trim());
    }
  }

  return {
    handId: hand.meta.handId,
    handKey: hand.meta.handKey,
    gameLabel: hand.game.label,
    gameType: hand.game.format === "cash" ? "cash" : "tournament",
    currency: unit.symbol,
    smallBlind: money(hand.game.smallBlind),
    bigBlind: money(hand.game.bigBlind),
    ante: money(hand.game.ante),
    playedAt: hand.playedAt,
    tableName: hand.table.name,
    maxSeats: hand.table.maxSeats,
    buttonSeat: hand.table.buttonSeat,
    seats,
    heroName: hand.players.find((player) => player.isHero)?.name ?? null,
    actions,
    board: primaryBoard(hand),
    boardSecond: secondBoard(hand),
    totalPot: money(hand.results.totalPot),
    rake: money(hand.results.fees.rake),
    winners: mergedWinners,
    invested,
    cashouts,
    heroProfit: hand.results.heroNet === null ? null : money(hand.results.heroNet),
    streetReached: hand.results.streetReached,
    wentToShowdown: hand.results.wentToShowdown,
    summaryLines,
    rawText: toStandardText(hand),
    warnings: hand.meta.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    phf: hand,
  };
}

/** Splits a multi-hand file into individual hand chunks. */
export function splitHands(text: string): string[] {
  return splitStandardHands(text);
}

export function looksLikeHandHistory(text: string): boolean {
  return splitHands(text).length > 0;
}

export function isGgFormat(text: string): boolean {
  return /^Poker\s+Hand\s+#/im.test(text);
}

export function isWeplayFormat(text: string): boolean {
  return /^﻿?Weplay\s+Hand\s+#/im.test(text);
}

/** Parses one standard-format hand chunk. Returns null for anything else. */
export function parseHand(text: string): ParsedHand | null {
  const hand = parseStandardHand(text, {
    siteId: "standard",
    siteName: "PokerConverter standard",
    originalFilename: null,
  });
  return hand ? toParsedHand(hand) : null;
}

export function heroHandClass(hand: ParsedHand): string | null {
  const hero = hand.seats.find((seat) => seat.isHero);
  return hero ? handClass(hero.cards) : null;
}

export function heroCards(hand: ParsedHand): string[] {
  return hand.seats.find((seat) => seat.isHero)?.cards ?? [];
}
