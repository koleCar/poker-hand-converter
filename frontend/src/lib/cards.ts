export type Suit = "s" | "h" | "d" | "c";

export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export type Rank = (typeof RANKS)[number];

export interface Card {
  rank: Rank;
  suit: Suit;
  /** Canonical two-char code, e.g. "Ah". */
  code: string;
}

const SUIT_ORDER: Suit[] = ["s", "h", "d", "c"];

/**
 * Text suit glyphs. Kept for plain-text contexts (export, clipboard, titles).
 *
 * Do NOT use these to draw a card. U+2660/2662/2663 are absent from most UI
 * font families — Inter 4.1 ships only U+2661 and U+2665 of the whole suit
 * block — so three of the four always come from an OS fallback face, and on
 * several platforms that fallback is the colour emoji font. Wrong shape, wrong
 * colour, wrong metrics. Use SUIT_PATH instead. See PlayingCard.
 */
export const SUIT_SYMBOL: Record<Suit, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

/**
 * The four suits as SVG path data on a `0 0 32 32` viewBox, drawn so each fills
 * a comparable area and reads at 10px. The shape is the only non-colour cue a
 * colour-blind player has, so it cannot be left to font fallback.
 *
 * All subpaths wind the same direction, so the default nonzero fill rule unions
 * the club's three lobes with its stem rather than punching holes in them.
 */
export const SUIT_PATH: Record<Suit, string> = {
  s:
    "M16 3c0 5 11 8.5 11 15.2 0 3.4-2.4 5.8-5.6 5.8-2.1 0-3.8-1.1-4.5-2.8" +
    " -.1 3.2 1 5.5 2.7 7 .6.5.3 1.4-.5 1.4h-6.2c-.8 0-1.1-.9-.5-1.4" +
    " 1.7-1.5 2.8-3.8 2.7-7-.7 1.7-2.4 2.8-4.5 2.8C7.4 24 5 21.6 5 18.2 5 11.5 16 8 16 3z",
  h:
    "M16 28.8C16 23.4 3 19.6 3 12.3 3 8.6 5.7 6 9.2 6c2.9 0 5 1.8 6.8 4.1" +
    "C17.8 7.8 19.9 6 22.8 6 26.3 6 29 8.6 29 12.3c0 7.3-13 11.1-13 16.5z",
  d: "M16 2.4c2.6 5 6.3 9.6 10.6 13.6-4.3 4-8 8.6-10.6 13.6-2.6-5-6.3-9.6-10.6-13.6 4.3-4 8-8.6 10.6-13.6z",
  c:
    "M16 3.3a6.3 6.3 0 0 1 0 12.6 6.3 6.3 0 0 1 0-12.6z" +
    "M10 12a6.3 6.3 0 0 1 0 12.6 6.3 6.3 0 0 1 0-12.6z" +
    "M22 12a6.3 6.3 0 0 1 0 12.6 6.3 6.3 0 0 1 0-12.6z" +
    "M13.7 14.8h4.6c-.4 7.4.8 11.5 3.4 13.7.6.5.3 1.5-.5 1.5H10.8" +
    "c-.8 0-1.1-1-.5-1.5 2.6-2.2 3.8-6.3 3.4-13.7z",
};

export const SUIT_NAME: Record<Suit, string> = {
  s: "spades",
  h: "hearts",
  d: "diamonds",
  c: "clubs",
};

/** Parses "Ah", "ah", "AH" into a canonical card. Returns null for junk. */
export function parseCard(raw: string): Card | null {
  const trimmed = raw.trim();
  if (trimmed.length !== 2) {
    return null;
  }
  const rank = trimmed[0].toUpperCase() as Rank;
  const suit = trimmed[1].toLowerCase() as Suit;
  if (!RANKS.includes(rank) || !SUIT_ORDER.includes(suit)) {
    return null;
  }
  return { rank, suit, code: `${rank}${suit}` };
}

/**
 * Pulls every card code out of free text. Tolerates "Ah Kd", "AhKd",
 * "[Ah Kd]" and comma separated input, which is what the filter box gets.
 */
export function extractCards(raw: string): string[] {
  const matches = raw.match(/[2-9TJQKAtjqka][shdcSHDC]/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of matches) {
    const card = parseCard(match);
    if (card && !seen.has(card.code)) {
      seen.add(card.code);
      out.push(card.code);
    }
  }
  return out;
}

export function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank);
}

export function isRedSuit(suit: Suit): boolean {
  return suit === "h" || suit === "d";
}

/**
 * Canonical starting-hand class for two hole cards: "AA", "AKs", "AKo".
 * Returns null when the input is not exactly two valid cards.
 */
export function handClass(cards: string[]): string | null {
  if (cards.length !== 2) {
    return null;
  }
  const a = parseCard(cards[0]);
  const b = parseCard(cards[1]);
  if (!a || !b) {
    return null;
  }
  const [high, low] = rankValue(a.rank) >= rankValue(b.rank) ? [a, b] : [b, a];
  if (high.rank === low.rank) {
    return `${high.rank}${low.rank}`;
  }
  return `${high.rank}${low.rank}${high.suit === low.suit ? "s" : "o"}`;
}

/**
 * Normalises a user-typed hand class filter ("aks", "AKS", "ak") into the
 * canonical form. "AK" without a suffix stays suit-agnostic and returns both
 * variants so the caller can match either.
 */
export function parseHandClassQuery(raw: string): string[] | null {
  const trimmed = raw.trim().replace(/\s+/g, "");
  const match = trimmed.match(/^([2-9TJQKAtjqka])([2-9TJQKAtjqka])([sSoO])?$/);
  if (!match) {
    return null;
  }
  const first = match[1].toUpperCase() as Rank;
  const second = match[2].toUpperCase() as Rank;
  const suffix = match[3]?.toLowerCase();

  const [high, low] = rankValue(first) >= rankValue(second) ? [first, second] : [second, first];
  if (high === low) {
    return [`${high}${low}`];
  }
  if (suffix === "s") {
    return [`${high}${low}s`];
  }
  if (suffix === "o") {
    return [`${high}${low}o`];
  }
  return [`${high}${low}s`, `${high}${low}o`];
}

export type HeroQuery =
  | { kind: "class"; values: string[] }
  | { kind: "cards"; values: string[] }
  | { kind: "none" };

/**
 * Interprets the hero hole-card filter box.
 *
 * Order matters: "AKs" contains the substring "Ks", which `extractCards` would
 * happily read as the King of spades. The hand-class reading is therefore tried
 * first, and only inputs that cannot be a class fall through to card codes.
 */
export function resolveHeroQuery(raw: string): HeroQuery {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "none" };
  }
  const classes = parseHandClassQuery(trimmed);
  if (classes) {
    return { kind: "class", values: classes };
  }
  const cards = extractCards(trimmed);
  if (cards.length > 0) {
    return { kind: "cards", values: cards };
  }
  return { kind: "none" };
}
