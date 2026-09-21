/**
 * One-line descriptions of a converted hand, for the results list.
 *
 * Everything monetary goes through `formatAmount` with the hand's own
 * `CurrencyUnit`: a tournament hand has `minorUnits: 1`, so dividing by 100
 * anywhere here would render every chip stack a hundred times too small.
 */

import { formatAmount, heroOf, primaryBoard, type PhfHand } from "../../lib/phf/types";

export interface HandRow {
  /** `meta.handKey`; unique per hand and stable across re-conversion. */
  key: string;
  handId: string;
  siteName: string;
  /** "$0.25/$0.5" or "25/50" for chips. */
  stakes: string;
  table: string;
  heroName: string | null;
  heroCards: string[];
  board: string[];
  pot: string;
  /** Hero's net, formatted and signed. Null when the hand has no hero. */
  heroNet: string | null;
  netDirection: "up" | "down" | "flat";
  /** Short local time, or an empty string when the source omitted one. */
  playedAt: string;
  seats: number;
}

export function toHandRow(hand: PhfHand): HandRow {
  const unit = hand.game.unit;
  const hero = heroOf(hand);
  const net = hand.results.heroNet;
  const played = hand.playedAt ? new Date(hand.playedAt) : null;
  const blindStyle = unit.minorUnits > 1 ? "fixed2" : "minimal";

  return {
    key: `${hand.meta.siteId}:${hand.meta.handKey}`,
    handId: hand.meta.handId,
    siteName: hand.meta.siteName,
    // `fixed2` on cash, so blinds read "$0.05/$0.10" the way every tracker
    // and every poker room writes them, not "$0.05/$0.1". Chip tables keep
    // whole numbers, where a forced ".00" would be wrong.
    stakes: `${formatAmount(hand.game.smallBlind, unit, blindStyle)}/${formatAmount(hand.game.bigBlind, unit, blindStyle)}`,
    table: hand.table.name ?? hand.tournament?.name ?? "",
    heroName: hero?.name ?? null,
    heroCards: hero?.holeCards ?? [],
    board: primaryBoard(hand),
    pot: formatAmount(hand.results.totalPot, unit),
    heroNet: net === null ? null : formatAmount(net, unit),
    netDirection: net === null || net === 0 ? "flat" : net > 0 ? "up" : "down",
    playedAt: played && !Number.isNaN(played.getTime())
      ? played.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "",
    seats: hand.players.length,
  };
}

/**
 * Human sentence for a failure reason code.
 *
 * The codes come from the parsers and the validator and are written for
 * developers; this is the same information written for the person who just
 * uploaded the file. Unknown codes fall back to the parser's own message, so a
 * parser added tomorrow degrades to "readable" rather than to "blank".
 */
export const FAILURE_REASON_COPY: Record<string, string> = {
  "unknown-site": "We do not recognise this hand history format yet.",
  "no-hands": "We recognised the format but found no complete hands in the text.",
  "split-failed": "We could not split this file into individual hands.",
  "parser-error": "Our converter hit something it did not expect in this hand.",
  "tournament-in-cash-mode": "Tournament hand, skipped because the converter was set to cash games only.",
  "bomb-pot": "Bomb pot, skipped by request.",
  "chip-mismatch": "The chips in this hand do not add up, so converting it would give you wrong numbers.",
  "duplicate-card": "The same card appears twice in this hand.",
  "bb-only-walk": "Everyone folded to the big blind, so there is no hand to replay.",
  "uncalled-exceeds-commitment": "The returned uncalled bet is larger than what was actually bet.",
  "normalized-unparseable": "The hand cleaned up correctly but our reader still could not make sense of it.",
  "invalid-hand": "The converted hand failed our consistency checks.",
};

/** What we are going to do about a failure — the honest part of the message. */
export const FAILURE_STAGE_COPY: Record<string, string> = {
  detect: "Unsupported format",
  split: "Could not be split into hands",
  parse: "Could not be read",
  validate: "Did not pass our checks",
  serialize: "Could not be written out",
};
