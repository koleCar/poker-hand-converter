/**
 * PHF -> replay frames.
 *
 * Each frame is a complete, self-contained snapshot of the table so the UI can
 * scrub to any point without replaying from the start. The frame contract is
 * deliberately stable and only ever *gains* fields: `stackBb` / `betBb` /
 * `position` on a seat and `potBb` / `potWithBetsBb` came with the PHF rewrite,
 * and `pots` / `potAward` / `actionIndex` / `allInAt` came with the per-pot
 * award rebuild.
 *
 * Money in frames is in *display units* (dollars, or chips), not PHF minor
 * units, because every component formats it straight through the replayer's
 * amount formatter. The arithmetic behind those numbers is done entirely in
 * minor units so nothing here can drift.
 */

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

/**
 * One pile in the middle.
 *
 * An undivided pot is a single entry named `Pot`; once an all-in caps what a
 * player can win the middle splits into `Main`, `Side`, `Side 2`, ... The
 * entries always sum to the frame's `pot`, so the UI can draw one labelled pile
 * per entry and trust the total.
 */
export interface PotState {
  name: string;
  amount: number;
  amountBb: number;
}

/** The pot an `award` frame is paying out, and who it is paying. */
export interface PotAward {
  name: string;
  amount: number;
  winners: Array<{ seatNo: number; amount: number }>;
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
  /** Live side-pot breakdown; always at least one entry, and sums to `pot`. */
  pots: PotState[];
  /** Set on an `award` frame, null on every other kind. */
  potAward: PotAward | null;
  board: string[];
  boardSecond: string[];
  seats: SeatFrameState[];
  actingSeat: number | null;
  /**
   * `PhfAction.index` of the action this frame renders, or null for the frames
   * the dealer owns (setup, deal, street, the sweep into the middle).
   *
   * This is the anchor a deep link or a forum comment should point at, because
   * it is stable across serialization. **Never anchor on `index`**: frame
   * numbering is derived, and the per-pot award split already moved it once.
   */
  actionIndex: number | null;
  /**
   * The next thing that happens is an all-in runout: the betting is over, the
   * chips are in the middle and the board is about to be dealt out in one go.
   * The UI holds a beat here rather than flicking straight to the river.
   */
  allInAt: boolean;
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

/**
 * Dwell on a side pot being paid. Shorter than the first award: by then the
 * viewer has already read who won, and only the amount is new.
 */
const SIDE_POT_HOLD = 1100;

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
 * Comparison key for a pot name.
 *
 * The summary block names pots `Main` / `Side` while the collect lines say
 * `main pot` / `side pot`, and some rooms number them (`side pot-1`). Stripping
 * the noun and normalising the separators is what lets the two be matched.
 */
function potKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\bpots?\b/g, "")
    .replace(/[\s-]+/g, " ")
    .trim();
}

/** `"side pot-1"` -> `"Side 1"`, `"pot"` -> `"Pot"`. */
function potLabel(name: string | undefined): string {
  const key = potKey(name ?? "");
  if (!key) {
    return "Pot";
  }
  return key.replace(/(^|\s)\w/g, (match) => match.toUpperCase());
}

interface AwardGroup {
  name: string;
  /** First collect action that paid this pot, for the frame's anchor. */
  actionIndex: number | null;
  winners: Array<{ player: string; amount: Amount }>;
}

/**
 * Splits the hand's winners into one group per pot.
 *
 * `results.winners` is the authoritative money — it is one entry per collect,
 * already netted by the parser — but it does not say *which* pot each entry
 * came out of, so each winner is paired back to the collect action that
 * produced it and bucketed by that action's `potName`. Rooms that report no
 * breakdown at all collapse into a single unnamed pot, which is the shape the
 * replayer had before side pots were split out.
 */
