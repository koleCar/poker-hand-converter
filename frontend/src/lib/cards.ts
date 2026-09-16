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

export const SUIT_SYMBOL: Record<Suit, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
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
