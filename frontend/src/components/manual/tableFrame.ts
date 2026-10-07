/**
 * The editor's hand-in-progress as one replayer frame, so the manual-entry
 * table is the replayer's own felt (`ReplayTable`) rather than a second
 * drawing of a poker table that would drift from the first.
 *
 * The frame is "now": stacks behind, this street's bets in front of the seats,
 * earlier streets swept into the middle, the acting seat lit, and each seat's
 * last action on this street as its pill. Once the hand is over the pot is
 * marked as won by whoever the settlement says won it.
 */

import type { EngineState, LoggedAction, ManualSettlement } from "../../lib/manual";
import type { CurrencyUnit } from "../../lib/phf/types";
import type { ActionTone, ReplayFrame, SeatFrameState } from "../../lib/replay";
import type { TableHand } from "../replayer/ReplayTable";
import type { EditorState } from "./editorState";

const TONE: Record<LoggedAction["kind"], ActionTone> = {
  ante: "post",
  "small-blind": "post",
  "big-blind": "post",
  straddle: "post",
  fold: "fold",
  check: "check",
  call: "call",
  bet: "aggressive",
  raise: "aggressive",
};

export function tableHand(state: EditorState, unit: CurrencyUnit): TableHand {
  return {
    game: {
      variant: state.variant === "holdem" ? "holdem" : state.variant === "omaha" ? "omaha" : "omaha5",
      bigBlind: state.bigBlind,
      unit,
    },
    // The editor shows every card it knows face up, so nothing is held back here.
    players: [],
  };
}

export function tableFrame(
  state: EditorState,
  engine: EngineState,
  settlement: ManualSettlement | null,
  unit: CurrencyUnit,
  pill: (entry: LoggedAction, amount: string) => string,
  format: (amount: number) => string,
): ReplayFrame {
  const display = (amount: number) => amount / unit.minorUnits;
  const bb = (amount: number) => (state.bigBlind > 0 ? amount / state.bigBlind : 0);
  const status = engine.status;
  const complete = status.kind === "complete";
  const acting = status.kind === "betting" ? status.options.seat : null;
  const cards = new Map(state.seats.map((seat) => [seat.seat, seat.cards]));

  const lastOnStreet = new Map<number, LoggedAction>();
  for (const entry of engine.log) {
    if (entry.street === engine.street && entry.kind !== "ante") lastOnStreet.set(entry.seat, entry);
  }

  const won = new Map<number, number>();
  if (complete && settlement?.resolved) {
    for (const payout of settlement.payouts) won.set(payout.seat, (won.get(payout.seat) ?? 0) + payout.amount);
  }
  // Once the hand is over the uncalled bet is back behind its owner.
  const returned = complete && settlement?.uncalled ? settlement.uncalled : null;

  const seats: SeatFrameState[] = engine.players.map((player) => {
    const last = lastOnStreet.get(player.seat);
    const bet = complete ? 0 : player.commit;
    const known = cards.get(player.seat) ?? [];
    const amount = last ? (last.kind === "bet" || last.kind === "raise" ? last.to : last.added) : 0;
    const win = won.get(player.seat) ?? 0;
    // The pot stays in the middle with the winners' pills on it, like the
    // replayer's award frame, so winnings are not added to the stack as well.
    const behind = player.stack + (returned?.seat === player.seat ? returned.amount : 0);
    return {
      seatNo: player.seat,
      name: player.name,
      isHero: player.hero,
      isButton: player.seat === state.buttonSeat,
      stack: display(behind),
      stackBb: bb(behind),
      bet: display(bet),
      betBb: bb(bet),
      position: player.position,
      folded: player.folded,
      allIn: player.allIn,
      cards: known.length > 0 ? known : null,
      hasCards: !player.folded,
      lastAction: complete || !last ? null : pill(last, format(amount)),
      lastActionTone: last ? (last.allIn && last.index !== null ? "allin" : TONE[last.kind]) : "neutral",
      isActing: player.seat === acting,
      winAmount: display(win),
    };
  });

  const outstanding = complete ? 0 : engine.players.reduce((sum, player) => sum + player.commit, 0);
  const pot = complete && settlement ? settlement.totalPot : engine.pot - outstanding;
  // English pile names, like the replay frames: the felt translates them.
  const pots =
    complete && settlement && settlement.pots.length > 1
      ? settlement.pots.map((entry, index) => ({
          name: index === 0 ? "Main pot" : `Side pot ${index}`,
          amount: display(entry.amount),
          amountBb: bb(entry.amount),
        }))
      : [{ name: "Pot", amount: display(pot), amountBb: bb(pot) }];

  const shown = complete && status.ending === "showdown" ? 5 : engine.boardReached;
  return {
    index: engine.log.length,
    kind: "action",
    street: engine.street,
    pot: display(pot),
    potWithBets: display(engine.pot),
    potBb: bb(pot),
    potWithBetsBb: bb(engine.pot),
    pots,
    potAward: null,
    board: state.board.slice(0, shown),
    boardSecond: [],
    seats,
    actingSeat: acting,
    actionIndex: null,
    allInAt: false,
    description: "",
    holdMs: 0,
  };
}
