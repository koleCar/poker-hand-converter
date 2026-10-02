/**
 * Facts about the hand that do not change as you scrub.
 *
 * By the IA rule in #19 these are Tier 1/2 material: the header keeps the
 * three that orient you (where, for how much, which game) and everything else
 * lives one tap away in the info sheet. Both read the strings from here so the
 * two can never disagree about what "NL Hold'em" is called.
 *
 * None of it is a spoiler. Every value below is knowable before a card is
 * dealt, which is exactly why it is allowed in the chrome at all — see
 * `spoilersRevealed` in `tableMath.ts` for the things that are not.
 */

import type { Dict } from "../../lib/i18n/types";
import { formatAmount, isButtonBlind, type LimitType, type PhfHand } from "../../lib/phf/types";

/** Abbreviations, the same in every language. */
const LIMIT_LABEL: Record<LimitType, string> = { nl: "NL", pl: "PL", fl: "FL" };

/** `"NL Hold’em"`, or the source's own label when the variant is unrecognised. */
export function gameLabel(hand: PhfHand, t: Dict["replayer"]): string {
  // `other` has no name of ours; the source's label is the best there is.
  const variant = hand.game.variant === "other" ? null : t.facts.variants[hand.game.variant];
  return variant ? `${LIMIT_LABEL[hand.game.limit]} ${variant}` : hand.game.label;
}

function money(hand: PhfHand, amount: number): string {
  return formatAmount(amount, hand.game.unit, hand.meta.textStyle.decimals);
}

/** `"$0.25/$0.50"`, or the one stake of an ante-only short-deck table. */
export function stakesLabel(hand: PhfHand): string {
  if (hand.game.variant === "shortdeck" && hand.game.smallBlind === 0) {
    // GG prints `ShortDeck No Limit ($0.02)`; a `$0/` in front would read as a
    // small blind of nothing rather than as no small blind at all.
    return money(hand, hand.game.bigBlind);
  }
  return `${money(hand, hand.game.smallBlind)}/${money(hand, hand.game.bigBlind)}`;
}

/**
 * Everything unusual about how the money went in, as short chips.
 *
 * This is where most of what the PHF migration unlocked finally surfaces:
 * `table.fastFold`, `game.bombPot`, the ante *model* rather than a bare
 * amount, and the straddle list. All four change how the preflop pot is built,
 * so a reader who cannot see them is misreading every stack-to-pot ratio in
 * the hand.
 */
export function structureBadges(hand: PhfHand, t: Dict["replayer"]): string[] {
  const { game, table } = hand;
  const words = t.facts;
  const badges: string[] = [];

  if (table.fastFold) {
    badges.push(table.fastFold);
  }
  if (game.bombPot) {
    // No blinds and straight to the flop, so "preflop" never happens.
    badges.push(words.bombPot(money(hand, game.bombPot.ante)));
    if (game.bombPot.doubleBoard) {
      badges.push(words.doubleBoard);
    }
  }
  const buttonBlind = hand.actions.find(isButtonBlind);
  if (buttonBlind) {
    // The only blind on an ante-only table, and it is on the button - which
    // is why no seat is labelled SB or BB in this hand.
    badges.push(words.buttonBlind(money(hand, buttonBlind.amount)));
  }
  switch (game.anteModel) {
    case "big-blind-ante":
      // One post for the whole table, not one per player.
      badges.push(words.bbAnte(money(hand, game.ante)));
      break;
    case "button-ante":
      badges.push(words.btnAnte(money(hand, game.ante)));
      break;
    case "posted-per-player":
      if (game.ante > 0) {
        badges.push(words.ante(money(hand, game.ante)));
      }
      break;
    default:
      break;
  }
  if (game.straddles.length === 1) {
    badges.push(words.straddle(money(hand, game.straddles[0].amount)));
  } else if (game.straddles.length > 1) {
    const amounts = game.straddles
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((straddle) => money(hand, straddle.amount))
      .join(" / ");
    badges.push(words.straddles(game.straddles.length, amounts));
  }
  return badges;
}

/** `"6-max"`, plus how many were actually dealt in when it is not a full table. */
export function tableShapeLabel(hand: PhfHand, t: Dict["replayer"]): string {
  const dealtIn = hand.players.filter((player) => !player.sittingOut).length;
  const max = hand.table.maxSeats;
  return max > 0 && dealtIn !== max ? t.facts.tableShapeDealt(max, dealtIn) : t.facts.tableShape(max);
}

/**
 * The hand's own timestamp, in the reader's language (`intlLocale` is a BCP 47
 * tag, `INTL_LOCALE[useLocale()]`). `null` when unknown.
 */
export function playedAtLabel(hand: PhfHand, intlLocale: string): string | null {
  if (!hand.playedAt) {
    return null;
  }
  const date = new Date(hand.playedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(intlLocale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
