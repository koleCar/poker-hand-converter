/**
 * PHF - Poker Hand Format, version `phf/1`.
 *
 * This is the single canonical representation of a poker hand in this project.
 * Every site parser produces a `PhfHand`; every consumer (replayer, standard
 * text serializer, database row builder, filters) reads a `PhfHand`. The
 * GG-style text the app emits is one *serialization* of PHF, not the source of
 * truth.
 *
 * Design rules that the rest of the file assumes:
 *
 * 1. **No floats.** Every monetary value is an integer in minor units (cents
 *    for cash, whole chips for tournaments) paired with a `CurrencyUnit` that
 *    says how many minor units make one display unit. Hand histories are full
 *    of values like `$0.05` and summing them as floats drifts; drift shows up
 *    as "pot does not add up" bugs that are very hard to trace back.
 * 2. **Ordered action stream.** `actions` is the authoritative timeline. Board
 *    cards, pots and stacks are all derivable from it; the denormalized copies
 *    exist because the source text states them and we want to cross-check.
 * 3. **Run-it-twice is not a special case.** `board.runouts` is an array. A
 *    normal hand has one entry. Nothing downstream needs an `if (runTwice)`.
 * 4. **Provenance is mandatory.** A hand we cannot trust is worse than no hand,
 *    so every hand carries the raw text it came from, which parser produced it
 *    and what that parser was unsure about.
 */

/*
 * ## The types are generated from the Rust model (R4.1)
 *
 * Every PHF type is declared once, in `core/rail-core/src/phf/mod.rs`, and
 * written out as TypeScript by `RAIL_UPDATE_DTS=1 cargo test -p rail-core
 * --lib phf::dts` into `core/rail-core-wasm/types/phf.d.ts`, the declarations
 * the WebAssembly core's results carry. This module re-exports them under
 * their old names, so the 190-odd files that import `phf/types` did not
 * change; what stays here is behaviour - units, amounts, positions and the
 * small readers below. The field-by-field documentation is in the generated
 * file (and `docs/PHF-SPEC.md`). `npm run phf:dts-check` in `tests/` still
 * compares this module's types with the generated ones, so a hand-written
 * type that creeps back in has to be identical.
 */
import type {
  Amount,
  CurrencyUnit,
  DecimalStyle,
  Street,
  Variant,
  Position,
  PhfTournament,
  PhfPlayer,
  ActionType,
  PhfAction,
  PhfBoard,
  PhfFees,
  PhfTextStyle,
  PhfHand,
  PhfSchema,
} from "../../../../core/rail-core-wasm/types/phf";

export type {
  Amount,
  PhfSchema,
  CurrencyKind,
  CurrencyUnit,
  DecimalStyle,
  Street,
  Variant,
  LimitType,
  GameFormat,
  AnteModel,
  Position,
  PhfStraddle,
  PhfBombPot,
  PhfGame,
  PhfTable,
  PhfBounty,
  PhfTournament,
  PhfPlayer,
  ActionType,
  PotHalf,
  PhfAction,
  PhfMarkerLabels,
  PhfRunout,
  PhfBoard,
  ChipMovementAnchor,
  PhfChipMovement,
  PhfFees,
  SeatOutcome,
  PhfPlayerResult,
  PhfPot,
  PhfWinner,
  PhfResults,
  PhfWarning,
  PhfTextStyle,
  PhfMeta,
  PhfHand,
} from "../../../../core/rail-core-wasm/types/phf";

/** Schema tag stamped on every hand. See `docs/PHF-SPEC.md` for the versioning policy. */
export const PHF_SCHEMA = "phf/1" as const satisfies PhfSchema;

/* ------------------------------------------------------------------ money - */

/** Builds a cash unit. Two-decimal currencies only; see `JPY` for the exception. */
export function cashUnit(code: string, symbol: string, minorUnits = 100): CurrencyUnit {
  return { code, symbol, minorUnits, kind: "cash" };
}

