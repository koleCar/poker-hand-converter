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
 *
 * Hold'em and short deck only, deliberately: see `omahaHandClass` for the
 * four-, five- and six-card form. Keeping them apart means the Hold'em class
 * this has always produced - and that every stored row already holds - cannot
 * change shape underneath a caller that only ever deals two cards.
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
 * Canonical starting-hand class for a four-, five- or six-card Omaha hand.
 *
 * **What it is for.** `handClass` gives Hold'em a stats dimension: 1,326 dealt
 * hands collapse into 169 classes, which is few enough to group by, filter on
 * and show in a grid. Omaha needs the same dimension for the same reasons -
 * "how do I do with aces double-suited", "is my rundown winrate real" - and
 * without it every PLO statistic is either per-exact-hand (useless, nothing
 * repeats) or nothing at all.
 *
 * **The shape.** Ranks, high to low, then `-`, then the suit structure:
 *
 *     AhKhQdJd -> "AKQJ-22"    two suits of two: double suited
 *     AhKhQdJc -> "AKQJ-2"     one suit of two: single suited
 *     AhKsQdJc -> "AKQJ-r"     rainbow
 *     AhKhQhJc -> "AKQJ-3"     three of a suit, one dangler
 *     AhKhQhJh -> "AKQJ-4"     monotone
 *     AhAsKhKs -> "AAKK-22"    aces double suited
 *     AhKhQdJdTc -> "AKQJT-22" five-card Omaha, same rules
 *
 * The suffix lists the size of every suit group holding two or more cards, in
 * descending order; groups of one carry no information (the rest of the hand is
 * whatever is left over) and are dropped, so a hand with no suited pair reads
 * `-r` rather than `-1111`. Digits are used rather than the `ds`/`ss`/`r` the
 * trackers print because those three names cannot say "three of a suit", and a
 * three-flush in Omaha is a materially worse hand than a two-flush - one of the
 * four cards is dead. A vocabulary that cannot express a real distinction would
 * silently merge two populations, which is the same failure this project
 * refuses hands to avoid. `-22` still *means* double-suited, and the doc block
 * above is the translation table.
 *
 * **What it deliberately does not do.** It does not bucket hands into
 * "rundown", "pair + wrap", "dangler" and so on. Those are judgements about
 * rank *connectedness*, they are matters of degree (is `AKQ8` a rundown?), and
 * every one of them is recoverable from the ranks this string preserves
 * exactly. They belong to the stats layer, which can change its mind about
 * where a boundary sits without invalidating a column already written to every
 * stored hand. This function's job is the canonical identity; naming families
 * of identities is a different job.
 *
 * Returns null unless given exactly 4, 5 or 6 valid, distinct cards. Two-card
 * hands go to `handClass`, whose `AKs` / `AKo` form is unchanged and is what
 * the `hands.hero_hand_class` column already holds for Hold'em.
 */
export function omahaHandClass(cards: string[]): string | null {
  if (cards.length < 4 || cards.length > 6) {
    return null;
  }
  const parsed = cards.map(parseCard);
  if (parsed.some((card) => card === null)) {
    return null;
  }
  const hand = parsed as Card[];
  if (new Set(hand.map((card) => card.code)).size !== hand.length) {
    return null;
  }

  const ranks = [...hand]
    .sort((a, b) => rankValue(b.rank) - rankValue(a.rank))
    .map((card) => card.rank)
    .join("");

  const bySuit = new Map<Suit, number>();
  for (const card of hand) {
    bySuit.set(card.suit, (bySuit.get(card.suit) ?? 0) + 1);
  }
  const groups = [...bySuit.values()].filter((size) => size > 1).sort((a, b) => b - a);

  return `${ranks}-${groups.length === 0 ? "r" : groups.join("")}`;
}

/**
 * What the hero's hand search asks for: the starting-hand classes the hand
 * must be one of (`null`, any; empty, none), and the cards it must hold.
 */
export interface HeroHand {
  classes: string[] | null;
  cards: string[];
}

/** The ranks high to low, the order the range grid and the classes use. */
const HIGH_FIRST: Rank[] = [...RANKS].reverse();

