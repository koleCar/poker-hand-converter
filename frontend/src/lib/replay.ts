/**
 * PHF -> replay frames.
 *
 * Each frame is a complete, self-contained snapshot of the table so the UI can
 * scrub to any point without replaying from the start. The frame contract is
 * deliberately stable: the only additions in the PHF rewrite are `stackBb` /
 * `betBb` / `position` on a seat and `potBb` / `potWithBetsBb` on a frame.
 *
 * Money in frames is in *display units* (dollars, or chips), not PHF minor
 * units, because every component formats it straight through `formatMoney`.
 */

import type { ParsedHand } from "./handParser";
import {
  isPostingAction,
  formatAmount,
  primaryBoard,
  secondBoard,
  toBigBlinds,
  toDisplayNumber,
  type Amount,
  type PhfAction,
  type PhfHand,
  type Position,
  type Street,
} from "./phf/types";

export type FrameKind =
  | "setup"
  | "post"
  | "deal"
  | "action"
  | "collect"
  | "street"
  | "showdown"
  | "award";

export interface SeatFrameState {
  seatNo: number;
  name: string;
  isHero: boolean;
  isButton: boolean;
  /** Chips left in front of the player. */
  stack: number;
  /** The same stack expressed in big blinds; the replayer shows both. */
  stackBb: number;
  /** Chips committed on the current street, rendered as a bet stack. */
  bet: number;
  /** The current street commitment in big blinds. */
  betBb: number;
  /** Resolved table position (BTN/SB/BB/UTG/...), or null without a button. */
  position: Position | null;
  folded: boolean;
  allIn: boolean;
  /** Face-up cards, or null while the hand is face down / mucked. */
  cards: string[] | null;
  hasCards: boolean;
  lastAction: string | null;
  isActing: boolean;
  winAmount: number;
}

export interface ReplayFrame {
  index: number;
  kind: FrameKind;
  street: Street;
  /** Chips already swept into the middle. */
  pot: number;
  /** Pot plus everything still sitting in front of players. */
  potWithBets: number;
  /** Pot in big blinds. */
  potBb: number;
  /** Pot plus outstanding bets, in big blinds. */
  potWithBetsBb: number;
  board: string[];
  boardSecond: string[];
  seats: SeatFrameState[];
  actingSeat: number | null;
  description: string;
  /** Suggested autoplay dwell time in ms at 1x speed. */
  holdMs: number;
}

const BASE_HOLD: Record<FrameKind, number> = {
  setup: 500,
  post: 320,
  deal: 700,
  action: 850,
  collect: 500,
  street: 900,
  showdown: 900,
  award: 1600,
};

/** Accepts PHF directly, or the legacy `ParsedHand` wrapper around it. */
export type ReplaySource = PhfHand | ParsedHand;

function toPhf(hand: ReplaySource): PhfHand {
  return "schema" in hand ? hand : hand.phf;
}

function boardSliceFor(street: Street, board: string[]): string[] {
  switch (street) {
    case "flop":
      return board.slice(0, 3);
    case "turn":
      return board.slice(0, 4);
    case "river":
    case "showdown":
      return board.slice(0, 5);
    default:
      return [];
  }
}

/** Show / muck / collect end the betting and trigger the runout animation. */
function isShowdownAction(action: PhfAction): boolean {
  return (
    action.type === "show" ||
    action.type === "muck" ||
    action.type === "collect" ||
    action.street === "showdown"
  );
}

/**
 * Turns a hand into an ordered list of full table snapshots.
 */
