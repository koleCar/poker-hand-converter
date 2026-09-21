/**
 * Shared machinery for the PokerStars-family text grammars.
 *
 * PokerStars invented the `Seat N: name ($x in chips)` / `*** FLOP *** [..]` /
 * `*** SUMMARY ***` shape, and GGPoker (plus everything downstream of it,
 * including this app's own standard text) is a dialect of it. The *semantics*
 * are therefore genuinely shared: how a `raises X to Y` becomes chips added, how
 * an uncalled return nets out of a street commitment, how the SUMMARY prose maps
 * onto `PhfPlayerResult`, how runouts are assembled.
 *
 * The *syntax* is not shared, and deliberately is not shared here. There is no
 * line dispatcher in this file: `pokerstars.ts` and `ggpoker.ts` each own their
 * own loop over the source lines and call into the draft below. That is what
 * keeps a PokerStars quirk (`and has reached the $40 cap`, `Hand was run twice`)
 * out of GG output and a GG quirk (`Chooses to EV Cashout`, the six-column fee
 * line) out of PokerStars output.
 *
 * Owned by parser agent 1, which maintains it for `pokerstars.ts` and
 * `ggpoker.ts`. Other rooms in the Stars family read it too - `coinpoker.ts`,
 * `fulltilt.ts` and `shared/p3-draft.ts` - so treat anything exported here as a
 * shared contract: it may be extended, but a change in the meaning of an
 * existing helper needs those callers checked first.
 */

import { extractCards, parseCard } from "../../cards";
import {
  CHIPS,
  PHF_SCHEMA,
  ZERO_FEES,
  formatAmount,
  parseAmount,
  resolveRunout,
  unitForSymbol,
  type ActionType,
  type Amount,
  type CurrencyUnit,
  type GameFormat,
  type LimitType,
  type PhfAction,
  type PhfBoard,
  type PhfChipMovement,
  type PhfFees,
  type PhfHand,
  type PhfPlayer,
  type PhfPlayerResult,
  type PhfRunout,
  type PhfStraddle,
  type PhfTextStyle,
  type PhfTournament,
  type PhfWarning,
  type SeatOutcome,
  type Street,
  type Variant,
} from "../../phf/types";

/* ------------------------------------------------------------- text helpers */

/**
 * Splits text into lines.
 *
 * PokerStars exports exist with CRLF, LF **and** bare CR line endings - see
 * `fixtures/samples/pokerstars/11-cash-nlhe-gbp-currency-cr-only-lineendings.txt`,
 * which is a single `\r`-separated blob. A `/\r?\n/` split turns that whole file
 * into one line and the hand silently disappears.
 */
export function toLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Normalizes line endings without touching anything else. */
export function normalizeNewlines(text: string): string {
  return toLines(text).join("\n");
}

/** Strips a UTF-8 BOM, which PokerStars writes at the head of every export. */
export function stripBom(text: string): string {
  return text.replace(/^﻿/, "");
}

/**
 * Money capture used by every amount-bearing regex in the family.
 *
 * Deliberately permissive about the symbol: a currency we cannot represent has
 * to be refused at the header, not by quietly failing to match every line - a
 * hand whose action lines all miss would parse to an empty stream, balance at
 * zero against a pot of zero, and validate.
 */
export const MONEY = String.raw`(?:\$|€|£|¥|₩|R\$|Rs\.?)?\s?([\d,]+(?:\.\d+)?)`;

/** First currency symbol in the text; "" means chips or play money. */
export function symbolIn(text: string): string {
  if (text.includes("€")) return "€";
  if (text.includes("£")) return "£";
  if (text.includes("$")) return "$";
  return "";
}

/** Symbols `MONEY` accepts but `unitForSymbol` cannot turn into a unit. */
const UNSUPPORTED_SYMBOL = /¥|₩|Rs\.?\s?\d/;

/** True when the text prices a hand in a currency PHF has no unit for. */
export function hasUnsupportedCurrency(text: string): boolean {
  return UNSUPPORTED_SYMBOL.test(text);
}

/**
 * The currency unit for a header's stakes text.
 *
 * The three-letter code wins when the header states one, because `$` is shared
 * by USD and CAD and the code is the only thing that tells them apart. Returns
 * `null` for a currency we cannot represent, which the caller turns into a
 * `ParseSkip` rather than a silently mis-scaled hand.
 */
export function unitForStakes(stakesText: string, chips: CurrencyUnit): CurrencyUnit | null {
  if (UNSUPPORTED_SYMBOL.test(stakesText)) {
    return null;
  }
  const symbol = symbolIn(stakesText);
  if (!symbol) {
    // No symbol at all: tournament chips and play money both print bare numbers.
    return chips;
  }
  const code = stakesText.match(/\b(USD|EUR|GBP|CAD|AUD|NZD|CNY|NOK|SEK|DKK|PLN|RUB|INR|BRL)\b/);
  if (code) {
    return { code: code[1], symbol, minorUnits: 100, kind: "cash" };
  }
  return unitForSymbol(symbol);
}