/** "AA", "AKs", "AKo": the higher rank first. */
function classOf(a: Rank, b: Rank, suited: boolean): string {
  const [high, low] = rankValue(a) >= rankValue(b) ? [a, b] : [b, a];
  return high === low ? `${high}${low}` : `${high}${low}${suited ? "s" : "o"}`;
}

/** The classes of two ranks: a pair, or the suited and offsuit forms ("s"/"o" picks one). */
function classesOf(a: Rank, b: Rank, suffix: "s" | "o" | null): string[] {
  if (a === b) return suffix === null ? [classOf(a, b, false)] : [];
  if (suffix !== null) return [classOf(a, b, suffix === "s")];
  return [classOf(a, b, true), classOf(a, b, false)];
}

/** The 169 classes in the grid's order: row by row, the pair on the diagonal. */
const ALL_CLASSES: string[] = HIGH_FIRST.flatMap((row, i) =>
  HIGH_FIRST.map((column, j) => (i === j ? `${row}${row}` : i < j ? `${row}${column}s` : `${column}${row}o`)),
);

const rankOf = (char: string): Rank | null => {
  const rank = char.toUpperCase() as Rank;
  return RANKS.includes(rank) ? rank : null;
};

/** "s" / "ss" suited, "o" / "oo" offsuit, nothing both. */
const suffixOf = (raw: string | undefined): "s" | "o" | null =>
  raw ? (raw[0].toLowerCase() as "s" | "o") : null;

const R = "[2-9TJQKA]";
const SUFFIX = "(ss|oo|s|o)?";
const CLASS_TOKEN = new RegExp(`^(${R})(${R})${SUFFIX}(\\+)?$`, "i");
const RANGE_TOKEN = new RegExp(`^(${R})(${R})${SUFFIX}-(${R})(${R})${SUFFIX}$`, "i");
const ANY_TOKEN = new RegExp(`^(${R})[x*]${SUFFIX}$`, "i");
const CARDS_TOKEN = new RegExp(`^(?:${R}[shdcx*])+$`, "i");

/**
 * One class-shaped word of the search: "AA", "AK", "AKs"/"AKss", "AKo"/"AKoo",
 * "TT+", "ATs+", "22-66", "A2s-A5s", "Ax", "Axs", "Kxo". Null for a word that
 * is not one (cards, or junk).
 */
function classToken(token: string): string[] | null {
  const plain = token.match(CLASS_TOKEN);
  if (plain) {
    const a = rankOf(plain[1])!;
    const b = rankOf(plain[2])!;
    const suffix = suffixOf(plain[3]);
    if (a === b && suffix !== null) return null;
    if (!plain[4]) return classesOf(a, b, suffix);
    // "TT+": that pair and every pair above it. "ATs+": the kicker up to one
    // below the high card.
    if (a === b) return HIGH_FIRST.filter((rank) => rankValue(rank) >= rankValue(a)).map((rank) => classOf(rank, rank, false));
    const [high, low] = rankValue(a) >= rankValue(b) ? [a, b] : [b, a];
    return HIGH_FIRST.filter((rank) => rankValue(rank) >= rankValue(low) && rankValue(rank) < rankValue(high)).flatMap(
      (kicker) => classesOf(high, kicker, suffix),
    );
  }
  const range = token.match(RANGE_TOKEN);
  if (range) {
    const [a1, b1, a2, b2] = [range[1], range[2], range[4], range[5]].map((char) => rankOf(char)!);
    const suffix = suffixOf(range[3]);
    if (suffixOf(range[6]) !== suffix) return null;
    // Pairs "22-66": every pair between. Otherwise the same high card, the
    // kicker between ("A2s-A5s").
    if (a1 === b1 && a2 === b2) {
      if (suffix !== null) return null;
      const [lo, hi] = [rankValue(a1), rankValue(a2)].sort((x, y) => x - y);
      return HIGH_FIRST.filter((rank) => rankValue(rank) >= lo && rankValue(rank) <= hi).map((rank) => classOf(rank, rank, false));
    }
    const high = rankValue(a1) >= rankValue(b1) ? a1 : b1;
    const low1 = high === a1 ? b1 : a1;
    const highTwo = rankValue(a2) >= rankValue(b2) ? a2 : b2;
    const low2 = highTwo === a2 ? b2 : a2;
    if (high !== highTwo || low1 === high || low2 === high) return null;
    const [lo, hi] = [rankValue(low1), rankValue(low2)].sort((x, y) => x - y);
    return HIGH_FIRST.filter((rank) => rankValue(rank) >= lo && rankValue(rank) <= hi).flatMap((kicker) =>
      classesOf(high, kicker, suffix),
    );
  }
  const any = token.match(ANY_TOKEN);
  if (any) {
    // "Ax": every hand with an ace (its pair too); "Axs" / "Axo": the suited
    // or offsuit ones.
    const rank = rankOf(any[1])!;
    const suffix = suffixOf(any[2]);
    return HIGH_FIRST.flatMap((other) => classesOf(rank, other, suffix));
  }
  return null;
}