export function buildReplay(source: ReplaySource): ReplayFrame[] {
  const hand = toPhf(source);
  const unit = hand.game.unit;
  const bigBlind = hand.game.bigBlind;
  const frames: ReplayFrame[] = [];
  const display = (amount: Amount) => toDisplayNumber(amount, unit);

  const state = new Map<
    string,
    {
      seatNo: number;
      isHero: boolean;
      isButton: boolean;
      position: Position | null;
      stack: Amount;
      bet: Amount;
      folded: boolean;
      allIn: boolean;
      cards: string[];
      revealed: boolean;
      lastAction: string | null;
      winAmount: Amount;
    }
  >();

  const seatOrder = [...hand.players].sort((a, b) => a.seat - b.seat);
  for (const player of seatOrder) {
    state.set(player.name, {
      seatNo: player.seat,
      isHero: player.isHero,
      isButton: hand.table.buttonSeat === player.seat,
      position: player.position,
      stack: player.startingStack,
      bet: 0,
      folded: false,
      allIn: false,
      cards: player.holeCards,
      revealed: false,
      lastAction: null,
      winAmount: 0,
    });
  }

  let pot: Amount = 0;
  let cardsDealt = false;
  let currentStreet: Street = "preflop";
  let board: string[] = [];
  let boardSecond: string[] = [];

  const fullBoard = primaryBoard(hand);
  const fullBoardSecond = secondBoard(hand);

  function snapshot(
    kind: FrameKind,
    description: string,
    actingPlayer: string | null,
    options: { holdScale?: number } = {},
  ): void {
    const seats: SeatFrameState[] = seatOrder.map((player) => {
      const entry = state.get(player.name)!;
      const showCards = entry.revealed || (entry.isHero && cardsDealt);
      return {
        seatNo: player.seat,
        name: player.name,
        isHero: entry.isHero,
        isButton: entry.isButton,
        stack: display(entry.stack),
        stackBb: toBigBlinds(entry.stack, bigBlind),
        bet: display(entry.bet),
        betBb: toBigBlinds(entry.bet, bigBlind),
        position: entry.position,
        folded: entry.folded,
        allIn: entry.allIn,
        cards: showCards && entry.cards.length > 0 ? entry.cards : null,
        hasCards: cardsDealt && !entry.folded,
        lastAction: entry.lastAction,
        isActing: actingPlayer === player.name,
        winAmount: display(entry.winAmount),
      };
    });

    let betTotal: Amount = 0;
    for (const entry of state.values()) {
      betTotal += entry.bet;
    }

    frames.push({
      index: frames.length,
      kind,
      street: currentStreet,
      pot: display(pot),
      potWithBets: display(pot + betTotal),
      potBb: toBigBlinds(pot, bigBlind),
      potWithBetsBb: toBigBlinds(pot + betTotal, bigBlind),
      board: [...board],
      boardSecond: [...boardSecond],
      seats,
      actingSeat: actingPlayer ? (state.get(actingPlayer)?.seatNo ?? null) : null,
      description,
      holdMs: Math.round(BASE_HOLD[kind] * (options.holdScale ?? 1)),
    });
  }

  function clearLastActions(): void {
    for (const entry of state.values()) {
      entry.lastAction = null;
    }
  }

  function sweepBets(): boolean {
    let swept = false;
    for (const entry of state.values()) {
      if (entry.bet > 0) {
        pot += entry.bet;
        entry.bet = 0;
        swept = true;
      }
    }
    return swept;
  }

  const tableLabel = hand.table.name ? `${hand.table.name} · ` : "";
  snapshot("setup", `${tableLabel}${hand.game.label}`, null);

  const postActions = hand.actions.filter((action) => isPostingAction(action.type));
  const playActions = hand.actions.filter((action) => !isPostingAction(action.type));

  for (const action of postActions) {
    const entry = state.get(action.player);
    if (!entry) continue;
    entry.stack -= action.amount;
    entry.bet += action.amount;
    entry.lastAction = action.label;
    if (action.allIn || entry.stack <= 0) {
      entry.allIn = true;
      entry.stack = Math.max(0, entry.stack);
    }
    snapshot("post", `${action.player} ${action.label}`, action.player);
  }

  cardsDealt = true;
  clearLastActions();
  snapshot("deal", "Hole cards dealt", null);

  for (const action of playActions) {
    const entry = state.get(action.player);
    const showdownish = isShowdownAction(action);

    // A new street: sweep the bets into the middle, then reveal the cards.
    if (
      !showdownish &&
      action.street !== currentStreet &&
      (action.street === "flop" || action.street === "turn" || action.street === "river")
    ) {
      if (sweepBets()) {
        clearLastActions();
        snapshot("collect", "Chips to the pot", null);
      }
      currentStreet = action.street;
      board = boardSliceFor(action.street, fullBoard);
      boardSecond = boardSliceFor(action.street, fullBoardSecond);
      clearLastActions();
      snapshot("street", `${action.street.toUpperCase()} ${board.join(" ")}`, null);
    }

    if (showdownish && currentStreet !== "showdown") {
      // Streets can be skipped entirely when everyone is all-in; run the board
      // out one street at a time so the runout still animates.
      const remaining: Street[] = (["flop", "turn", "river"] as Street[]).filter(
        (candidate) => boardSliceFor(candidate, fullBoard).length > board.length,
      );
      if (sweepBets()) {
        clearLastActions();
        snapshot("collect", "Chips to the pot", null);
      }
      for (const nextStreet of remaining) {
        currentStreet = nextStreet;
        board = boardSliceFor(nextStreet, fullBoard);
        boardSecond = boardSliceFor(nextStreet, fullBoardSecond);
        snapshot("street", `${nextStreet.toUpperCase()} ${board.join(" ")}`, null);
      }
      currentStreet = "showdown";
    }

    if (!entry) {
      continue;
    }

    switch (action.type) {
      case "fold": {
        entry.folded = true;
        entry.lastAction = "fold";
        snapshot("action", `${action.player} folds`, action.player);
        break;
      }
      case "check": {
        entry.lastAction = "check";
        snapshot("action", `${action.player} checks`, action.player);
        break;
      }
      case "call":
      case "bet":
      case "raise":
      case "post":
      case "straddle": {
        entry.stack -= action.amount;
        entry.bet += action.amount;
        if (action.allIn || entry.stack <= 0) {
          entry.allIn = true;
          entry.stack = Math.max(0, entry.stack);
        }
        entry.lastAction = action.allIn ? `${action.label} · all-in` : action.label;
        snapshot("action", `${action.player} ${entry.lastAction}`, action.player);
        break;
      }
      case "uncalled": {
        const returned = Math.abs(action.amount);
        entry.stack += returned;
        entry.bet -= returned;
        entry.allIn = false;
        entry.lastAction = null;
        snapshot(
          "collect",
          `Uncalled ${formatAmount(returned, unit)} returned to ${action.player}`,
          null,
        );
        break;
      }
      case "show": {
        entry.revealed = true;
        if (action.cards?.length) {
          entry.cards = action.cards;
        }
        entry.lastAction = action.description ?? "shows";
        currentStreet = "showdown";
        snapshot(
          "showdown",
          `${action.player} shows ${entry.cards.join(" ")}${
            action.description ? ` (${action.description})` : ""
          }`,
          action.player,
        );
        break;
      }
      case "muck": {
        entry.lastAction = "mucks";
        snapshot("showdown", `${action.player} mucks`, action.player);
        break;
      }
      case "collect":
      case "cashout-choose":
      case "cashout-pay": {
        // Awards land in a single final frame; cashouts settle outside the pot.
        break;
      }
      default:
        break;
    }
  }

  // Final award frame.
  sweepBets();
  clearLastActions();
  currentStreet = "showdown";

  const winners = hand.results.winners;
  if (winners.length > 0) {
    for (const winner of winners) {
      const entry = state.get(winner.player);
      if (!entry) continue;
      entry.stack += winner.amount;
      entry.winAmount += winner.amount;
      entry.lastAction = `+${formatAmount(entry.winAmount, unit)}`;
    }
    pot = 0;
    const label = winners
      .map((winner) => `${winner.player} wins ${formatAmount(winner.amount, unit)}`)
      .join(" · ");
    snapshot("award", label, winners[0]?.player ?? null);
  } else {
    snapshot("award", "End of hand", null);
  }

  return frames;
}

/** Index of the first frame belonging to each street, for the street jump bar. */
export function streetAnchors(frames: ReplayFrame[]): Array<{ street: Street; index: number }> {
  const anchors: Array<{ street: Street; index: number }> = [];
  const seen = new Set<Street>();
  for (const frame of frames) {
    if (!seen.has(frame.street)) {
      seen.add(frame.street);
      anchors.push({ street: frame.street, index: frame.index });
    }
  }
  return anchors;
}