/**
 * The unit a tournament buy-in is denominated in.
 *
 * A buy-in with no currency symbol at all is **play money**, not dollars:
 * `Tournament #518183000, 2000+110 Hold'em No Limit`
 * (`fixtures/samples/pokerstars/37-...`) is a 2000-chip play tournament, and
 * defaulting a symbol-less token to `$` turns it into a $2,000 buy-in with a
 * $110 fee - a hundredfold error on the one number ROI is computed from, in a
 * hand that otherwise validates perfectly.
 *
 * `code` is the header's own three-letter code when it prints one, because `$`
 * alone does not distinguish USD from CAD.
 */
export function buyInUnitFor(token: string, code: string | undefined): CurrencyUnit {
  const symbol = symbolIn(token);
  if (!symbol) {
    return CHIPS;
  }
  return code
    ? { code, symbol, minorUnits: 100, kind: "cash" }
    : unitForSymbol(symbol);
}

/**
 * Whether a source writes `$0.50` or `$0.5`.
 *
 * Decided from the whole hand rather than one token: a hand full of round
 * numbers carries no evidence either way, and guessing wrong flips every
 * fractional amount in the output. PokerStars is `fixed2`, GG is `minimal`.
 */
export function detectDecimals(text: string): "minimal" | "fixed2" {
  if (/\d\.\d0(?!\d)/.test(text)) {
    return "fixed2";
  }
  if (/\d\.\d(?!\d)/.test(text)) {
    return "minimal";
  }
  return "fixed2";
}

/** Detects whether the header zero-pads the hour. Ambiguous input keeps `true`. */
export function detectPadHour(payload: string): boolean {
  const match = payload.match(/\d{4}[/-]\d{2}[/-]\d{2}[ T](\d{1,2}):\d{2}:\d{2}/);
  return match ? match[1].length === 2 : true;
}

/**
 * Reads the timestamp out of a header payload.
 *
 * Both rooms print local time and, for PokerStars, often a second bracketed
 * `[... ET]` copy. We keep the **first** timestamp and treat it as UTC, which is
 * what `parseStandardHand` does for GG and WePlay; converting the named zone
 * would need a tz database we do not ship, and mixing conventions across
 * parsers would make two hands from the same session sort wrongly.
 */