export const USD: CurrencyUnit = cashUnit("USD", "$");
export const EUR: CurrencyUnit = cashUnit("EUR", "€");
export const GBP: CurrencyUnit = cashUnit("GBP", "£");
export const CAD: CurrencyUnit = cashUnit("CAD", "$");
export const AUD: CurrencyUnit = cashUnit("AUD", "$");
export const NZD: CurrencyUnit = cashUnit("NZD", "$");
export const CHF: CurrencyUnit = cashUnit("CHF", "CHF");
export const SEK: CurrencyUnit = cashUnit("SEK", "kr");
export const NOK: CurrencyUnit = cashUnit("NOK", "kr");
export const DKK: CurrencyUnit = cashUnit("DKK", "kr");
export const PLN: CurrencyUnit = cashUnit("PLN", "zł");
export const RUB: CurrencyUnit = cashUnit("RUB", "₽");
export const BRL: CurrencyUnit = cashUnit("BRL", "R$");
export const MXN: CurrencyUnit = cashUnit("MXN", "$");
export const INR: CurrencyUnit = cashUnit("INR", "₹");
export const CNY: CurrencyUnit = cashUnit("CNY", "¥");
/** The yen has no subunit in practice, so one minor unit is one yen. */
export const JPY: CurrencyUnit = cashUnit("JPY", "¥", 1);
/**
 * Tether, which crypto rooms denominate tables in.
 *
 * USDT has six decimals on chain, but the clients settle tables in hundredths
 * and never print a third decimal place, so `minorUnits: 100` is exact here
 * rather than a rounding. A parser that meets a third decimal should refuse the
 * hand (`unsupported-precision`) instead of letting `parseAmount` mis-scale it.
 */
export const USDT: CurrencyUnit = cashUnit("USDT", "\u20ae");

/** Tournament chips. Indivisible, and never convertible to money inside a hand. */
export const CHIPS: CurrencyUnit = { code: "CHIPS", symbol: "", minorUnits: 1, kind: "chips" };
/**
 * Chips that come in hundredths.
 *
 * Most rooms deal whole chips, but some tournament structures genuinely do not
 * - Chico prints stacks and bets like `2642.50` - and rounding those to whole
 * chips loses real money from the hand. Use this whenever a chip amount in the
 * source carries a decimal point; `chipsUnitFor` picks it automatically.
 */
export const FRACTIONAL_CHIPS: CurrencyUnit = {
  code: "CHIPS",
  symbol: "",
  minorUnits: 100,
  kind: "chips",
};

/**
 * The chips unit a hand needs, judged from its own text.
 *
 * Returns `FRACTIONAL_CHIPS` when any bare amount in the source carries a
 * decimal point, `CHIPS` otherwise. Getting this wrong is silent: a half chip
 * rounds away and the hand still balances against itself.
 */
