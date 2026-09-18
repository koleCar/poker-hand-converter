import type { ParsedHand } from "../../lib/handParser";
import { formatMoney } from "../../lib/format";

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
 */
export function createAmountFormatter(
  unit: AmountUnit,
  currency: string,
  bigBlind: number,
): AmountFormatter {
  if (unit === "bb" && bigBlind > 0) {
    return (money, bb) => formatBigBlinds(bb ?? money / bigBlind);
  }
  return (money) => formatMoney(currency, money);
}

/**
 * The stack that actually matters preflop: hero against the deepest opponent,
 * or the second deepest stack at the table when there is no hero. Not part of
 * the frame contract, so it is computed here from the starting stacks.
 */
export function effectiveStack(hand: ParsedHand): number {
  const stacks = hand.seats.map((seat) => seat.stack);
  if (stacks.length < 2) {
    return stacks[0] ?? 0;
  }
  const hero = hand.seats.find((seat) => seat.isHero);
  if (hero) {
    const deepestOther = Math.max(
      ...hand.seats.filter((seat) => seat !== hero).map((seat) => seat.stack),
    );
    return Math.min(hero.stack, deepestOther);
  }
  const sorted = [...stacks].sort((a, b) => b - a);
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
