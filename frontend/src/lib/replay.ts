import type { HandAction, ParsedHand, Street } from "./handParser";

export type FrameKind = "setup" | "post" | "deal" | "action" | "collect" | "street" | "showdown" | "award";

export interface SeatFrameState {
  seatNo: number;
  name: string;
  isHero: boolean;
  isButton: boolean;
  /** Chips left in front of the player. */
  stack: number;
  /** Chips committed on the current street, rendered as a bet stack. */
  bet: number;
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPost(action: HandAction): boolean {
  return (
    action.type === "ante" ||
    action.type === "small-blind" ||
    action.type === "big-blind" ||
    action.type === "straddle"
  );
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

function money(currency: string, amount: number): string {
  const text = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  return `${currency}${text}`;
}

/**
 * Turns a parsed hand into an ordered list of full table snapshots. Each frame
 * is self-contained so the UI can jump anywhere without replaying from zero.
 */
export function buildReplay(hand: ParsedHand): ReplayFrame[] {
  const frames: ReplayFrame[] = [];

  const state = new Map<
    string,
    {
      seatNo: number;
      isHero: boolean;
      isButton: boolean;
      stack: number;
      bet: number;
      folded: boolean;
      allIn: boolean;
      cards: string[];
      revealed: boolean;
      lastAction: string | null;
      winAmount: number;
    }
  >();

  for (const seat of hand.seats) {
    state.set(seat.name, {
      seatNo: seat.seatNo,
      isHero: seat.isHero,
      isButton: seat.isButton,
      stack: seat.stack,
      bet: 0,
      folded: false,
      allIn: false,
      cards: seat.cards,
      revealed: false,
      lastAction: null,
      winAmount: 0,
    });
  }

  let pot = 0;
  let cardsDealt = false;
  let currentStreet: Street = "preflop";
  let board: string[] = [];
  let boardSecond: string[] = [];

  function snapshot(
    kind: FrameKind,
    description: string,
    actingPlayer: string | null,
    options: { holdScale?: number } = {},
  ): void {
    const seats: SeatFrameState[] = hand.seats.map((seat) => {
      const entry = state.get(seat.name)!;
      const showCards = entry.revealed || (entry.isHero && cardsDealt);
      return {
        seatNo: seat.seatNo,
        name: seat.name,
        isHero: entry.isHero,
        isButton: entry.isButton,
        stack: round2(entry.stack),
        bet: round2(entry.bet),
        folded: entry.folded,
        allIn: entry.allIn,
        cards: showCards && entry.cards.length > 0 ? entry.cards : null,
        hasCards: cardsDealt && !entry.folded,
        lastAction: entry.lastAction,
        isActing: actingPlayer === seat.name,
        winAmount: entry.winAmount,
      };
    });

    const betTotal = seats.reduce((sum, seat) => sum + seat.bet, 0);

    frames.push({
      index: frames.length,
      kind,
      street: currentStreet,
      pot: round2(pot),
      potWithBets: round2(pot + betTotal),
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
        pot = round2(pot + entry.bet);
        entry.bet = 0;
        swept = true;
      }
    }
    return swept;
  }

  const tableLabel = hand.tableName ? `${hand.tableName} · ` : "";
  snapshot("setup", `${tableLabel}${hand.gameLabel}`, null);

  const postActions = hand.actions.filter(isPost);
  const playActions = hand.actions.filter((action) => !isPost(action));

  for (const action of postActions) {
    const entry = state.get(action.player);
    if (!entry) continue;
    entry.stack = round2(entry.stack - action.amount);
    entry.bet = round2(entry.bet + action.amount);
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

    // A new street: sweep the bets into the middle, then reveal the cards.
    if (
      action.street !== currentStreet &&
      action.street !== "showdown" &&
      ["flop", "turn", "river"].includes(action.street)
    ) {
      if (sweepBets()) {
        clearLastActions();
        snapshot("collect", "Chips to the pot", null);
      }
      currentStreet = action.street;
      board = boardSliceFor(action.street, hand.board);
      boardSecond = boardSliceFor(action.street, hand.boardSecond);
      clearLastActions();
      snapshot("street", `${action.street.toUpperCase()} ${board.join(" ")}`, null);
    }

    if (action.street === "showdown" && currentStreet !== "showdown") {
      // Streets can be skipped entirely when everyone is all-in; run the board
      // out one street at a time so the runout still animates.
      const remaining: Street[] = (["flop", "turn", "river"] as Street[]).filter(
        (candidate) => boardSliceFor(candidate, hand.board).length > board.length,
      );
      if (sweepBets()) {
        clearLastActions();
        snapshot("collect", "Chips to the pot", null);
      }
      for (const nextStreet of remaining) {
        currentStreet = nextStreet;
        board = boardSliceFor(nextStreet, hand.board);
        boardSecond = boardSliceFor(nextStreet, hand.boardSecond);
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
      case "raise": {
        entry.stack = round2(entry.stack - action.amount);
        entry.bet = round2(entry.bet + action.amount);
        if (action.allIn || entry.stack <= 0.001) {
          entry.allIn = true;
          entry.stack = Math.max(0, entry.stack);
        }
        entry.lastAction = action.allIn ? `${action.label} · all-in` : action.label;
        snapshot("action", `${action.player} ${entry.lastAction}`, action.player);
        break;
      }
      case "uncalled": {
        const returned = Math.abs(action.amount);
        entry.stack = round2(entry.stack + returned);
        entry.bet = round2(entry.bet - returned);
        entry.allIn = false;
        entry.lastAction = null;
        snapshot(
          "collect",
          `Uncalled ${money(hand.currency, returned)} returned to ${action.player}`,
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
      case "collect": {
        // Handled below so every pot award lands in a single frame.
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

  if (hand.winners.length > 0) {
    for (const winner of hand.winners) {
      const entry = state.get(winner.player);
      if (!entry) continue;
      entry.stack = round2(entry.stack + winner.amount);
      entry.winAmount = winner.amount;
      entry.lastAction = `+${money(hand.currency, winner.amount)}`;
    }
    pot = 0;
    const label = hand.winners
      .map((winner) => `${winner.player} wins ${money(hand.currency, winner.amount)}`)
      .join(" · ");
    snapshot("award", label, hand.winners[0]?.player ?? null);
  } else {
    snapshot("award", "Kraj ruke", null);
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