function awardGroups(hand: PhfHand): AwardGroup[] {
  const collects = hand.actions.filter((action) => action.type === "collect");
  const claimed = new Set<number>();

  const buckets: AwardGroup[] = hand.results.pots.map((pot) => ({
    name: potLabel(pot.name),
    actionIndex: null,
    winners: [],
  }));
  const byKey = new Map<string, AwardGroup>();
  for (let i = 0; i < buckets.length; i += 1) {
    byKey.set(potKey(hand.results.pots[i].name), buckets[i]);
  }

  for (const winner of hand.results.winners) {
    // Pair by player and amount rather than by position: a parser is free to
    // order its summary differently from its action stream.
    let source: PhfAction | null = null;
    for (let i = 0; i < collects.length; i += 1) {
      if (claimed.has(i)) continue;
      if (collects[i].player === winner.player && collects[i].amount === winner.amount) {
        claimed.add(i);
        source = collects[i];
        break;
      }
    }

    const key = potKey(source?.potName ?? "");
    let bucket = byKey.get(key);
    if (!bucket && key && buckets.length === 0) {
      // No summary breakdown, but the collect lines name their pots.
      bucket = { name: potLabel(source?.potName), actionIndex: null, winners: [] };
      buckets.push(bucket);
      byKey.set(key, bucket);
    }
    if (!bucket && !key) {
      // A plain "from pot": the main pot when there is a breakdown, the only
      // pot when there is not.
      bucket = buckets[0];
      if (!bucket) {
        bucket = { name: "Pot", actionIndex: null, winners: [] };
        buckets.push(bucket);
        byKey.set(key, bucket);
      }
    }
    if (!bucket) {
      // Named a pot the summary did not list. Give it its own pile rather than
      // folding it into the main pot, which would misreport both.
      bucket = { name: potLabel(source?.potName), actionIndex: null, winners: [] };
      buckets.push(bucket);
      byKey.set(key, bucket);
    }

    bucket.winners.push({ player: winner.player, amount: winner.amount });
    if (bucket.actionIndex === null && source) {
      bucket.actionIndex = source.index;
    }
  }

  return buckets.filter((bucket) => bucket.winners.length > 0);
}

/**
 * Turns a hand into an ordered list of full table snapshots.
 */