export function parsePlayedAt(payload: string): string | null {
  const match = payload.match(/(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function variantFromLabel(label: string): Variant {
  // GG names the big-O variants `PLO`, `PLO-5`, `PLO-6`; the suffix is the
  // number of hole cards, so it has to be read before the generic Omaha test.
  if (/6\s*card\s*omaha|omaha\s*6|\bPLO-?6\b/i.test(label)) return "omaha6";
  if (/5\s*card\s*omaha|omaha\s*5|\bPLO-?5\b/i.test(label)) return "omaha5";
  if (/omaha|\bPLO\b|\bNLO\b/i.test(label)) return "omaha";
  if (/short\s*deck|6\+/i.test(label)) return "shortdeck";
  if (/\brazz\b/i.test(label)) return "razz";
  if (/\bstud\b/i.test(label)) return "stud";
  if (/\bdraw\b|badugi/i.test(label)) return "draw";
  if (/hold\s*'?em/i.test(label)) return "holdem";
  return "other";
}

export function limitFromLabel(label: string): LimitType {
  if (/pot\s*limit|\bPL\b/i.test(label)) return "pl";
  if (/no\s*limit|\bNL\b/i.test(label)) return "nl";
  if (/\blimit\b/i.test(label)) return "fl";
  return "nl";
}

/** Roman or arabic level label to a number; null when it is neither. */
export function levelNumberOf(label: string): number | null {
  if (/^\d+$/.test(label)) {
    return Number(label);
  }
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const upper = label.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) {
    return null;
  }
  let total = 0;
  for (let i = 0; i < upper.length; i += 1) {
    total += values[upper[i]] < (values[upper[i + 1]] ?? 0) ? -values[upper[i]] : values[upper[i]];
  }
  return total;
}

/* ------------------------------------------------------- summary seat lines */

/**
 * Parses one SUMMARY `Seat N: ...` line.
 *
 * The prose is identical across the family - PokerStars wrote it and GG copied
 * it - so this lives here rather than in either parser. Everything it cannot
 * classify stays available on `raw`.
 */
export function parseSummarySeat(
  raw: string,
  playerName: string,
  unit: CurrencyUnit,
): Partial<PhfPlayerResult> {
  let rest = raw.trim().replace(/^Seat\s+\d+:\s*/, "");
  if (rest.startsWith(playerName)) {
    rest = rest.slice(playerName.length);
  }
  rest = rest.replace(/^\s+/, "");

  const positionLabels: string[] = [];
  for (;;) {
    const match = rest.match(/^\((button|small blind|big blind)\)\s*/i);
    if (!match) {
      break;
    }
    positionLabels.push(`(${match[1]})`);
    rest = rest.slice(match[0].length);
  }

  const out: Partial<PhfPlayerResult> = {
    positionLabels,
    raw,
    outcome: "unknown",
    foldedStreet: null,
    didntBet: false,
    shownCards: [],
    handDescription: null,
    mucked: false,
    cashoutRisk: null,
  };

  const shown = rest.match(/(?:showed|mucked)\s+\[([^\]]*)\]/i);
  if (shown) {
    out.shownCards = extractCards(shown[1]);
  }

  // GG only: the EV-cashout premium the seat paid, reported outside the pot.
  const cashout = rest.match(new RegExp(String.raw`Cashout Risk \(${MONEY}\)`));
  if (cashout) {
    out.cashoutRisk = parseAmount(cashout[1], unit);
  }

  const folded = rest.match(/^folded\s+(?:before Flop|on the (Flop|Turn|River))/i);
  if (folded) {
    out.outcome = "folded";
    out.foldedStreet = folded[1] ? (folded[1].toLowerCase() as Street) : "preflop";
    out.didntBet = /\(didn't bet\)/i.test(rest);
    return out;
  }

  if (/^mucked\b/i.test(rest)) {
    out.outcome = "mucked";
    out.mucked = true;
    return out;
  }

  const won = rest.match(new RegExp(String.raw`(?:won|collected)\s+\(${MONEY}\)`));
  const description = rest.match(
    /\bwith\s+(.+?)(?:,\s+(?:and\s+)?(?:won|lost|Cashout Risk)\b.*)?$/i,
  );
  if (description) {
    out.handDescription = description[1].replace(/,\s*$/, "");
  }

  if (/^showed\b/i.test(rest)) {
    out.outcome = won ? "won" : "lost";
    return out;
  }
  if (won) {
    out.outcome = /\bcollected\b/i.test(rest) ? "collected" : "won";
    return out;
  }
  return out;
}

/* --------------------------------------------------------------- the draft */

interface RunoutDraft {
  flop: string[] | null;
  turn: string | null;
  river: string | null;
}

export interface DraftGame {
  variant: Variant;
  limit: LimitType;
  format: GameFormat;
  label: string;
  unit: CurrencyUnit;
  smallBlind: Amount;
  bigBlind: Amount;
}

export interface DraftInit {
  siteId: string;
  siteName: string;
  parserId: string;
  parserVersion: string;
  handId: string;
  /** Stable dedupe key; usually the site id prefixed so ids cannot collide. */
  handKey: string;
  rawText: string;
  originalFilename: string | null;
  game: DraftGame;
  tournament: PhfTournament | null;
  playedAt: string | null;
  textStyle: PhfTextStyle;
  /**
   * Reconstruct an `Uncalled bet (x) returned to y` line the source omitted.
   *
   * Off by default and opted into per site, so the repair cannot leak into a
   * room that never needs it. See `reconstructUncalled` for the three conditions
   * that have to hold before anything is inserted.
   */
  repairMissingUncalled?: boolean;
}

export type MarkerKind = "flop" | "turn" | "river" | "showdown";

/**
 * Accumulates one hand and, at `build()`, resolves everything that can only be
 * known once the whole hand has been read: positions, the board, contributions,
 * and the results block.
 *
 * Callers push *semantic* events. Nothing in here knows what a source line looks
 * like.
 */
export class StarsHandDraft {
  readonly warnings: PhfWarning[] = [];

  private readonly init: DraftInit;
  private readonly players: PhfPlayer[] = [];
  private readonly byName = new Map<string, PhfPlayer>();
  private readonly actions: PhfAction[] = [];
  private readonly runouts: RunoutDraft[] = [{ flop: null, turn: null, river: null }];
  private readonly markerLabels: Array<{ flop?: string; turn?: string; river?: string }> = [{}];
  private readonly summaryBoards = new Map<number, string[]>();
  private readonly summarySeatLines = new Map<number, string>();
  private readonly collectedBy = new Map<string, Amount>();
  private readonly folded = new Set<string>();
  private readonly straddles: Array<{ player: string; amount: Amount }> = [];
  private readonly movements: PhfChipMovement[] = [];
  private readonly showdownLabels: string[] = [];
  private readonly pots: Array<{ name: string; amount: Amount }> = [];

  private streetCommit = new Map<string, Amount>();
  private street: Street = "preflop";
  private runoutIndex = 0;
  private tableName: string | null = null;
  private maxSeats = 0;
  private buttonSeat: number | null = null;
  private fastFold: string | null = null;
  private heroName: string | null = null;
  private totalPot: Amount = 0;
  private sawSummaryPot = false;
  private fees: PhfFees = { ...ZERO_FEES };
  private anteMax: Amount = 0;
  private antePosters = 0;
  private sawShowdownMarker = false;
  private sawHoleCardsMarker = false;
  private dealtLineCount = 0;
  private runItTwiceNote = false;
  private smallBlindPosted: Amount = 0;
  private bigBlindPosted: Amount = 0;

  constructor(init: DraftInit) {
    this.init = init;
  }

  get unit(): CurrencyUnit {
    return this.init.game.unit;
  }

  /** Every seated name, for the "did this actor exist?" checks the sites need. */
  seatedNames(): Set<string> {
    return new Set(this.byName.keys());
  }

  isSeated(name: string): boolean {
    return this.byName.has(name);
  }

  currentStreet(): Street {
    return this.street;
  }

  warn(code: string, message: string, line?: number): void {
    this.warnings.push(line === undefined ? { code, message } : { code, message, line });
  }

  /* ------------------------------------------------------------- structure */

  setTable(
    name: string | null,
    maxSeats: number,
    buttonSeat: number | null,
    fastFold: string | null = null,
  ): void {
    this.tableName = name;
    this.maxSeats = maxSeats;
    this.buttonSeat = buttonSeat;
    this.fastFold = fastFold;
  }

  seat(seat: number, name: string, stack: Amount, sittingOut = false): void {
    if (this.byName.has(name)) {
      this.warn("duplicate-seat-line", `${name} is listed twice in the seat block.`);
      return;
    }
    const player: PhfPlayer = {
      seat,
      name,
      startingStack: stack,
      isHero: false,
      holeCards: [],
      bounty: null,
      sittingOut,
      position: null,
      dealtAnnounced: false,
      dealtCards: [],
    };
    this.players.push(player);
    this.byName.set(name, player);
  }

  markSittingOut(name: string): void {
    const player = this.byName.get(name);
    if (player) {
      player.sittingOut = true;
    }
  }

  setBounty(name: string, amount: Amount): void {
    const player = this.byName.get(name);
    if (player) {
      player.bounty = (player.bounty ?? 0) + amount;
    }
  }

  /** The source printed `*** HOLE CARDS ***`. */
  holeCardsMarker(): void {
    this.sawHoleCardsMarker = true;
  }

  /**
   * A `Dealt to <name> [cards]` line. GG prints one per seat with no cards for
   * the villains, so an empty `cards` is meaningful and is kept apart from
   * `holeCards` - see `PhfPlayer.dealtCards`.
   */
  dealt(name: string, cards: string[]): void {
    this.dealtLineCount += 1;
    const player = this.byName.get(name);
    if (!player) {
      this.warn("dealt-to-unseated", `Cards were dealt to ${name}, who is not seated.`);
      return;
    }
    player.dealtAnnounced = true;
    player.dealtCards = cards;
    if (cards.length > 0) {
      player.holeCards = cards;
      // Only the observer's own cards are dealt face up, so this is the hero.
      if (!this.heroName) {
        this.heroName = name;
        player.isHero = true;
      }
    }
  }

  /** Forces the hero, for rooms that name the observer seat literally "Hero". */
  setHero(name: string): void {
    const player = this.byName.get(name);
    if (!player) {
      return;
    }
    for (const other of this.players) {
      other.isHero = other === player;
    }
    this.heroName = name;
  }

  /* ------------------------------------------------------------- the board */

  /**
   * A `*** [FIRST|SECOND] FLOP|TURN|RIVER|SHOWDOWN ***` marker.
   *
   * `label` is the literal prefix the source printed ("", "FIRST", "SECOND"); it
   * carries no information the index does not, but reproducing it is what keeps
   * re-serialized text faithful.
   */
  marker(kind: MarkerKind, runoutIndex: number, label: string, cards: string[]): void {
    while (this.runouts.length <= runoutIndex) {
      this.runouts.push({ flop: null, turn: null, river: null });
      this.markerLabels.push({});
    }
    this.runoutIndex = runoutIndex;
    if (kind === "showdown") {
      this.sawShowdownMarker = true;
      this.showdownLabels.push(label.toUpperCase());
      this.street = "showdown";
      return;
    }
    if (kind === "flop") {
      this.runouts[runoutIndex].flop = cards.slice(0, 3);
      this.markerLabels[runoutIndex].flop = label.toUpperCase();
      this.street = "flop";
    } else if (kind === "turn") {
      this.runouts[runoutIndex].turn = cards[cards.length - 1] ?? null;
      this.markerLabels[runoutIndex].turn = label.toUpperCase();
      this.street = "turn";
    } else {
      this.runouts[runoutIndex].river = cards[cards.length - 1] ?? null;
      this.markerLabels[runoutIndex].river = label.toUpperCase();
      this.street = "river";
    }
    // A new street resets what everybody has committed to the current bet.
    this.streetCommit = new Map();
  }

  /* ----------------------------------------------------------- the actions */

  private seatOf(name: string): number | null {
    return this.byName.get(name)?.seat ?? null;
  }

  private commit(name: string, delta: Amount): Amount {
    const next = (this.streetCommit.get(name) ?? 0) + delta;
    this.streetCommit.set(name, next);
    return next;
  }

  /** What the actor has already put in on the current street. */
  committed(name: string): Amount {
    return this.streetCommit.get(name) ?? 0;
  }

  private push(action: Omit<PhfAction, "index" | "runoutIndex">): void {
    this.actions.push({ ...action, runoutIndex: this.runoutIndex, index: this.actions.length });
  }

  private money(amount: Amount): string {
    return formatAmount(Math.abs(amount), this.unit, this.init.textStyle.decimals);
  }

  post(
    name: string,
    type: Extract<
      ActionType,
      "ante" | "small-blind" | "big-blind" | "straddle" | "post" | "missed-blind" | "bomb-ante"
    >,
    amount: Amount,
    options: { allIn?: boolean; verb?: string; line?: number; rawLine: string },
  ): void {
    if (type === "ante" || type === "bomb-ante") {
      this.anteMax = Math.max(this.anteMax, amount);
      this.antePosters += 1;
    }
    if (type === "small-blind") {
      this.smallBlindPosted = Math.max(this.smallBlindPosted, amount);
    }
    if (type === "big-blind") {
      this.bigBlindPosted = Math.max(this.bigBlindPosted, amount);
    }
    if (type === "straddle") {
      this.straddles.push({ player: name, amount });
    }
    // Antes and missed blinds are dead money: they go straight to the pot and do
    // not count toward the current street's bet, so they never touch the commit.
    const dead = type === "ante" || type === "missed-blind" || type === "bomb-ante";
    this.push({
      street: "preflop",
      seat: this.seatOf(name),
      player: name,
      type,
      amount,
      streetTotal: dead ? 0 : this.commit(name, amount),
      allIn: options.allIn ?? false,
      verb: options.verb,
      label: `${type.replace("-", " ")} ${this.money(amount)}`,
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  /**
   * A fold or a check.
   *
   * `cards` is not dead weight: PokerStars lets a player expose a hole card on
   * the way out, which it writes as `Player6: folds [Ks]`
   * (`fixtures/samples/pokerstars/41-...`). That is a genuine reveal, so it is
   * recorded on the action and on the player - but it is *not* a showdown, so
   * it deliberately does not go through `show()`, which is what
   * `wentToShowdown` counts.
   */
  simple(
    name: string,
    type: Extract<ActionType, "fold" | "check">,
    options: { cards?: string[]; line?: number; rawLine: string },
  ): void {
    if (type === "fold") {
      this.folded.add(name);
    }
    const cards = options.cards ?? [];
    if (cards.length > 0) {
      const player = this.byName.get(name);
      if (player && player.holeCards.length === 0) {
        player.holeCards = cards;
      }
    }
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type,
      amount: 0,
      streetTotal: this.committed(name),
      allIn: false,
      cards: cards.length > 0 ? cards : undefined,
      label: cards.length > 0 ? `folds ${cards.join(" ")}` : type === "fold" ? "folds" : "checks",
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  wager(
    name: string,
    type: Extract<ActionType, "call" | "bet">,
    amount: Amount,
    options: { allIn?: boolean; line?: number; rawLine: string },
  ): void {
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type,
      amount,
      streetTotal: this.commit(name, amount),
      allIn: options.allIn ?? false,
      label: `${type === "call" ? "calls" : "bets"} ${this.money(amount)}`,
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  /**
   * `raises X to Y`. Only Y is stored: X is the amount over the current bet,
   * which is derived at serialization time from the betting state of the street.
   * Storing both would let the two disagree.
   */
  raiseTo(
    name: string,
    to: Amount,
    options: { allIn?: boolean; line?: number; rawLine: string },
  ): void {
    const already = this.committed(name);
    this.streetCommit.set(name, to);
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type: "raise",
      amount: to - already,
      streetTotal: to,
      allIn: options.allIn ?? false,
      label: `raises to ${this.money(to)}`,
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  /** An uncalled return. The amount is stored negative; see the PHF spec. */
  uncalled(name: string, amount: Amount, options: { line?: number; rawLine: string }): void {
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type: "uncalled",
      amount: -amount,
      streetTotal: this.commit(name, -amount),
      allIn: false,
      label: `uncalled ${this.money(amount)} returned`,
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  collect(
    name: string,
    amount: Amount,
    potName: string,
    options: { line?: number; rawLine: string },
  ): void {
    this.collectedBy.set(name, (this.collectedBy.get(name) ?? 0) + amount);
    this.push({
      street: "showdown",
      seat: this.seatOf(name),
      player: name,
      type: "collect",
      amount,
      streetTotal: 0,
      allIn: false,
      potName,
      label: `wins ${this.money(amount)}`,
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  show(
    name: string,
    cards: string[],
    description: string | undefined,
    options: { line?: number; rawLine: string },
  ): void {
    const player = this.byName.get(name);
    if (player && cards.length > 0) {
      player.holeCards = cards;
    }
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type: "show",
      amount: 0,
      streetTotal: 0,
      allIn: false,
      cards,
      description,
      label: cards.length > 0 ? `shows ${cards.join(" ")}` : "shows",
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  muck(name: string, verb: string, options: { line?: number; rawLine: string }): void {
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type: "muck",
      amount: 0,
      streetTotal: 0,
      allIn: false,
      description: verb,
      label: "mucks",
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  /**
   * GG EV-cashout events. They settle outside the pot, so both carry `amount: 0`
   * and must never move any pot math.
   */
  cashout(
    name: string,
    type: Extract<ActionType, "cashout-choose" | "cashout-pay">,
    risk: Amount,
    options: { line?: number; rawLine: string },
  ): void {
    this.push({
      street: this.street,
      seat: this.seatOf(name),
      player: name,
      type,
      amount: 0,
      streetTotal: 0,
      allIn: false,
      description: type === "cashout-pay" ? this.money(risk) : undefined,
      label:
        type === "cashout-choose"
          ? "chooses EV cashout"
          : `pays cashout risk ${this.money(risk)}`,
      sourceLine: options.line ?? null,
      rawLine: options.rawLine,
    });
  }

  /* ------------------------------------------------------------- summary -- */

  /**
   * A promotional chip movement that is not a bet.
   *
   * Kept off the action stream on purpose: `ActionType` is a closed union that
   * consumers switch on, so these live on `hand.chipMovements` instead and the
   * validator folds house-into-pot money into chip conservation.
   */
  chipMovement(movement: Omit<PhfChipMovement, "fromPlayer">): void {
    this.movements.push({
      ...movement,
      fromPlayer:
        movement.fromSeat === null
          ? null
          : (this.players.find((player) => player.seat === movement.fromSeat)?.name ?? null),
    });
  }

  summaryPot(
    totalPot: Amount,
    pots: Array<{ name: string; amount: Amount }>,
    fees: PhfFees,
  ): void {
    this.totalPot = totalPot;
    this.sawSummaryPot = true;
    this.pots.push(...pots);
    this.fees = fees;
  }

  summaryBoard(runoutIndex: number, cards: string[]): void {
    this.summaryBoards.set(runoutIndex, cards);
  }

  summarySeat(seat: number, rawLine: string): void {
    this.summarySeatLines.set(seat, rawLine);
  }

  noteRunItTwice(): void {
    this.runItTwiceNote = true;
  }

  /* --------------------------------------------------------------- build -- */

  playerCount(): number {
    return this.players.length;
  }

  actionCount(): number {
    return this.actions.length;
  }

  /** Every card the draft has seen, for a pre-build sanity check. */
  hasInvalidCard(): string | null {
    for (const player of this.players) {
      for (const card of player.holeCards) {
        if (!parseCard(card)) {
          return card;
        }
      }
    }
    return null;
  }

  /**
   * Rebuilds an `Uncalled bet` line the source did not print.
   *
   * Two 2011 PokerStars fixtures (07 and 08) state a `Total pot` that is short
   * of what the action stream puts in by exactly the last aggressor's overbet,
   * because the export dropped the return line. That is not a guess: the return
   * is only inserted when all three of these hold, which pins it to a single
   * possible value.
   *
   *   1. the shortfall is positive and the SUMMARY did state a pot;
   *   2. on the last street with any betting, exactly one player committed the
   *      most and nobody matched them;
   *   3. that player's excess over the next-highest commitment is *exactly* the
   *      shortfall.
   *
   * Anything else is left alone and fails `chip-mismatch`, which is the right
   * outcome for a hand we do not understand.
   */
  private reconstructUncalled(shortfall: Amount): boolean {
    const wagerTypes = new Set<ActionType>([
      "small-blind",
      "big-blind",
      "straddle",
      "post",
      "call",
      "bet",
      "raise",
      "uncalled",
    ]);
    let key = "";
    let group = new Map<string, Amount>();
    let lastKey = "";
    let lastGroup = new Map<string, Amount>();
    let lastIndex = -1;
    let groupEnd = -1;
    for (let i = 0; i < this.actions.length; i += 1) {
      const action = this.actions[i];
      const actionKey = `${action.street}:${action.runoutIndex}`;
      if (actionKey !== key) {
        key = actionKey;
        group = new Map();
      }
      if (!wagerTypes.has(action.type)) {
        continue;
      }
      group.set(action.player, (group.get(action.player) ?? 0) + action.amount);
      lastKey = key;
      lastGroup = group;
      lastIndex = i;
    }
    if (lastIndex < 0) {
      return false;
    }
    // The return belongs at the end of that street, before the showdown.
    groupEnd = lastIndex;
    for (let i = lastIndex + 1; i < this.actions.length; i += 1) {
      if (`${this.actions[i].street}:${this.actions[i].runoutIndex}` !== lastKey) {
        break;
      }
      groupEnd = i;
    }

    const sorted = [...lastGroup.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const second = sorted[1]?.[1] ?? 0;
    if (!top || top[1] - second !== shortfall || (sorted[1] && sorted[1][1] === top[1])) {
      return false;
    }

    const template = this.actions[groupEnd];
    this.actions.splice(groupEnd + 1, 0, {
      index: 0,
      street: template.street,
      runoutIndex: template.runoutIndex,
      seat: this.seatOf(top[0]),
      player: top[0],
      type: "uncalled",
      amount: -shortfall,
      streetTotal: top[1] - shortfall,
      allIn: false,
      label: `uncalled ${this.money(shortfall)} returned`,
      sourceLine: null,
      rawLine: `Uncalled bet (${this.money(shortfall)}) returned to ${top[0]}`,
    });
    this.actions.forEach((action, index) => {
      action.index = index;
    });
    this.warn(
      "uncalled-return-reconstructed",
      `The source omitted the uncalled return of ${this.money(shortfall)} to ${top[0]}; ` +
        "it was rebuilt from the reported pot.",
    );
    return true;
  }

  build(): PhfHand {
    const { init } = this;
    const unit = init.game.unit;

    if (!this.maxSeats) {
      this.maxSeats = Math.max(this.players.length, ...this.players.map((p) => p.seat), 0);
    }

    // Positions are deliberately left null. `assignPositions` in the core is the
    // authoritative resolver - it anchors the ring on who actually posted the
    // blinds instead of on seat geometry, which is what makes it right on a
    // dead button, on a table with seated-but-not-dealt-in players, and
    // heads-up. It runs at the end of `convertAny`, so anything that reaches a
    // consumer has real positions; a parser filling them in from geometry here
    // would just be a second, worse answer for the core to overwrite.

    // The summary can reveal cards that never appeared in a `shows` line -
    // PokerStars writes `Seat 1: x (button) mucked [Td 7d]`.
    for (const [seat, line] of this.summarySeatLines) {
      const player = this.players.find((entry) => entry.seat === seat);
      if (!player || player.holeCards.length > 0) {
        continue;
      }
      const shown = line.match(/(?:showed|mucked)\s+\[([^\]]*)\]/i);
      if (shown) {
        player.holeCards = extractCards(shown[1]);
      }
    }

    const board: PhfBoard = {
      runouts: this.runouts.map(
        (run, index): PhfRunout => ({
          index,
          ...run,
          markerLabels: this.markerLabels[index] ?? {},
          summaryCards: this.summaryBoards.get(index) ?? null,
        }),
      ),
    };
    // A hand that ends before a marker is printed can still carry a SUMMARY
    // `Board [..]` line; take it rather than losing the runout.
    if (board.runouts.length === 1 && board.runouts[0].flop === null) {
      const fromSummary = this.summaryBoards.get(0) ?? [];
      if (fromSummary.length > 0) {
        board.runouts[0] = {
          index: 0,
          flop: fromSummary.slice(0, 3),
          turn: fromSummary[3] ?? null,
          river: fromSummary[4] ?? null,
          markerLabels: {},
          summaryCards: fromSummary,
        };
        this.warn("board-from-summary", "Board taken from the SUMMARY line.");
      }
    }

    const tally = (): Map<string, Amount> => {
      const out = new Map<string, Amount>();
      for (const action of this.actions) {
        if (action.type === "collect" || action.amount === 0) {
          continue;
        }
        out.set(action.player, (out.get(action.player) ?? 0) + action.amount);
      }
      return out;
    };

    let contributions = tally();
    let putIn = [...contributions.values()].reduce((sum, value) => sum + value, 0);
    if (init.repairMissingUncalled && this.sawSummaryPot && putIn - this.totalPot > 0) {
      if (this.reconstructUncalled(putIn - this.totalPot)) {
        contributions = tally();
        putIn = [...contributions.values()].reduce((sum, value) => sum + value, 0);
      }
    }
    const takenOut = [...this.collectedBy.values()].reduce((sum, value) => sum + value, 0);

    // Promotional money the house put in is part of the pot but came from no
    // seat, so it has to be added wherever the pot is derived from the stream.
    const fromHouse = this.movements
      .filter((movement) => movement.toPot && movement.fromSeat === null)
      .reduce((sum, movement) => sum + movement.amount, 0);

    if (!this.sawSummaryPot) {
      // No SUMMARY block at all - PokerStars truncates the file when the client
      // disconnects mid-hand. The stream is still complete, so the pot is what
      // went in and whatever the winners did not get back is the rake. Both are
      // derived, not invented, but the hand is flagged so it can be re-checked.
      this.totalPot = putIn + fromHouse;
      if (takenOut > 0 && this.totalPot - takenOut > 0) {
        this.fees = { ...this.fees, rake: this.totalPot - takenOut };
        this.warn(
          "rake-inferred",
          "The hand has no SUMMARY block; the rake was derived from pot minus collected.",
        );
      } else {
        this.warn("no-summary", "The hand has no SUMMARY block.");
      }
    } else if (this.totalPot === 0) {
      this.totalPot = putIn + fromHouse;
    }

    const shownAtShowdown = new Set(
      this.actions.filter((action) => action.type === "show").map((action) => action.player),
    );
    // Cards a player exposed anywhere in the stream. The summary is the usual
    // source, but a `folds [Ks]` never reaches it - PokerStars prints the seat's
    // summary line as a plain `folded on the Flop` - so the reveal would be lost
    // from `results` if it were only read from there.
    const revealedInStream = new Map<string, string[]>();
    for (const action of this.actions) {
      if (action.cards && action.cards.length > 0) {
        revealedInStream.set(action.player, action.cards);
      }
    }

    const playerResults: PhfPlayerResult[] = this.players.map((player) => {
      const summaryLine = this.summarySeatLines.get(player.seat) ?? null;
      const parsed = summaryLine
        ? parseSummarySeat(summaryLine, player.name, unit)
        : ({} as Partial<PhfPlayerResult>);
      const won = this.collectedBy.get(player.name) ?? 0;
      const contributed = contributions.get(player.name) ?? 0;
      return {
        seat: player.seat,
        player: player.name,
        won,
        contributed,
        net: won - contributed,
        wentToShowdown: shownAtShowdown.has(player.name) || parsed.outcome === "showed",
        shownCards:
          parsed.shownCards && parsed.shownCards.length > 0
            ? parsed.shownCards
            : (revealedInStream.get(player.name) ?? []),
        mucked: parsed.mucked ?? false,
        handDescription: parsed.handDescription ?? null,
        positionLabels: parsed.positionLabels ?? [],
        outcome: (parsed.outcome ?? (won > 0 ? "collected" : "unknown")) as SeatOutcome,
        foldedStreet: parsed.foldedStreet ?? null,
        didntBet: parsed.didntBet ?? false,
        cashoutRisk: parsed.cashoutRisk ?? null,
        raw: summaryLine,
      };
    });

    const primary = resolveRunout(board, 0);
    const dealtTo: Street =
      primary.length >= 5
        ? "river"
        : primary.length === 4
          ? "turn"
          : primary.length === 3
            ? "flop"
            : "preflop";
    const contenders = this.players.filter((player) => !this.folded.has(player.name));
    const wentToShowdown = this.sawShowdownMarker && contenders.length >= 2;

    const anteModel =
      this.antePosters === 0
        ? "none"
        : this.antePosters === 1 && this.players.length > 1
          ? "big-blind-ante"
          : "posted-per-player";

    const hasBlinds = this.actions.some(
      (action) => action.type === "small-blind" || action.type === "big-blind",
    );
    const bombPot =
      this.antePosters >= 2 && !hasBlinds
        ? { ante: this.anteMax, dealtToStreet: "flop" as Street, doubleBoard: board.runouts.length > 1 }
        : null;

    const straddles: PhfStraddle[] = this.straddles.map((entry, index) => ({
      seat: this.byName.get(entry.player)?.seat ?? -1,
      player: entry.player,
      amount: entry.amount,
      order: index + 1,
    }));

    // Level headers go stale in tournaments, so what was actually posted wins;
    // the header's own numbers stay on `tournament.levelSmallBlind`/`levelBigBlind`.
    const smallBlind =
      init.tournament && this.smallBlindPosted > 0
        ? Math.max(init.game.smallBlind, this.smallBlindPosted)
        : init.game.smallBlind || this.smallBlindPosted;
    const bigBlind =
      init.tournament && this.bigBlindPosted > 0
        ? Math.max(init.game.bigBlind, this.bigBlindPosted)
        : init.game.bigBlind || this.bigBlindPosted;

    return {
      schema: PHF_SCHEMA,
      meta: {
        siteId: init.siteId,
        siteName: init.siteName,
        handId: init.handId,
        handKey: init.handKey,
        originalFilename: init.originalFilename,
        parserId: init.parserId,
        parserVersion: init.parserVersion,
        warnings: this.warnings,
        rawText: init.rawText,
        parsedAt: new Date().toISOString(),
        textStyle: {
          ...init.textStyle,
          dealtLinesForAllPlayers: this.dealtLineCount > 1,
          showdownSection: this.sawShowdownMarker,
          holeCardsSection: this.sawHoleCardsMarker,
          showdownLabels: this.showdownLabels.length > 0 ? this.showdownLabels : [""],
          runItTwiceNote: this.runItTwiceNote,
        },
      },
      game: {
        variant: init.game.variant,
        limit: init.game.limit,
        format: init.game.format,
        unit,
        smallBlind,
        bigBlind,
        anteModel,
        ante: this.anteMax,
        straddles,
        bombPot,
        label: init.game.label,
      },
      table: {
        name: this.tableName,
        maxSeats: this.maxSeats,
        buttonSeat: this.buttonSeat,
        ...(this.fastFold ? { fastFold: this.fastFold } : {}),
      },
      tournament: init.tournament,
      players: this.players,
      actions: this.actions,
      // Absent rather than empty on the overwhelming majority of hands, so the
      // stored JSON does not grow a null field for every hand ever converted.
      ...(this.movements.length > 0 ? { chipMovements: this.movements } : {}),
      board,
      results: {
        totalPot: this.totalPot,
        pots: this.pots,
        fees: this.fees,
        players: playerResults,
        winners: this.actions
          .filter((action) => action.type === "collect")
          .map((action) => ({
            player: action.player,
            seat: action.seat,
            amount: action.amount,
            runoutIndex: action.runoutIndex,
          })),
        heroNet:
          this.heroName === null
            ? null
            : (this.collectedBy.get(this.heroName) ?? 0) -
              (contributions.get(this.heroName) ?? 0),
        wentToShowdown,
        streetReached: wentToShowdown ? "showdown" : dealtTo,
      },
      playedAt: init.playedAt,
    };
  }
}