export function chipsUnitFor(sourceText: string): CurrencyUnit {
  return /(?:^|[\s(])\d[\d,]*\.\d/.test(sourceText) ? FRACTIONAL_CHIPS : CHIPS;
}
/** Play-money chips. Same arithmetic as `CHIPS`, kept distinct so filters can exclude them. */
export const PLAY_CHIPS: CurrencyUnit = {
  code: "TCHIP",
  symbol: "",
  minorUnits: 1,
  kind: "chips",
};

/** Every named unit, by code, for `unitForCode`. */
export const CURRENCY_UNITS: Readonly<Record<string, CurrencyUnit>> = {
  USD,
  EUR,
  GBP,
  CAD,
  AUD,
  NZD,
  CHF,
  SEK,
  NOK,
  DKK,
  PLN,
  RUB,
  BRL,
  MXN,
  INR,
  CNY,
  JPY,
  USDT,
  CHIPS,
  TCHIP: PLAY_CHIPS,
};

/**
 * Picks the unit for a three-letter code, which is what several rooms print
 * next to the buy-in (`$4.50+$1 USD`).
 *
 * An unrecognised code becomes a two-decimal cash unit carrying that code
 * rather than falling back to chips: guessing "chips" would silently multiply
 * every amount in the hand by 100.
 */
export function unitForCode(code: string, symbol?: string): CurrencyUnit {
  const upper = code.toUpperCase();
  const known = CURRENCY_UNITS[upper];
  if (!known) {
    return cashUnit(upper, symbol ?? upper);
  }
  // An explicit symbol always wins. Whether a code happens to be in the table
  // is an implementation detail of this module, and letting it decide whether
  // the caller's argument is honoured makes the parameter behave differently
  // for USDT than for, say, HUF. CoinPoker asks for `unitForCode("USDT", "$")`
  // precisely because it needs a glyph this format can read back.
  if (symbol === undefined || symbol === known.symbol) {
    return known;
  }
  return { ...known, symbol };
}

/**
 * Picks the unit for a currency symbol found in a hand history header.
 *
 * `$` is deliberately USD: CAD, AUD, NZD and MXN share the glyph, and a parser
 * that can tell them apart has a three-letter code to hand and should call
 * `unitForCode` instead. An empty or unknown symbol means chips.
 */
export function unitForSymbol(symbol: string): CurrencyUnit {
  switch (symbol) {
    case "€":
      return EUR;
    case "£":
      return GBP;
    case "$":
      return USD;
    case "₽":
      return RUB;
    case "zł":
      return PLN;
    case "₹":
      return INR;
    case "R$":
      return BRL;
    case "kr":
      return SEK;
    case "¥":
      return CNY;
    case "\u20ae":
      // Without this, USDT fell through to CHIPS and every amount in the hand
      // silently became 1/100th of itself.
      return USDT;
    default:
      return CHIPS;
  }
}

/** Parses "1,234.50" / "0.5" / "2260" into minor units. Junk becomes 0. */
export function parseAmount(raw: string | undefined | null, unit: CurrencyUnit): Amount {
  if (raw === undefined || raw === null || raw === "") {
    return 0;
  }
  const cleaned = raw.replace(/[^\d.-]/g, "");
  if (!cleaned) {
    return 0;
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * unit.minorUnits);
}

/**
 * Why a printed amount could not be held exactly.
 *
 * `not-a-number` - nothing numeric in the token at all.
 * `too-precise`  - more decimal places than the unit has minor units for,
 *                  e.g. `0.025` against a two-decimal currency.
 * `ambiguous-separators` - the token mixes `.` and `,`, or spaces digits, so
 *                  which one is the decimal mark is a guess.
 */
export type AmountProblem = "not-a-number" | "too-precise" | "ambiguous-separators";

export type StrictAmount =
  | { ok: true; amount: Amount }
  | { ok: false; problem: AmountProblem; text: string };

/**
 * Reads a printed amount, refusing anything it cannot hold exactly.
 *
 * `parseAmount` strips every non-digit and rounds, which is the right
 * behaviour once a parser knows the token's shape but a 100x landmine before
 * it does: `1 234,50 €` becomes 123450 minor units, and the resulting hand
 * balances perfectly against itself, so no invariant downstream can catch it.
 * A mis-scaled amount is worse than a rejected hand.
 *
 * Three site parsers independently grew a local version of this guard before
 * it existed here - CoinPoker's `assertRepresentable`, Winamax's per-token
 * shape check and Chico's - which is the signal that it belongs in the core.
 *
 * Use this at the boundary, where a token first arrives from the source; use
 * `parseAmount` afterwards, when the shape is already known to be good.
 */
export function parseAmountStrict(raw: string, unit: CurrencyUnit): StrictAmount {
  const text = raw.trim();
  // Strip currency symbols and whitespace, nothing else: the separators are
  // the evidence and have to survive to be judged.
  const bare = text.replace(/[$\u20ac\u00a3\u20ae]/g, "").replace(/\s+/g, "");
  if (!/^-?[\d.,]+$/.test(bare) || !/\d/.test(bare)) {
    return { ok: false, problem: "not-a-number", text };
  }

  const negative = bare.startsWith("-");
  const digits = negative ? bare.slice(1) : bare;
  const dots = (digits.match(/\./g) ?? []).length;
  const commas = (digits.match(/,/g) ?? []).length;

  let whole = digits;
  let fraction = "";

  if (dots > 0 && commas > 0) {
    if (dots > 1 && commas > 1) {
      return { ok: false, problem: "ambiguous-separators", text };
    }
    // `1,234.50` or `1.234,50`: the *last* separator is the decimal mark and
    // the other one is grouping.
    const decimalMark = digits.lastIndexOf(".") > digits.lastIndexOf(",") ? "." : ",";
    const groupMark = decimalMark === "." ? "," : ".";
    const ungrouped = digits.split(groupMark).join("");
    const cut = ungrouped.lastIndexOf(decimalMark);
    whole = ungrouped.slice(0, cut);
    fraction = ungrouped.slice(cut + 1);
  } else if (dots > 1 || commas > 1) {
    // Repeated separators can only be grouping: `1.234.567`.
    whole = digits.split(dots > 1 ? "." : ",").join("");
  } else if (dots === 1 || commas === 1) {
    const mark = dots === 1 ? "." : ",";
    const [left, right] = digits.split(mark);
    // Three trailing digits behind a valid leading group is grouping, not a
    // decimal: every room here writes `1,050` and `1.050` for a thousand and
    // fifty. One or two trailing digits is a decimal mark, which is what makes
    // the European `1 234,50` read as 1234.50 rather than as 123450. The
    // leading group has to be 1-3 digits and cannot be `0`, so `0.025` stays a
    // decimal and is then refused for being too precise.
    if (right.length === 3 && /^[1-9]\d{0,2}$/.test(left)) {
      whole = left + right;
    } else {
      whole = left;
      fraction = right;
    }
  }

  if (fraction.length > 0) {
    const places = String(unit.minorUnits).length - 1;
    if (fraction.length > places) {
      return { ok: false, problem: "too-precise", text };
    }
    fraction = fraction.padEnd(places, "0");
  }

  const value = Number(whole || "0") * unit.minorUnits + Number(fraction || "0");
  if (!Number.isFinite(value)) {
    return { ok: false, problem: "not-a-number", text };
  }
  return { ok: true, amount: negative ? -value : value };
}

/** Minor units back to a plain number, for display and for the DB columns. */
export function toDisplayNumber(amount: Amount, unit: CurrencyUnit): number {
  return unit.minorUnits === 1 ? amount : amount / unit.minorUnits;
}

/** Digits only, no symbol: "0.5" (minimal) or "0.50" (fixed2); "2260" for chips. */
/** Inserts `,` every three digits in the integer part: 21929 -> "21,929". */
function groupDigits(text: string): string {
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function formatAmountDigits(
  amount: Amount,
  unit: CurrencyUnit,
  style: DecimalStyle = "minimal",
  groupThousands = false,
): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  let text: string;
  if (unit.minorUnits === 1) {
    text = String(abs);
  } else {
    const whole = abs / unit.minorUnits;
    if (abs % unit.minorUnits === 0) {
      // Both styles drop the decimals on round amounts: "$3", never "$3.00".
      text = String(whole);
    } else if (style === "fixed2") {
      text = whole.toFixed(2);
    } else {
      // Minimal: strip trailing zeros, so 50 cents prints as "0.5".
      text = whole.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    }
  }
  if (groupThousands) {
    text = groupDigits(text);
  }
  return negative ? `-${text}` : text;
}

/** Symbol plus digits, e.g. "$0.50", "2260". */
export function formatAmount(
  amount: Amount,
  unit: CurrencyUnit,
  style: DecimalStyle = "minimal",
  groupThousands = false,
): string {
  const digits = formatAmountDigits(Math.abs(amount), unit, style, groupThousands);
  return amount < 0 ? `-${unit.symbol}${digits}` : `${unit.symbol}${digits}`;
}

/**
 * Big-blind normalized value, rounded to one decimal.
 *
 * The replayer shows stacks in BB because "$47.50" means nothing without the
 * stakes while "95bb" is instantly readable, and because it makes cash and
 * tournament hands comparable.
 */
export function toBigBlinds(amount: Amount, bigBlind: Amount): number {
  if (!bigBlind) {
    return 0;
  }
  return Math.round((amount / bigBlind) * 10) / 10;
}

/* ------------------------------------------------------------- descriptors - */

export const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river", "showdown"];

/**
 * Whether a card can be dealt in this variant at all.
 *
 * Short deck strips the deuces through fives, leaving 36 cards; every other
 * flop game deals from 52. A `5h` in a short-deck hand is not an odd card, it
 * is proof the hand is not what its label says, so `validateHand` refuses it.
 * Takes a card already parsed by `parseCard`; junk is the caller's problem.
 */
export function cardInDeck(code: string, variant: Variant): boolean {
  return variant !== "shortdeck" || !/^[2-5]/.test(code);
}

/** How many hole cards the variant deals. Used by the duplicate-card checks. */
export function holeCardCount(variant: Variant): number | null {
  switch (variant) {
    case "holdem":
    case "shortdeck":
      return 2;
    case "omaha":
      return 4;
    case "omaha5":
      return 5;
    case "omaha6":
      return 6;
    default:
      return null;
  }
}

/**
 * Reads a `Variant` out of the game label a room prints in its header.
 *
 * One implementation, used by both the site parsers and `parseStandardText`.
 * It used to be two - a fuller copy in `parsers/shared/ps-gg-hand.ts` and a
 * thinner one in `phf/serialize.ts` - and they disagreed: the thin copy read
 * `PLO-5` as plain `omaha`, so a five-card hand parsed as `omaha5` by the site
 * parser came back as `omaha` after a text round trip. Nothing compared the two
 * because every PLO hand was refused before it got that far. Two readers of one
 * grammar is the bug; there is now one.
 *
 * Note what this does *not* do: `Omaha Hi/Lo` returns `omaha`, because hi/lo is
 * the same deal with a different pot-award rule. `isHiLoLabel` answers that
 * half, and `PhfGame.hiLo` carries it.
 */
export function variantFromLabel(label: string): Variant {
  // GG names the big-O variants `PLO`, `PLO-5`, `PLO-6`; the suffix is the
  // number of hole cards, so it has to be read before the generic Omaha test.
  if (/6\s*card\s*omaha|omaha\s*6|\bPLO-?6\b/i.test(label)) return "omaha6";
  if (/5\s*card\s*omaha|omaha\s*5|\bPLO-?5\b/i.test(label)) return "omaha5";
  if (/omaha|omahl|\bPLO\b|\bNLO\b/i.test(label)) return "omaha";
  // Before Hold'em, because most spellings contain the word: GG `ShortDeck` /
  // `Hold'em Short Deck`, PokerStars `6+ Hold'em`, ACR `Six Plus Hold'em`.
  // Kept a superset of `isShortDeckLabel` in
  // `parsers/shared/variant-lock.ts`, so a label the lock lets through as
  // short deck is never read back as a 52-card game.
  if (/short\s*deck|6\s*\+|\bsix[\s-]*plus\b/i.test(label)) return "shortdeck";
  if (/\brazz\b/i.test(label)) return "razz";
  if (/\bstud\b/i.test(label)) return "stud";
  if (/\bdraw\b|badugi/i.test(label)) return "draw";
  if (/hold\s*'?em/i.test(label)) return "holdem";
  return "other";
}

/**
 * Every spelling of "high-low split" seen in the sample corpus.
 *
 * Deliberately generous. A false positive costs one refused hand, which the
 * user sees and can report; a false negative silently books half a split pot as
 * a whole one and poisons every statistic computed over it afterwards. The
 * refusal principle says the bias runs one way.
 *
 * Spellings the corpus actually contains: PokerStars `Omaha Hi/Lo Pot Limit`
 * and `7 Card Stud Hi/Lo Limit`, partypoker `PL Omaha Hi-Lo`, Entraction
 * `Omaha Hi/Lo Fixed Limit`, Microgaming `Omaha H/L`, Bovada `OMAHA HiLo`,
 * ACR `Omaha HiLow`, Boss Media `GAME_OMAHL`, plus the `O8` / `PLO8` /
 * `Omaha/8` / `8 or better` family the American rooms use.
 *
 * Only ever fed a game *label*, never a whole hand: a table called "HILO 7" is
 * not a statement about the game, and this must not read it as one.
 */
export function isHiLoLabel(label: string): boolean {
  return (
    /\bhi[\s/._-]?lo(?:w)?\b/i.test(label) ||
    /\bh\s?\/\s?l\b/i.test(label) ||
    /omahl/i.test(label) ||
    /\b(?:PL|NL|FL)?O-?8\b/i.test(label) ||
    /\bomaha[\s/-]*8\b/i.test(label) ||
    /\bstud[\s/-]*8\b/i.test(label) ||
    /\b(?:8|eight)[\s-]*or[\s-]*better\b/i.test(label)
  );
}

/**
 * Position names ordered from the small blind around to the button, for a table
 * with `n` players dealt in.
 *
 * Heads-up is the special case everyone forgets: the button *is* the small
 * blind, so the ring is `["SB", "BB"]` and **no seat is labelled `BTN`**. Code
 * that needs to know where the button is must read `PhfTable.buttonSeat`, never
 * `position === "BTN"`.
 */
export function positionRing(n: number): Position[] {
  switch (n) {
    case 0:
      return [];
    case 1:
      return ["BTN"];
    case 2:
      return ["SB", "BB"];
    case 3:
      return ["SB", "BB", "BTN"];
    case 4:
      return ["SB", "BB", "CO", "BTN"];
    case 5:
      return ["SB", "BB", "UTG", "CO", "BTN"];
    case 6:
      return ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
    case 7:
      return ["SB", "BB", "UTG", "LJ", "HJ", "CO", "BTN"];
    case 8:
      return ["SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO", "BTN"];
    case 9:
      return ["SB", "BB", "UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"];
    default: {
      // 10+: pad the middle with MP so the named seats keep their meaning.
      const head: Position[] = ["SB", "BB", "UTG", "UTG+1", "UTG+2"];
      const tail: Position[] = ["LJ", "HJ", "CO", "BTN"];
      const middle: Position[] = new Array(Math.max(0, n - head.length - tail.length)).fill("MP");
      return [...head, ...middle, ...tail];
    }
  }
}

/**
 * Maps every seat number to its position.
 *
 * `seatNumbers` must be the seats actually dealt in; the ring starts at the
 * small blind, which is one seat clockwise from the button except heads-up,
 * where the button posts the small blind itself. Returns an empty map when the
 * button is unknown, because guessing would silently corrupt filters.
 */
export function resolvePositions(
  seatNumbers: number[],
  buttonSeat: number | null,
): Map<number, Position> {
  const out = new Map<number, Position>();
  const seats = [...seatNumbers].sort((a, b) => a - b);
  if (seats.length === 0 || buttonSeat === null) {
    return out;
  }
  const buttonIndex = seats.indexOf(buttonSeat);
  if (buttonIndex < 0) {
    return out;
  }
  const ring = positionRing(seats.length);
  // ring[0] is the small blind. Three-handed and up that is one seat past the
  // button, but heads-up the button *is* the small blind and the other seat is
  // the big blind - starting the ring past the button there inverts the two.
  const smallBlindIndex =
    seats.length === 2 ? buttonIndex : (buttonIndex + 1) % seats.length;
  for (let offset = 0; offset < seats.length; offset += 1) {
    const seat = seats[(smallBlindIndex + offset) % seats.length];
    out.set(seat, ring[offset]);
  }
  return out;
}

/**
 * Resolves every player's position from the hand itself, and writes it onto
 * `PhfPlayer.position`.
 *
 * This is the authoritative resolver; `resolvePositions` is pure geometry and
 * only gets used as a fallback. Geometry alone is wrong surprisingly often on
 * real tables:
 *
 * - **Dead button.** `table.buttonSeat` can point at a seat whose occupant left
 *   between hands, so there is no player to start counting from at all.
 * - **Seated but not dealt in.** A player who sits out still appears in the
 *   seat list. Counting them shifts every position by one; in the worst case a
 *   six-seat table is really a three-handed hand.
 * - **Heads-up.** The button posts the small blind rather than the seat after it.
 *
 * The blinds are the one thing that is always unambiguous - somebody posted
 * them, and the action stream says who - so the ring is anchored there and
 * walked over the seats that actually took part. Seats that were not dealt in
 * get a `null` position rather than a plausible-looking wrong one.
 */
/**
 * Whether the button is on a seat that was not dealt in.
 *
 * Exported so consumers agree on the test rather than each deriving it: a hand
 * with a dead button has no seat labelled `BTN`, and code that treats a missing
 * BTN as a bug will otherwise go looking for one.
 */
export function hasDeadButton(hand: PhfHand, dealtInSeats?: number[]): boolean {
  if (hand.table.buttonSeat === null) {
    return false;
  }
  const seats = dealtInSeats ?? dealtInSeatsOf(hand);
  return seats.length > 0 && !seats.includes(hand.table.buttonSeat);
}

/** Seats that took part: anyone who put a chip in or made a move. */
function dealtInSeatsOf(hand: PhfHand): number[] {
  const acted = new Set<number>();
  for (const action of hand.actions) {
    if (action.seat !== null) {
      acted.add(action.seat);
    }
  }
  const seated = hand.players.map((player) => player.seat).sort((a, b) => a - b);
  const dealtIn = seated.filter((seat) => acted.has(seat));
  return dealtIn.length >= 2 ? dealtIn : seated;
}

/**
 * The ring for a table whose only blind is posted by the button.
 *
 * GG's short deck is ante-only: everybody antes and the button alone posts a
 * `button blind`. Nobody posts a small or a big blind, so naming two seats
 * `SB` and `BB` would invent blinds that were never paid - and every
 * blind-defence statistic keyed on those names would count seats that had
 * nothing in. The seats are named by their distance from the button instead,
 * as if the two blind seats did not exist: five-handed is `UTG`, `LJ`, `HJ`,
 * `CO`, `BTN`, ending on the button, which is also the blind.
 */
export function buttonBlindRing(n: number): Position[] {
  return n <= 0 ? [] : positionRing(n + 2).slice(2);
}

export function assignPositions(hand: PhfHand): void {
  let smallBlindSeat: number | null = null;
  let bigBlindSeat: number | null = null;
  let buttonBlindSeat: number | null = null;

  for (const action of hand.actions) {
    if (action.seat === null) {
      continue;
    }
    // First posting wins: a late joiner posting a dead blind is typed
    // `missed-blind`, but a site that mislabels one must not move the ring.
    if (action.type === "small-blind" && smallBlindSeat === null) {
      smallBlindSeat = action.seat;
    }
    if (isButtonBlind(action)) {
      buttonBlindSeat ??= action.seat;
    } else if (action.type === "big-blind" && bigBlindSeat === null) {
      bigBlindSeat = action.seat;
    }
  }

  const ringSeats = dealtInSeatsOf(hand);
  const size = ringSeats.length;

  const positions = new Map<number, Position>();
  if (
    size > 0 &&
    buttonBlindSeat !== null &&
    smallBlindSeat === null &&
    bigBlindSeat === null &&
    ringSeats.includes(buttonBlindSeat)
  ) {
    // Anchored on who posted it, like every other blind: the button blind is
    // the last name in the ring, so the ring starts one seat past it.
    const ring = buttonBlindRing(size);
    const start = (ringSeats.indexOf(buttonBlindSeat) + 1) % size;
    for (let offset = 0; offset < size; offset += 1) {
      positions.set(ringSeats[(start + offset) % size], ring[offset]);
    }
  } else if (size > 0) {
    // A dead button - the button sits on a seat nobody is dealt in on, because
    // its occupant left between hands - means there is no button *player*. The
    // rotation still has that slot, so the live seats are named against a ring
    // one longer with the button slot dropped: three live players behind a dead
    // button are SB, BB and CO, not SB, BB and BTN.
    const dead = hasDeadButton(hand, ringSeats);
    const ring = dead ? positionRing(size + 1).slice(0, size) : positionRing(size);
    // ring[0] is the small blind; find which seat that is.
    let start = -1;
    if (smallBlindSeat !== null && ringSeats.includes(smallBlindSeat)) {
      start = ringSeats.indexOf(smallBlindSeat);
    } else if (bigBlindSeat !== null && ringSeats.includes(bigBlindSeat)) {
      // No small blind was posted (a walk, or a dead small blind). The big
      // blind is always ring[1], so step back one to find ring[0].
      start = (ringSeats.indexOf(bigBlindSeat) - 1 + size) % size;
    } else if (hand.table.buttonSeat !== null && ringSeats.includes(hand.table.buttonSeat)) {
      // Bomb pots post no blinds at all; geometry is all there is.
      const buttonIndex = ringSeats.indexOf(hand.table.buttonSeat);
      start = size === 2 ? buttonIndex : (buttonIndex + 1) % size;
    }
    if (start >= 0) {
      for (let offset = 0; offset < size; offset += 1) {
        positions.set(ringSeats[(start + offset) % size], ring[offset]);
      }
    }
  }

  for (const player of hand.players) {
    player.position = positions.get(player.seat) ?? null;
  }
}

/* -------------------------------------------------------------------- game - */

/** A straddle, i.e. a voluntary blind posted out of position before the deal. */

/** Tournament-only metadata. `null` on cash hands. */

/** What actually left the player's account: prize pool + bounty + fee. */
export function totalBuyIn(tournament: PhfTournament): Amount {
  return tournament.buyIn + (tournament.bounty ?? 0) + tournament.fee;
}

/**
 * Splits a printed buy-in token into its components.
 *
 * Rooms write one of three shapes:
 *
 * - `$10`            - a freeroll-ish or fee-inclusive single figure
 * - `$9+$1`          - prize pool + fee
 * - `$4.50+$4.50+$1` - prize pool + bounty + fee (knockout)
 *
 * The fee is always the last component and the bounty, when present, is the
 * middle one. Anything with four or more components is summed into the buy-in
 * except the last, which keeps the fee honest without inventing a meaning for a
 * shape we have not seen.
 */
export function parseBuyInToken(
  token: string,
  unit: CurrencyUnit,
): { buyIn: Amount; bounty: Amount; fee: Amount } {
  if (/freeroll/i.test(token)) {
    return { buyIn: 0, bounty: 0, fee: 0 };
  }
  const parts = token.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { buyIn: 0, bounty: 0, fee: 0 };
  }
  if (parts.length === 1) {
    return { buyIn: parseAmount(parts[0], unit), bounty: 0, fee: 0 };
  }
  const fee = parseAmount(parts[parts.length - 1], unit);
  if (parts.length === 2) {
    return { buyIn: parseAmount(parts[0], unit), bounty: 0, fee };
  }
  if (parts.length === 3) {
    return {
      buyIn: parseAmount(parts[0], unit),
      bounty: parseAmount(parts[1], unit),
      fee,
    };
  }
  return {
    buyIn: parts
      .slice(0, -1)
      .reduce((sum, part) => sum + parseAmount(part, unit), 0),
    bounty: 0,
    fee,
  };
}

/* ----------------------------------------------------------------- players - */

/* ----------------------------------------------------------------- actions - */

/** Posting actions happen before the deal and are animated as one block. */
export function isPostingAction(type: ActionType): boolean {
  return (
    type === "ante" ||
    type === "small-blind" ||
    type === "big-blind" ||
    type === "straddle" ||
    type === "post" ||
    type === "missed-blind" ||
    type === "bomb-ante"
  );
}

/**
 * The verb GG prints for the one blind of an ante-only short-deck table:
 * `Hero: posts button blind $0.02`.
 */
export const BUTTON_BLIND_VERB = "posts button blind";

/**
 * Whether a posting is a button blind rather than an ordinary big blind.
 *
 * **Why a `big-blind` with a verb, not a new `ActionType`.** It *is* the big
 * blind in every way the money cares about: live, the bet everybody else has
 * to match, the seat that gets the option and the walk. Every consumer that
 * asks "was a blind posted" - bomb-pot detection, the walk, cold calls, the
 * replayer's posting block - gets the right answer from the type it already
 * reads, where a new member would be one more case each of them could forget,
 * and a `phf/2` change besides. The single thing that differs is *who* posts
 * it, which only the position ring has to know, and `verb` is already the
 * field that carries a room's own wording through the text round trip.
 */
export function isButtonBlind(action: Pick<PhfAction, "type" | "verb">): boolean {
  return action.type === "big-blind" && action.verb === BUTTON_BLIND_VERB;
}

/* ------------------------------------------------------------------- board - */

/** Resolves runout `index` against runout 0, returning up to five card codes. */
export function resolveRunout(board: PhfBoard, index: number): string[] {
  const base = board.runouts[0];
  const run = board.runouts[index] ?? base;
  if (!run) {
    return [];
  }
  const flop = run.flop ?? base?.flop ?? [];
  const turn = run.turn ?? base?.turn ?? null;
  const river = run.river ?? base?.river ?? null;
  return [...flop, ...(turn ? [turn] : []), ...(river ? [river] : [])];
}

/** Cards of runout `index` visible at the end of `street`. */
export function runoutThroughStreet(board: PhfBoard, index: number, street: Street): string[] {
  const cards = resolveRunout(board, index);
  switch (street) {
    case "flop":
      return cards.slice(0, 3);
    case "turn":
      return cards.slice(0, 4);
    case "river":
    case "showdown":
      return cards.slice(0, 5);
    default:
      return [];
  }
}

/* ---------------------------------------------------------- chip movements - */

/** Chips the house added to the pot, which nobody contributed. */
export function houseIntoPot(hand: PhfHand): Amount {
  return (hand.chipMovements ?? [])
    .filter((movement) => movement.toPot && movement.fromSeat === null)
    .reduce((sum, movement) => sum + movement.amount, 0);
}

/** Chips a seat paid out of its stack without them entering the pot. */
export function seatOutOfPot(hand: PhfHand, seat: number): Amount {
  return (hand.chipMovements ?? [])
    .filter((movement) => !movement.toPot && movement.fromSeat === seat)
    .reduce((sum, movement) => sum + movement.amount, 0);
}

/* ----------------------------------------------------------------- results - */

export const ZERO_FEES: PhfFees = {
  rake: 0,
  jackpot: 0,
  bingo: 0,
  fortune: 0,
  tax: 0,
  other: 0,
};

export function totalFees(fees: PhfFees): Amount {
  return fees.rake + fees.jackpot + fees.bingo + fees.fortune + fees.tax + fees.other;
}

/** How a player's hand ended, as reported by the summary block. */

/* -------------------------------------------------------------------- meta - */

export const DEFAULT_TEXT_STYLE: PhfTextStyle = {
  decimals: "minimal",
  dealtLinesForAllPlayers: false,
  showdownSection: true,
  holeCardsSection: true,
  showdownLabels: [""],
  runItTwiceNote: false,
  padHour: true,
};

/* -------------------------------------------------------------------- hand - */

/* ----------------------------------------------------------------- helpers - */

export function heroOf(hand: PhfHand): PhfPlayer | null {
  return hand.players.find((player) => player.isHero) ?? null;
}

export function playerBySeat(hand: PhfHand, seat: number): PhfPlayer | undefined {
  return hand.players.find((player) => player.seat === seat);
}

export function playerByName(hand: PhfHand, name: string): PhfPlayer | undefined {
  return hand.players.find((player) => player.name === name);
}

/** Primary runout, the one the replayer shows by default. */
export function primaryBoard(hand: PhfHand): string[] {
  return resolveRunout(hand.board, 0);
}

/** Second runout, or an empty array when the hand was run once. */
export function secondBoard(hand: PhfHand): string[] {
  return hand.board.runouts.length > 1 ? resolveRunout(hand.board, 1) : [];
}

/**
 * Every card dealt in the hand, each counted once.
 *
 * Run-it-twice runouts share the streets they did not re-deal, so only the
 * streets a later runout actually re-dealt are counted; resolving each runout
 * in full would report a shared flop three times.
 */
export function allCards(hand: PhfHand): string[] {
  const cards: string[] = [];
  for (const player of hand.players) {
    cards.push(...player.holeCards);
  }
  for (let i = 0; i < hand.board.runouts.length; i += 1) {
    const run = hand.board.runouts[i];
    const resolved = resolveRunout(hand.board, i);
    if (i === 0) {
      cards.push(...resolved);
      continue;
    }
    if (run.flop) {
      cards.push(...resolved.slice(0, 3));
    }
    if (run.turn) {
      cards.push(run.turn);
    }
    if (run.river) {
      cards.push(run.river);
    }
  }
  return cards;
}

/** Total each player put in, net of uncalled returns, straight from the stream. */
export function contributionsFromActions(hand: PhfHand): Map<string, Amount> {
  const out = new Map<string, Amount>();
  for (const action of hand.actions) {
    if (action.type === "collect" || action.type === "cashout-pay") {
      continue;
    }
    if (action.amount === 0) {
      continue;
    }
    out.set(action.player, (out.get(action.player) ?? 0) + action.amount);
  }
  return out;
}
