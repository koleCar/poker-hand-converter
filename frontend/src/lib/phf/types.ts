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

/** Schema tag stamped on every hand. See `docs/PHF-SPEC.md` for the versioning policy. */
export const PHF_SCHEMA = "phf/1" as const;
export type PhfSchema = typeof PHF_SCHEMA;

/* ------------------------------------------------------------------ money - */

/**
 * An amount of money or chips, expressed in **integer minor units**.
 *
 * The unit is not carried on the value itself (that would bloat every action);
 * it lives once on `PhfHand.game.unit` and, for buy-ins, on
 * `PhfTournament.buyInUnit`.
 */
export type Amount = number;

/**
 * Describes what the integers in a hand mean.
 *
 * `minorUnits` is the divisor used to go from the stored integer to the number
 * a human reads: cash tables use 100 (cents), tournament chips use 1 because a
 * chip is already indivisible.
 */
export interface CurrencyUnit {
  /** ISO-ish code. "USD" / "EUR" / "GBP" / "CHIPS" / "TCHIP" for play money. */
  code: string;
  /** What gets printed in front of the number; empty string for chips. */
  symbol: string;
  /** Minor units per display unit: 100 for cash, 1 for chips. */
  minorUnits: number;
  /** Chips never convert to real money inside the hand; cash does. */
  kind: "cash" | "chips";
}

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

/**
 * How a site prints fractional amounts.
 *
 * GG writes `$0.5`, WePlay writes `$0.50`. Both are "the same" number, but
 * Holdem Manager import is byte sensitive and our own round-trip tests compare
 * text, so the choice has to survive the trip through PHF.
 */
export type DecimalStyle = "minimal" | "fixed2";

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

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river", "showdown"];

/**
 * Game variants. Round one only ships a Hold'em parser, but the type system has
 * to be able to *express* the others so adding a PLO parser later is a new file
 * rather than a schema migration.
 */
export type Variant =
  | "holdem"
  | "omaha"
  | "omaha5"
  | "omaha6"
  | "shortdeck"
  | "stud"
  | "razz"
  | "draw"
  | "other";

export type LimitType = "nl" | "pl" | "fl";

export type GameFormat = "cash" | "tournament" | "sng" | "spin";

/**
 * Who pays the ante and how.
 *
 * This is not cosmetic: `big-blind-ante` means one player posts for the table,
 * which changes both the chip-conservation check and how the replayer animates
 * the posting round.
 */
export type AnteModel = "none" | "posted-per-player" | "big-blind-ante" | "button-ante";

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
 * Resolved table position. `MP` is the catch-all for the middle seats of a full
 * ring table; everything else is the seat name players and trackers actually
 * use, so filters like "3-bet from the CO" become a plain equality test.
 */