/**
 * One cards word: "Ad", "AdAs", "AdKx" (`x` any suit). The cards it names,
 * and the classes its ranks make when a suit is left open (Hold'em: two
 * cards then; "Kx" alone is a class word). Null for junk.
 */
function cardsToken(token: string): { cards: string[]; classes: string[] | null } | null {
  if (!CARDS_TOKEN.test(token)) return null;
  const units = token.match(/../g)!.map((unit) => ({ rank: rankOf(unit[0])!, suit: unit[1].toLowerCase() }));
  const open = units.some((unit) => unit.suit === "x" || unit.suit === "*");
  const cards = units.filter((unit) => unit.suit !== "x" && unit.suit !== "*").map((unit) => `${unit.rank}${unit.suit}`);
  if (!open) return { cards, classes: null };
  if (units.length !== 2) return null;
  const [first, second] = units;
  if (first.rank === second.rank && first.suit === second.suit) return null;
  // Both suits known would be cards alone; one open: the class, and whether
  // it can be suited follows from the card that is known.
  return { cards, classes: classesOf(first.rank, second.rank, null) };
}

/**
 * Reads the hero's hand search (the owner, 2026-11-19: "AA", "AdAs", "Ad",
 * "AKss", "AKoo", ...). Words are split by spaces or commas:
 *
 * - classes and ranges add up: "AA, KK, AKs" is any of the three.
 *   `AA`, `AK` (suited or not), `AKs`/`AKss`, `AKo`/`AKoo`, `TT+`, `ATs+`,
 *   `22-66`, `A2s-A5s`, `Ax` (any hand with an ace), `Axs`, `Axo`;
 * - cards with a suit must all be held: "Ad" (the ace of diamonds, any
 *   game), "AdAs", "Ad Ks"; `x` leaves a suit open, "AdKx";
 * - cards and classes together: the cards, in one of the classes ("Ad, AA").
 *
 * Classes are Hold'em's; a suit-bound card works in any game. Empty text asks
 * for nothing; junk (a word that is neither) gives null, which a filter
 * treats as matching no hand rather than every hand.
 */
export function parseHeroHand(raw: string): HeroHand | null {
  const text = raw
    .replace(/10/g, "T")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+\+/g, "+")
    .trim();
  if (!text) return { classes: null, cards: [] };
  // The class words add up; the cards words' open suits narrow.
  const union: string[][] = [];
  const narrow: string[][] = [];
  const cards: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const classes = classToken(token);
    if (classes) {
      union.push(classes);
      continue;
    }
    const held = cardsToken(token);
    if (!held) return null;
    for (const card of held.cards) if (!cards.includes(card)) cards.push(card);
    if (held.classes) narrow.push(held.classes);
  }
  if (union.length === 0 && narrow.length === 0) return { classes: null, cards };
  const allowed = (value: string) =>
    (union.length === 0 || union.some((classes) => classes.includes(value))) &&
    narrow.every((classes) => classes.includes(value));
  return { classes: ALL_CLASSES.filter(allowed), cards };
}