export function buildReplay(hand: PhfHand): ReplayFrame[] {
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
  const outOfPot = new Map<number, Amount>();
  for (const movement of hand.chipMovements ?? []) {
    if (!movement.toPot && movement.fromSeat !== null) {
      outOfPot.set(
        movement.fromSeat,
        (outOfPot.get(movement.fromSeat) ?? 0) + movement.amount,
      );
    }
  }

  for (const player of seatOrder) {
    state.set(player.name, {
      seatNo: player.seat,
      isHero: player.isHero,
      isButton: hand.table.buttonSeat === player.seat,
      position: player.position,
      stack: player.startingStack - (outOfPot.get(player.seat) ?? 0),
      bet: 0,
      folded: false,
      allIn: false,
      cards: player.holeCards,
      revealed: false,
      lastAction: null,
      winAmount: 0,
    });
  }

  // Promotional chips the house dropped in are already in the middle before a
  // single bet is made; jackpot drops are taken off a stack and never arrive.
  const housePot: Amount = (hand.chipMovements ?? [])
    .filter((movement) => movement.toPot)
    .reduce((sum, movement) => sum + movement.amount, 0);
  let pot: Amount = housePot;
  /** What each player has actually swept into the middle, for the side-pot split. */
  const potContribution = new Map<string, Amount>();
  /**
   * Set while the awards are being paid out, when the piles left in the middle
   * are the pots still owed rather than a live split of the contributions.
   */
  let potsOverride: Array<{ name: string; amount: Amount }> | null = null;
  let cardsDealt = false;
  let currentStreet: Street = "preflop";
  let board: string[] = [];
  let boardSecond: string[] = [];

  const fullBoard = primaryBoard(hand);
  const fullBoardSecond = secondBoard(hand);

  /**
   * How the chips already in the middle divide into a main pot and side pots.
   *
   * Every live player who is all-in caps what they can win at what they have
   * put in, and each distinct cap opens a pot above it that only the deeper
   * players contest. Chips from players who folded, and anything the house
   * dropped in, sit in the bottom layer, which is where they are claimable
   * from. The layers always add back up to `pot`.
   */
  function livePots(): Array<{ name: string; amount: Amount }> {
    const caps: Amount[] = [];
    let deepestLive: Amount = 0;
    for (const [name, entry] of state) {
      if (entry.folded) continue;
      const contributed = potContribution.get(name) ?? 0;
      deepestLive = Math.max(deepestLive, contributed);
      if (entry.allIn && contributed > 0) {
        caps.push(contributed);
      }
    }

    const bounds = [...new Set(caps)]
      .filter((cap) => cap < deepestLive)
      .sort((a, b) => a - b);

    const layers: Amount[] = [];
    let floor: Amount = 0;
    for (const ceiling of [...bounds, Number.POSITIVE_INFINITY]) {
      let amount: Amount = 0;
      for (const contributed of potContribution.values()) {
        amount += Math.max(0, Math.min(contributed, ceiling) - floor);
      }
      layers.push(amount);
      floor = ceiling;
    }
    layers[0] += housePot;

    const live = layers.filter((amount, index) => amount > 0 || index === 0);
    if (live.length <= 1) {
      return [{ name: "Pot", amount: live[0] ?? 0 }];
    }
    return live.map((amount, index) => ({
      name: index === 0 ? "Main" : index === 1 ? "Side" : `Side ${index}`,
      amount,
    }));
  }

  function snapshot(
    kind: FrameKind,
    description: string,
    actingPlayer: string | null,
    options: {
      holdScale?: number;
      holdMs?: number;
      actionIndex?: number | null;
      potAward?: PotAward | null;
    } = {},
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

    const piles = potsOverride ?? livePots();

    frames.push({
      index: frames.length,
      kind,
      street: currentStreet,
      pot: display(pot),
      potWithBets: display(pot + betTotal),
      potBb: toBigBlinds(pot, bigBlind),
      potWithBetsBb: toBigBlinds(pot + betTotal, bigBlind),
      pots: piles.map((pile) => ({
        name: pile.name,
        amount: display(pile.amount),
        amountBb: toBigBlinds(pile.amount, bigBlind),
      })),
      potAward: options.potAward ?? null,
      board: [...board],
      boardSecond: [...boardSecond],
      seats,
      actingSeat: actingPlayer ? (state.get(actingPlayer)?.seatNo ?? null) : null,
      actionIndex: options.actionIndex ?? null,
      allInAt: false,
      description,
      holdMs: options.holdMs ?? Math.round(BASE_HOLD[kind] * (options.holdScale ?? 1)),
    });
  }

  /**
   * Marks the frame that is already on screen as the beat before an all-in
   * runout. Called once the betting has been swept and the remaining streets
   * are known, which is the last moment at which the table is still "before"
   * the board goes out.
   */
  function markAllInBeat(): void {
    const last = frames[frames.length - 1];
    if (last) {
      last.allInAt = true;
    }
  }

  function clearLastActions(): void {
    for (const entry of state.values()) {
      entry.lastAction = null;
    }
  }

  function sweepBets(): boolean {
    let swept = false;
    for (const [name, entry] of state) {
      if (entry.bet > 0) {
        pot += entry.bet;
        potContribution.set(name, (potContribution.get(name) ?? 0) + entry.bet);
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
    snapshot("post", `${action.player} ${action.label}`, action.player, {
      actionIndex: action.index,
    });
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
      // Everyone is committed and the rest of the board is about to arrive in
      // one go. The frame on screen right now is the last one before it.
      if (remaining.length > 0) {
        markAllInBeat();
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
        snapshot("action", `${action.player} folds`, action.player, {
          actionIndex: action.index,
        });
        break;
      }
      case "check": {
        entry.lastAction = "check";
        snapshot("action", `${action.player} checks`, action.player, {
          actionIndex: action.index,
        });
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
        snapshot("action", `${action.player} ${entry.lastAction}`, action.player, {
          actionIndex: action.index,
        });
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
          { actionIndex: action.index },
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
          { actionIndex: action.index },
        );
        break;
      }
      case "muck": {
        entry.lastAction = "mucks";
        snapshot("showdown", `${action.player} mucks`, action.player, {
          actionIndex: action.index,
        });
        break;
      }
      case "collect":
      case "cashout-choose":
      case "cashout-pay": {
        // Awards are replayed pot by pot below; cashouts settle outside the pot.
        break;
      }
      default:
        break;
    }
  }

  // Awards: one frame per pot, main first, so a side pot is paid as its own
  // beat instead of every winner's stack jumping from dead centre at once.
  sweepBets();
  clearLastActions();
  currentStreet = "showdown";

  const groups = awardGroups(hand);
  if (groups.length > 0) {
    const owed = groups.map((group) =>
      group.winners.reduce((sum, winner) => sum + winner.amount, 0),
    );

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const paid: Array<{ seatNo: number; amount: number }> = [];
      for (const winner of group.winners) {
        const entry = state.get(winner.player);
        if (!entry) continue;
        entry.stack += winner.amount;
        entry.winAmount += winner.amount;
        entry.lastAction = `+${formatAmount(entry.winAmount, unit)}`;
        paid.push({ seatNo: entry.seatNo, amount: display(winner.amount) });
      }

      // What is left in the middle is exactly what is still owed: the fees
      // come off the pot as it is pushed, so they leave with the pot they were
      // taken from rather than lingering as an unpayable remainder.
      const remaining = groups.slice(index + 1).map((rest, offset) => ({
        name: rest.name,
        amount: owed[index + 1 + offset],
      }));
      pot = remaining.reduce((sum, rest) => sum + rest.amount, 0);
      potsOverride = remaining.length > 0 ? remaining : [{ name: "Pot", amount: 0 }];

      const names = group.winners
        .map((winner) => `${winner.player} wins ${formatAmount(winner.amount, unit)}`)
        .join(" · ");
      snapshot(
        "award",
        groups.length > 1 ? `${group.name} pot — ${names}` : names,
        group.winners[0]?.player ?? null,
        {
          holdMs: index === 0 ? BASE_HOLD.award : SIDE_POT_HOLD,
          actionIndex: group.actionIndex,
          potAward: { name: group.name, amount: display(owed[index]), winners: paid },
        },
      );
    }
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
