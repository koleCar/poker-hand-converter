import type { Dict } from "../../lib/i18n/types";
import type { ReplayFrame, SeatFrameState } from "../../lib/replay";
import {
  formatAmount,
  toDisplayNumber,
  type Amount,
  type CurrencyUnit,
  type DecimalStyle,
  type PhfHand,
  type Position,
} from "../../lib/phf/types";

/** How stack, bet and pot numbers are rendered across the whole replayer. */
export type AmountUnit = "chips" | "bb";

/**
 * Formats one amount. `bb` is the canonical big-blind value that `buildReplay`
 * puts on the frame (`stackBb`, `betBb`, `potBb`, …); it is only omitted for
 * the handful of header figures that live outside the frames, where the ratio
 * is derived from the big blind instead.
 */
export type AmountFormatter = (money: number, bb?: number) => string;

function formatBigBlinds(bb: number): string {
  const rounded = Math.abs(bb) >= 100 ? Math.round(bb) : Math.round(bb * 10) / 10;
  return `${rounded}bb`;
}

/**
 * One formatter for stacks, bets and pots so switching the unit never leaves
 * half the table in currency.
 *
 * The money argument is in *display* units, which is what the replay frames
 * carry, but it is rendered through PHF's `formatAmount` rather than the old
 * `formatMoney`: that one printed `$1.2k` above a thousand, which silently
 * hides the last two digits of a tournament stack, and it prefixed chip games
 * with whatever string it was handed. Going back through the hand's own
 * `CurrencyUnit` keeps chip games symbol-free and prints every digit.
 */
export function createAmountFormatter(
  display: AmountUnit,
  unit: CurrencyUnit,
  bigBlind: Amount,
  /** The source's own decimal habit, so `$0.10` does not come back as `$0.1`. */
  decimals: DecimalStyle = "minimal",
): AmountFormatter {
  const bigBlindDisplay = toDisplayNumber(bigBlind, unit);
  if (display === "bb" && bigBlindDisplay > 0) {
    return (money, bb) => formatBigBlinds(bb ?? money / bigBlindDisplay);
  }
  // Frames are in display units; the rounding back to minor units is exact,
  // because that is where the number came from.
  return (money) => formatAmount(Math.round(money * unit.minorUnits), unit, decimals, true);
}

/**
 * The stack that actually matters preflop: hero against the deepest opponent,
 * or the second deepest stack at the table when there is no hero.
 *
 * Returned in **minor units**, like every other `Amount`, so callers format it
 * with `formatAmount` / `toBigBlinds` rather than re-deriving a float. Not part
 * of the frame contract — it is a property of the hand, not of a moment in it —
 * so it is computed here from the starting stacks. `ReplayViewer` renders it in
 * the header strip; it is not a spoiler, because it is knowable before a card
 * is dealt.
 */
export function effectiveStack(hand: PhfHand): Amount {
  const players = hand.players.filter((player) => !player.sittingOut);
  const seated = players.length >= 2 ? players : hand.players;
  if (seated.length < 2) {
    return seated[0]?.startingStack ?? 0;
  }
  const hero = seated.find((player) => player.isHero);
  if (hero) {
    const deepestOther = Math.max(
      ...seated.filter((player) => player !== hero).map((player) => player.startingStack),
    );
    return Math.min(hero.startingStack, deepestOther);
  }
  const sorted = seated.map((player) => player.startingStack).sort((a, b) => b - a);
  return sorted[1];
}

/* ---------------------------------------------------------- spoiler gate - */

/**
 * Frame index the pot is first paid out on, or -1 for a hand with no award
 * frame at all (a truncated history).
 */
export function firstAwardIndex(frames: ReplayFrame[]): number {
  const award = frames.find((frame) => frame.kind === "award");
  return award ? award.index : -1;
}

/**
 * **The spoiler rule.**
 *
 * Anything derived from `hand.results` — the total pot, the fee breakdown, who
 * won, how much, what they held, hero's net — is knowledge the replay has not
 * reached yet. Commit `fef6ff7` stripped that data out of the header one field
 * at a time; this is the same property stated once, as a function, so the next
 * panel that wants to show a rake figure has somewhere to ask.
 *
 * The gate is **frame position**, not which panel is open. The info sheet
 * opens happily from frame 0; its result rows render `—` until the replay
 * reaches the award. Anything on the frame itself (`seat.winAmount`,
 * `frame.potAward`, `frame.pots`) is already position-correct by construction
 * and needs no gate — `buildReplay` only puts it on the frames it belongs on.
 */
export function spoilersRevealed(frame: ReplayFrame, awardAt: number): boolean {
  return awardAt >= 0 && frame.index >= awardAt;
}

/**
 * Whether the showdown sheet has anything in it yet.
 *
 * Lives here rather than beside the sheet so the viewer can ask before it
 * decides to mount it — and so the sheet's module keeps exporting nothing but
 * a component.
 */
export function hasShowdownResult(hand: PhfHand, frame: ReplayFrame): boolean {
  if (frame.street !== "showdown") {
    return false;
  }
  const showdown = hand.results.wentToShowdown;
  return frame.seats.some((seat) =>
    showdown ? seat.cards !== null || seat.winAmount > 0 : seat.winAmount > 0,
  );
}

/* --------------------------------------------------------- spoken labels - */

/**
 * Position abbreviations read aloud. `CO` is spelled by a screen reader as
 * "see oh", which is not a poker seat.
 */
export function spokenPosition(position: Position | null, t: Dict["replayer"]): string | null {
  return position ? t.seat.positions[position] : null;
}

/** "84 big blinds", "1.5 big blinds", "1 big blind". */
export function spokenStack(bb: number, t: Dict["replayer"]): string {
  const rounded = Math.abs(bb) >= 100 ? Math.round(bb) : Math.round(bb * 10) / 10;
  return t.seat.stack(rounded);
}

/**
 * The composed label for one seat, e.g.
 * "Seat 3, cutoff, Villain, 84 big blinds, folded".
 *
 * Stacks are spoken in big blinds whatever the display unit is set to: it is
 * the unit the information actually lives in, it does not change when somebody
 * toggles the gear, and "eighty four b b" is what a screen reader would
 * otherwise make of the visible `84bb`.
 */
export function describeSeat(seat: SeatFrameState, displayName: string, t: Dict["replayer"]): string {
  const words = t.seat;
  const parts: string[] = [words.seat(seat.seatNo)];
  const position = spokenPosition(seat.position, t);
  if (position) {
    parts.push(position);
  }
  parts.push(displayName);
  if (seat.isHero) {
    parts.push(words.hero);
  }
  parts.push(spokenStack(seat.stackBb, t));
  if (seat.isButton) {
    parts.push(words.dealerButton);
  }
  if (seat.bet > 0) {
    parts.push(words.inFront(spokenStack(seat.betBb, t)));
  }
  if (seat.folded) {
    parts.push(words.folded);
  } else if (seat.allIn) {
    parts.push(words.allIn);
  }
  if (seat.isActing) {
    parts.push(words.toAct);
  }
  if (seat.winAmount > 0) {
    parts.push(words.winner);
  } else if (seat.lastAction) {
    parts.push(seat.lastAction);
  }
  return parts.join(", ");
}