export type Position =
  | "BTN"
  | "SB"
  | "BB"
  | "UTG"
  | "UTG+1"
  | "UTG+2"
  | "MP"
  | "LJ"
  | "HJ"
  | "CO";

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
export function assignPositions(hand: PhfHand): void {
  const acted = new Set<number>();
  let smallBlindSeat: number | null = null;
  let bigBlindSeat: number | null = null;

  for (const action of hand.actions) {
    if (action.seat === null) {
      continue;
    }
    acted.add(action.seat);
    // First posting wins: a late joiner posting a dead blind is typed
    // `missed-blind`, but a site that mislabels one must not move the ring.
    if (action.type === "small-blind" && smallBlindSeat === null) {
      smallBlindSeat = action.seat;
    }
    if (action.type === "big-blind" && bigBlindSeat === null) {
      bigBlindSeat = action.seat;
    }
  }

  const seated = hand.players.map((player) => player.seat).sort((a, b) => a - b);
  // Anyone who put a chip in or made a move was dealt in. Fall back to the full
  // seat list when the stream is too thin to tell (a hand with no actions).
  const dealtIn = seated.filter((seat) => acted.has(seat));
  const ringSeats = dealtIn.length >= 2 ? dealtIn : seated;
  const size = ringSeats.length;

  const positions = new Map<number, Position>();
  if (size > 0) {
    const ring = positionRing(size);
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
export interface PhfStraddle {
  seat: number;
  player: string;
  amount: Amount;
  /** 1 = first straddle (usually UTG), 2 = re-straddle, and so on. */
  order: number;
}

/**
 * Bomb pot descriptor. In a bomb pot everybody antes a fixed amount, no blinds
 * are posted and the flop is dealt immediately, so the normal "preflop betting
 * round" invariants do not apply and the validator has to know.
 */
export interface PhfBombPot {
  /** Ante each player put in. */
  ante: Amount;
  /** Bomb pots usually skip straight to the flop. */
  dealtToStreet: Street;
  /** Some rooms run double-board bomb pots. */
  doubleBoard: boolean;
}

export interface PhfGame {
  variant: Variant;
  limit: LimitType;
  format: GameFormat;
  /** Unit for every `Amount` in this hand outside the tournament buy-in. */
  unit: CurrencyUnit;
  smallBlind: Amount;
  bigBlind: Amount;
  anteModel: AnteModel;
  /** Ante per player under `posted-per-player`, or the single posted ante otherwise. */
  ante: Amount;
  straddles: PhfStraddle[];
  bombPot: PhfBombPot | null;
  /** Verbatim game label from the source, e.g. "Hold'em No Limit". */
  label: string;
}

export interface PhfTable {
  name: string | null;
  maxSeats: number;
  buttonSeat: number | null;
}

/** Tournament-only metadata. `null` on cash hands. */
export interface PhfTournament {
  id: string;
  name: string | null;
  /**
   * Buy-in and fee are *real money* even when the stacks are chips.
   *
   * `buyIn` is the prize-pool contribution only. A knockout tournament writes
   * its buy-in as three components - `$4.50+$4.50+$1` is prize pool, bounty,
   * fee - and collapsing the bounty into the buy-in would overstate what the
   * player paid for equity in the prize pool, which is the number ROI is
   * computed against. Use `totalBuyIn()` for what actually left the account.
   */
  buyIn: Amount;
  /**
   * The knockout portion of the buy-in, i.e. what goes on the player's own head.
   *
   * Zero (or absent) for a non-knockout tournament. Optional so that parsers
   * written before this field existed keep compiling; read it as `?? 0`.
   */
  bounty?: Amount;
  fee: Amount;
  buyInUnit: CurrencyUnit;
  /** Level as printed ("XI", "12"), plus the parsed number when we can get one. */
  levelLabel: string | null;
  levelNumber: number | null;
  /** Blinds the level header advertises; may differ from what was posted. */
  levelSmallBlind: Amount;
  levelBigBlind: Amount;
  levelAnte: Amount;
  /** Progressive-knockout bounties, by player. */
  bounties: Array<{ player: string; amount: Amount }>;
}

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

export interface PhfPlayer {
  seat: number;
  name: string;
  startingStack: Amount;
  isHero: boolean;
  /**
   * Hole cards when known. Empty means unknown, which is the normal case for
   * villains who never showed. Length is variant dependent (2 for Hold'em, 4-6
   * for Omaha), so never index blindly.
   */
  holeCards: string[];
  /** PKO bounty carried by this player, when the site reports it. */
  bounty: Amount | null;
  sittingOut: boolean;
  /** Resolved from seat + button + table size; null when the button is unknown. */
  position: Position | null;
  /**
   * The source printed a "Dealt to <player>" line for this seat. GG prints one
   * per seated player, WePlay only for the hero; the serializer needs to know
   * which shape to emit.
   */
  dealtAnnounced: boolean;
  /**
   * Cards the *deal block* showed, which is not the same thing as `holeCards`.
   *
   * GG writes `Dealt to villain ` with no cards and only reveals them in the
   * summary; `holeCards` therefore ends up populated while the deal line must
   * still be re-emitted empty. Keeping the two apart is what makes the text
   * round trip exact, and it also tells the replayer which hands were visible
   * from the start versus revealed later.
   */
  dealtCards: string[];
}

/* ----------------------------------------------------------------- actions - */

/**
 * Action vocabulary. A superset of the old `ActionType` union: everything the
 * previous parser could express still round-trips, plus the posting variants
 * and the GG EV-cashout events that used to be silently dropped.
 */
export type ActionType =
  | "ante"
  | "small-blind"
  | "big-blind"
  | "straddle"
  | "post"
  | "missed-blind"
  | "bomb-ante"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "uncalled"
  | "show"
  | "muck"
  | "collect"
  | "cashout-choose"
  | "cashout-pay";

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

export interface PhfAction {
  /** Position in the stream; stable across serialization. */
  index: number;
  street: Street;
  /**
   * Which runout this action belongs to. Only collects and shows after a
   * run-it-twice ever use a value > 0; everything else is 0.
   */
  runoutIndex: number;
  /** Seat of the actor, or `null` for dealer-side events. */
  seat: number | null;
  player: string;
  type: ActionType;
  /**
   * Chips this action moves into the pot. Negative for an uncalled return,
   * which is what keeps the chip-conservation sum honest.
   */
  amount: Amount;
  /** Total the actor has committed on this street after the action. */
  streetTotal: Amount;
  allIn: boolean;
  /** Cards revealed by this action (shows). */
  cards?: string[];
  /** Showdown hand description, e.g. "a pair of Aces". */
  description?: string;
  /**
   * The literal verb the source used, when it differs from the canonical one.
   *
   * WePlay writes `Kadiddy: posts straddle $4` where the standard text says
   * `posts $4`. The action type is what code should branch on; this keeps the
   * wording so the text round-trips.
   */
  verb?: string;
  /** Which pot a collect came from: "pot", "main pot", "side pot", ... */
  potName?: string;
  /** Human readable label; the replayer log renders this verbatim. */
  label: string;
  /** 1-based line number inside the raw hand text, for debugging. */
  sourceLine: number | null;
  /** The source line this action came from. */
  rawLine: string;
}

/* ------------------------------------------------------------------- board - */

/**
 * One runout of the community cards.
 *
 * A `null` street means "identical to runout 0". That is exactly how sites
 * print it (`SECOND TURN` appears but `SECOND FLOP` does not when the flop is
 * shared), and it lets the serializer reproduce the source without guessing.
 */
export interface PhfRunout {
  index: number;
  flop: string[] | null;
  turn: string | null;
  river: string | null;
  /**
   * Literal prefix the source printed on each street marker for this runout
   * ("", "FIRST", "SECOND").
   *
   * Sites are inconsistent: GG labels both runouts, WePlay leaves a shared
   * street unlabelled and only marks the one it re-dealt. The prefix carries no
   * information the index does not, but reproducing it is what keeps imported
   * text byte-identical on the way back out. Empty for parsers that build a
   * hand from scratch; the serializer then derives a label.
   */
  markerLabels: { flop?: string; turn?: string; river?: string };
  /**
   * Cards the SUMMARY `Board` line listed for this runout, verbatim.
   *
   * GG lists only the cards that differ from runout 0, WePlay repeats the whole
   * board. Same reasoning as `markerLabels`: kept for faithful output, never
   * read as data - use `resolveRunout` for that.
   */
  summaryCards: string[] | null;
}

export interface PhfBoard {
  /** Always at least one entry. Two entries means the hand was run twice. */
  runouts: PhfRunout[];
}

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

/* ----------------------------------------------------------------- results - */

/**
 * Fees taken out of the pot, broken out rather than lumped into one `rake`
 * number, because the GG summary line reports them separately and win-rate math
 * needs to be able to add back the ones that are promotional.
 */
export interface PhfFees {
  rake: Amount;
  jackpot: Amount;
  bingo: Amount;
  fortune: Amount;
  tax: Amount;
  /** Anything a site reports that does not map to the above. */
  other: Amount;
}

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
export type SeatOutcome =
  | "folded"
  | "collected"
  | "won"
  | "lost"
  | "mucked"
  | "showed"
  | "unknown";

export interface PhfPlayerResult {
  seat: number;
  player: string;
  /** Total chips collected from all pots. */
  won: Amount;
  /** Total chips put in, net of uncalled returns. */
  contributed: Amount;
  /** `won - contributed`. Negative for a loser. */
  net: Amount;
  wentToShowdown: boolean;
  /** Cards this player revealed (showdown or summary). */
  shownCards: string[];
  mucked: boolean;
  handDescription: string | null;
  /**
   * Position words exactly as the summary prints them, e.g. `["(button)"]` or
   * `["(button)", "(small blind)"]` heads-up. The machine-readable position
   * lives on `PhfPlayer.position`; this is here for byte-faithful output.
   */
  positionLabels: string[];
  outcome: SeatOutcome;
  foldedStreet: Street | null;
  /** Summary said "(didn't bet)": folded without putting a chip in voluntarily. */
  didntBet: boolean;
  /** GG EV-cashout risk paid by this player, settled outside the pot. */
  cashoutRisk: Amount | null;
  /**
   * The summary line verbatim.
   *
   * The summary block is site-authored prose ("showed [Ah Kd] and won ($12)
   * with two pair, Aces and Fours, and lost") whose exact wording carries no
   * information the structured fields lack. Keeping the original string lets
   * `toStandardText` reproduce imported text byte for byte - which Holdem
   * Manager import depends on - without forcing every future parser to
   * replicate one site's phrasing. Parsers that build a hand from scratch leave
   * this `null` and the serializer generates a canonical line.
   */
  raw: string | null;
}

export interface PhfResults {
  /** Pot before fees, as the source reports it. */
  totalPot: Amount;
  /**
   * Side-pot breakdown when the source reports one, e.g.
   * `[{ name: "Main", amount: 3715 }, { name: "Side", amount: 6596 }]`.
   * Empty when everything went into a single pot.
   */
  pots: Array<{ name: string; amount: Amount }>;
  fees: PhfFees;
  players: PhfPlayerResult[];
  /** Flattened winner list; one entry per collect, per runout. */
  winners: Array<{ player: string; seat: number | null; amount: Amount; runoutIndex: number }>;
  /** Hero's `net`, or null when there is no hero. */
  heroNet: Amount | null;
  wentToShowdown: boolean;
  /** Furthest street the hand actually reached. */
  streetReached: Street;
}

/* -------------------------------------------------------------------- meta - */

export interface PhfWarning {
  /** Short machine code, e.g. "unknown-line". */
  code: string;
  message: string;
  /** 1-based line number in the raw text when the warning is line-scoped. */
  line?: number;
}

/**
 * Purely presentational choices that a site makes and that therefore have to
 * survive a round trip through PHF. None of these affect the meaning of a hand.
 */
export interface PhfTextStyle {
  /** `$0.5` (GG) versus `$0.50` (WePlay and most others). */
  decimals: DecimalStyle;
  /** The source prints a `Dealt to` line for every seated player, not just the hero. */
  dealtLinesForAllPlayers: boolean;
  /** The source printed an explicit `*** SHOWDOWN ***` section. */
  showdownSection: boolean;
  /** The source printed `*** HOLE CARDS ***`. */
  holeCardsSection: boolean;
  /**
   * Prefixes of the showdown markers the source printed, in order. `[""]` is a
   * single `*** SHOWDOWN ***`; `["FIRST", "SECOND"]` is a run-it-twice that
   * settled each runout separately.
   */
  showdownLabels: string[];
  /** The SUMMARY block carried a "Hand was run two times" note. */
  runItTwiceNote: boolean;
  /**
   * The source zero-pads the hour in the header timestamp.
   *
   * GG writes `05:56:01`, WePlay writes `8:34:11`. Undetectable from a hand
   * dealt after 09:59, which is harmless: both styles render those identically.
   */
  padHour: boolean;

  /*
   * The fields below are *optional and tri-state*: `true`/`false` pin the
   * choice, `undefined` means "work it out from `meta.rawText`".
   *
   * That matters because eleven site parsers build `PhfHand` objects by hand,
   * and every one of them spreads `DEFAULT_TEXT_STYLE`. A required field would
   * silently take its default in all of them and the output would be wrong for
   * whichever rooms do not match that default. Leaving them undefined lets
   * `resolveTextStyle` recover the answer from the source the hand already
   * carries, so a parser only has to think about presentation when it wants to
   * override what its own source text plainly says.
   */

  /** Digit grouping in amounts: `21,929` (GG tournaments) versus `21929`. */
  groupThousands?: boolean;
  /**
   * A `Dealt to <player>` line with no cards ends with a trailing space.
   *
   * GG's cash exports write `Dealt to villain ` and its tournament exports
   * write `Dealt to villain`. Trackers match on the line, so the difference has
   * to survive.
   */
  dealtLineTrailingSpace?: boolean;
  /**
   * Fee columns on the `Total pot` line, in order, excluding the pot itself.
   *
   * Rooms print anywhere from one to five: `["Rake"]`,
   * `["Rake", "Jackpot", "Bingo"]`, or the full GG cash set
   * `["Rake", "Jackpot", "Bingo", "Fortune", "Tax"]`.
   */
  summaryFeeColumns?: string[];
  /**
   * The header text after `Poker Hand #<id>: `, verbatim.
   *
   * The header is one line of per-room prose - GG writes
   * `Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)`,
   * PokerStars writes `Tournament #257640000, $20+$1 USD Hold'em No Limit - Match Round I, Level IV (50/100)`,
   * WePlay writes `Tournament (Name)#id, $15+$1.50 ...` - and the variation
   * includes things like an incidental triple space that no structured field
   * should ever have to model. Capturing it keeps imported text byte-exact
   * without coupling this serializer to every room, which is the whole point of
   * the parser plugin architecture.
   *
   * Authoritative data still lives in `PhfHand.tournament` and `PhfHand.game`;
   * this is replayed only when it demonstrably belongs to the same hand, and a
   * hand built from scratch gets a generated header instead.
   */
  headerPayload?: string;
}

export const DEFAULT_TEXT_STYLE: PhfTextStyle = {
  decimals: "minimal",
  dealtLinesForAllPlayers: false,
  showdownSection: true,
  holeCardsSection: true,
  showdownLabels: [""],
  runItTwiceNote: false,
  padHour: true,
};

export interface PhfMeta {
  /** Registry id of the site the hand came from, e.g. "weplay". */
  siteId: string;
  /** Display name for the UI. */
  siteName: string;
  /** Hand id exactly as the site wrote it. */
  handId: string;
  /**
   * Stable dedupe key.
   *
   * Kept equal to `handId` for the sites we already store so that re-uploading
   * a file that was imported before the PHF rewrite still dedupes against the
   * existing `stored_hands.hand_key` rows.
   */
  handKey: string;
  originalFilename: string | null;
  parserId: string;
  parserVersion: string;
  warnings: PhfWarning[];
  /** The hand's own slice of the uploaded file. Never lose the source. */
  rawText: string;
  /** ISO timestamp of when we parsed it (not when it was played). */
  parsedAt: string;
  textStyle: PhfTextStyle;
}

/* -------------------------------------------------------------------- hand - */

export interface PhfHand {
  schema: PhfSchema;
  meta: PhfMeta;
  game: PhfGame;
  table: PhfTable;
  tournament: PhfTournament | null;
  players: PhfPlayer[];
  actions: PhfAction[];
  board: PhfBoard;
  results: PhfResults;
  /** ISO timestamp the hand was dealt, or null when the source omits it. */
  playedAt: string | null;
}

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
