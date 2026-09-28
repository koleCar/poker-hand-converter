import type { ReplayFrame } from "../../lib/replay";
import {
  formatAmount,
  toDisplayNumber,
  type Amount,
  type CurrencyUnit,
  type DecimalStyle,
  type PhfHand,
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

export type ActionTone =
  | "fold"
  | "check"
  | "call"
  | "aggressive"
  | "allin"
  | "post"
  | "show"
  | "win"
  | "neutral";

/**
 * Colour/shape family for the little action pill under a seat. Derived from the
 * label text because that is all the frame carries.
 */
export function actionTone(label: string | null): ActionTone {
  if (!label) {
    return "neutral";
  }
  const text = label.toLowerCase();
  if (text.startsWith("+") || text.includes("wins")) return "win";
  if (text.includes("all-in")) return "allin";
  if (text.includes("fold")) return "fold";
  if (text.includes("check")) return "check";
  if (text.includes("call")) return "call";
  if (text.includes("bet") || text.includes("raise")) return "aggressive";
  if (text.includes("blind") || text.includes("ante") || text.includes("posts")) return "post";
  if (text.includes("show") || text.includes("muck")) return "show";
  return "neutral";
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
