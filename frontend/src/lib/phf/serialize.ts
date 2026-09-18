/**
 * PHF <-> standard text.
 *
 * "Standard text" is the GG-style plain-text serialization this app has always
 * produced. It is not the source of truth any more - PHF is - but it stays a
 * first-class citizen because Holdem Manager and PokerTracker import it, and
 * they are byte sensitive: a trailing space or `$0.5` vs `$0.50` is the
 * difference between a clean import and a silent drop.
 *
 * The two functions here are exact inverses over every sample file in `gg-hh/`
 * and over everything the WePlay parser produces. `backend/test/roundTrip.test.ts`
 * enforces that.
 */

import { extractCards } from "../cards";
import {
  DEFAULT_TEXT_STYLE,
  PHF_SCHEMA,
  USD,
  formatAmount,
  formatAmountDigits,
  assignPositions,
  parseAmount,
  parseBuyInToken,
  resolvePositions,
  resolveRunout,
  totalFees,
  unitForSymbol,
  ZERO_FEES,
  type ActionType,
  type Amount,
  type CurrencyUnit,
  type DecimalStyle,
  type PhfAction,
  type PhfBoard,
  type PhfFees,
  type PhfHand,
  type PhfPlayer,
  type PhfPlayerResult,
  type PhfRunout,
  type PhfTextStyle,
  type PhfTournament,
  type PhfWarning,
  type SeatOutcome,
  type Street,
  type Variant,
} from "./types";

/** Bumped whenever the text grammar this file understands changes. */
export const STANDARD_TEXT_PARSER_VERSION = "1.0.0";

const HEADER_REGEX = /^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#([A-Za-z0-9_-]+):\s*(.*)$/i;
/**
 * A printed amount. The symbol set must stay in step with `unitForSymbol`:
 * emitting a glyph this cannot read back means the serializer produces text its
 * own parser silently mis-reads as chips.
 */
const MONEY = String.raw`(?:\$|€|£|₮)?([\d,]+(?:\.\d+)?)`;
const TABLE_REGEX = /^Table\s+'(.*)'\s+(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?\s*$/;
const SEAT_REGEX = /^Seat\s+(\d+):\s+(.+)\s+\((\S+)\s+in chips\)$/;
const MARKER_REGEX =
  /^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i;
/** Word a site puts in front of a street marker for runout N of a run-it-twice. */
const RUN_PREFIXES = ["FIRST", "SECOND", "THIRD", "FOURTH"];
const RUN_WORDS = ["", "once", "two times", "three times", "four times"];

/** "FIRST" -> 0, "SECOND" -> 1, "" (single runout) -> 0. */
function runoutIndexForLabel(label: string): number {
  if (!label) {
    return 0;
  }
  const index = RUN_PREFIXES.indexOf(label.toUpperCase());
  return index < 0 ? 0 : index;
}

/**
 * Lines that carry neither pot nor card information. Sites emit plenty of them
 * (chat, sit-outs, disconnect notices); dropping them is not information loss
 * but it does have to be deliberate, otherwise a genuinely new line shape gets
 * swallowed instead of raising a warning.
 */
const CHATTER_REGEX =
  /\b(?:joins the table|leaves the table|sits out|has timed out|is (?:dis)?connected|declines straddle|was run two times|said,|will be allowed to play after the button|stands up|posts?\s+dead)\b/i;

/* ------------------------------------------------------------------ parsing */

interface ParseContext {
  siteId: string;
  siteName: string;
  originalFilename: string | null;
  /** Fallback parser id; the standard parser stamps its own when omitted. */
  parserId?: string;
  parserVersion?: string;
}

/** Splits a multi-hand file into individual hand chunks. */
export function splitStandardHands(text: string): string[] {
  return text
    .split(/(?=^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#)/im)
    .map((chunk) => chunk.replace(/^﻿/, "").trim())
    .filter((chunk) => chunk.length > 0 && HEADER_REGEX.test(chunk.split(/\r?\n/)[0] ?? ""));
}

function detectSymbol(text: string): string {
  if (text.includes("€")) return "€";
  if (text.includes("£")) return "£";
  if (text.includes("$")) return "$";
  // Tether, used by the crypto rooms. Missing it here made `unitForSymbol`
  // fall through to chips and divided every amount in the hand by 100.
  if (text.includes("\u20ae")) return "\u20ae";
  return "";
}

/**
 * Whether a source writes `$0.50` or `$0.5`.
 *
 * Decided from the whole hand rather than one token: a hand full of round
 * numbers carries no evidence either way, and guessing wrong flips every
 * fractional amount in the output.
 */
function detectDecimalStyle(text: string): DecimalStyle {
  if (/[\d](?:\.\d0)(?!\d)/.test(text)) {
    // A literal trailing zero after the decimal point can only be fixed2.
    return "fixed2";
  }
  if (/[\d]\.\d(?!\d)/.test(text)) {
    return "minimal";
  }
  return "fixed2";
}

function romanToNumber(roman: string): number | null {
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const upper = roman.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) {
    return null;
  }
  let total = 0;
  for (let i = 0; i < upper.length; i += 1) {
    const value = values[upper[i]];
    const next = values[upper[i + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

function numberToRoman(value: number): string {
  const table: Array<[number, string]> = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let left = value;
  let out = "";
  for (const [amount, letters] of table) {
    while (left >= amount) {
      out += letters;
      left -= amount;
    }
  }
  return out;
}

function variantFromLabel(label: string): Variant {
  if (/6\s*card\s*omaha|omaha\s*6/i.test(label)) return "omaha6";
  if (/5\s*card\s*omaha|omaha\s*5/i.test(label)) return "omaha5";
  if (/omaha|\bPLO\b/i.test(label)) return "omaha";
  if (/short\s*deck|6\+/i.test(label)) return "shortdeck";
  if (/\brazz\b/i.test(label)) return "razz";
  if (/\bstud\b/i.test(label)) return "stud";
  if (/\bdraw\b/i.test(label)) return "draw";
  if (/hold\s*'?em/i.test(label)) return "holdem";
  return "other";
}

function limitFromLabel(label: string): "nl" | "pl" | "fl" {
  if (/pot\s*limit|\bPL\b/i.test(label)) return "pl";
  if (/fixed\s*limit|\bLimit\b(?!\s*Hold)/i.test(label) && !/no\s*limit/i.test(label)) return "fl";
  return "nl";
}

interface HeaderInfo {
  handId: string;
  payload: string;
  gameLabel: string;
  unit: CurrencyUnit;
  smallBlind: Amount;
  bigBlind: Amount;
  headerAnte: Amount;
  playedAt: string | null;
  tournament: PhfTournament | null;
}

function parsePlayedAt(payload: string): string | null {
  const match = payload.match(/(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  // Hand histories are written in UTC. The hour is padded here because sites
  // like WePlay print `8:34:11`, which is not a valid ISO instant.
  const iso = new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${s}Z`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** `2026-02-17T05:56:01.000Z` -> `2026/02/17 05:56:01`, the shape sites print. */
export function formatPlayedAt(iso: string | null, padHour = true): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hour = padHour ? pad(date.getUTCHours()) : String(date.getUTCHours());
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${hour}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** Detects whether the header zero-pads the hour. Ambiguous input keeps `true`. */
function detectPadHour(payload: string): boolean {
  const match = payload.match(/\d{4}[/-]\d{2}[/-]\d{2}[ T](\d{1,2}):\d{2}:\d{2}/);
  if (!match) {
    return true;
  }
  return match[1].length === 2;
}

/** Where a game label starts: the first variant keyword in the text. */
const GAME_LABEL_TAIL =
  /((?:Hold\s*'?\s*em|Omaha|Short\s*Deck|6\+|Stud|Razz|Draw|Badugi|Mixed|HORSE|8-Game)\b.*)$/i;

/** A printed buy-in: `$55`, `$4.50+$4.50+$1`, `£5.00+£0.50`, `Freeroll`. */
const BUY_IN_TOKEN =
  /((?:[$€£₮]\s?[\d,]+(?:\.\d+)?(?:\s*\+\s*[$€£₮]?[\d,]+(?:\.\d+)?)*)|Freeroll)/i;

/**
 * Splits the free text between the tournament id and the level clause.
 *
 * Three real shapes:
 *   `$15+$1.50 Hold'em No Limit`                         (WePlay, name in parens)
 *   `$20+$1 USD Hold'em No Limit`                        (PokerStars, no name)
 *   `H-04: $1,050 GGMasters High Rollers Hold'em No Limit` (GG, name inline)
 *
 * The game label is the tail from the first variant keyword; whatever precedes
 * it is the name, and the buy-in is found inside that. A name that is nothing
 * but the buy-in is not a name. The buy-in text is deliberately *left in* the
 * name for the inline dialect, because that is what the room printed and the
 * serializer echoes it back verbatim.
 */
function splitTournamentBody(
  body: string,
  parenName: string | null,
): { name: string | null; buyInToken: string; gameLabel: string } {
  const tail = body.match(GAME_LABEL_TAIL);
  const gameLabel = (tail ? tail[1] : body).trim();
  const namePart = (tail ? body.slice(0, body.length - tail[1].length) : "").trim();
  const buyInToken = namePart.match(BUY_IN_TOKEN)?.[1] ?? "";
  const inlineName = namePart && namePart !== buyInToken ? namePart : null;
  return { name: parenName ?? inlineName, buyInToken, gameLabel };
}

function parseHeader(handId: string, payload: string): HeaderInfo {
  const playedAt = parsePlayedAt(payload);

  // One regex for every dialect seen so far. The body between the id and the
  // level clause is free text - GG puts a tournament name in it, PokerStars a
  // currency code, WePlay nothing but the buy-in - so it is captured whole and
  // split afterwards. `Level\s*` and `\s*\(` are loose because GG glues the
  // number to the word and sometimes to the parenthesis: `Level14(300/600)`.
  const tournamentMatch = payload.match(
    /^Tournament\s*(?:\(([^]*?)\))?\s*#(\S+?),\s*(.+?)\s+-\s+Level\s*([IVXLCDM]+|\d+)\s*\(([^)]*)\)\s+-\s+(.*)$/,
  );
  if (tournamentMatch) {
    const [, parenName, tid, body, levelLabel, levelStakes] = tournamentMatch;
    const { name, buyInToken, gameLabel } = splitTournamentBody(body, parenName ?? null);
    const buyInSymbol = detectSymbol(buyInToken) || "$";
    const buyInUnit = unitForSymbol(buyInSymbol);
    // `$4.50+$4.50+$1` is prize pool + bounty + fee; `$15+$1.50` has no bounty.
    const buyInParts = parseBuyInToken(buyInToken, buyInUnit);
    // Tournament stacks are chips even though the buy-in is real money.
    const unit = unitForSymbol(detectSymbol(levelStakes));
    const stakes = levelStakes.split("/");
    const levelNumber = romanToNumber(levelLabel) ?? (Number(levelLabel) || null);
    return {
      handId,
      payload,
      gameLabel,
      unit,
      smallBlind: parseAmount(stakes[0], unit),
      bigBlind: parseAmount(stakes[1] ?? stakes[0], unit),
      headerAnte: parseAmount(stakes[2], unit),
      playedAt,
      tournament: {
        id: tid,
        name,
        buyIn: buyInParts.buyIn,
        bounty: buyInParts.bounty,
        fee: buyInParts.fee,
        buyInUnit,
        levelLabel,
        levelNumber,
        levelSmallBlind: parseAmount(stakes[0], unit),
        levelBigBlind: parseAmount(stakes[1] ?? stakes[0], unit),
        levelAnte: parseAmount(stakes[2], unit),
        bounties: [],
      },
    };
  }

  const cashMatch = payload.match(/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/);
  if (cashMatch) {
    const [, gameLabel, stakesText] = cashMatch;
    const unit = unitForSymbol(detectSymbol(stakesText));
    const stakes = stakesText.split("/");
    return {
      handId,
      payload,
      gameLabel: gameLabel.trim(),
      unit,
      smallBlind: parseAmount(stakes[0], unit),
      bigBlind: parseAmount(stakes[1] ?? stakes[0], unit),
      headerAnte: parseAmount(stakes[2], unit),
      playedAt,
      tournament: null,
    };
  }

  return {
    handId,
    payload,
    gameLabel: payload.split(" - ")[0]?.trim() ?? payload,
    unit: USD,
    smallBlind: 0,
    bigBlind: 0,
    headerAnte: 0,
    playedAt,
    tournament: null,
  };
}

/** Reads one summary `Seat N: ...` line into a structured result. */
function parseSummarySeatLine(
  raw: string,
  playerName: string,
  unit: CurrencyUnit,
): Partial<PhfPlayerResult> {
  let rest = raw.replace(/^Seat\s+\d+:\s*/, "");
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

  const shownMatch = rest.match(/(?:showed|mucked)\s+\[([^\]]*)\]/i);
  if (shownMatch) {
    out.shownCards = extractCards(shownMatch[1]);
  }

  const cashoutMatch = rest.match(new RegExp(String.raw`Cashout Risk \(${MONEY}\)`));
  if (cashoutMatch) {
    out.cashoutRisk = parseAmount(cashoutMatch[1], unit);
  }

  const foldedMatch = rest.match(/^folded\s+(?:before Flop|on the (Flop|Turn|River))/i);
  if (foldedMatch) {
    out.outcome = "folded";
    out.foldedStreet = foldedMatch[1]
      ? (foldedMatch[1].toLowerCase() as Street)
      : ("preflop" as Street);
    out.didntBet = /\(didn't bet\)/i.test(rest);
    return out;
  }

  if (/^mucked\b/i.test(rest)) {
    out.outcome = "mucked";
    out.mucked = true;
    return out;
  }

  const wonMatch = rest.match(new RegExp(String.raw`(?:won|collected)\s+\(${MONEY}\)`));
  const descMatch = rest.match(/\bwith\s+(.+?)(?:,\s+(?:and\s+)?(?:won|lost|Cashout Risk)\b.*)?$/i);
  if (descMatch) {
    out.handDescription = descMatch[1].replace(/,\s*$/, "");
  }

  if (/^showed\b/i.test(rest)) {
    out.outcome = wonMatch ? "won" : "lost";
    return out;
  }
  if (wonMatch) {
    out.outcome = /\bcollected\b/i.test(rest) ? "collected" : "won";
    return out;
  }
  return out;
}

interface RunoutDraft {
  flop: string[] | null;
  turn: string | null;
  river: string | null;
}

/**
 * Parses one standard-text hand chunk into PHF.
 *
 * Returns `null` when the text is not a hand history at all. Anything that is a
 * hand but is odd shows up in `meta.warnings`; the validator decides whether
 * odd means unusable.
 */
export function parseStandardHand(text: string, ctx: ParseContext): PhfHand | null {
  const rawText = text.replace(/^﻿/, "").trim();
  const lines = rawText.split(/\r?\n/);
  const headerMatch = lines[0]?.match(HEADER_REGEX);
  if (!headerMatch) {
    return null;
  }

  const warnings: PhfWarning[] = [];
  const header = parseHeader(headerMatch[1], headerMatch[2]);
  const unit = header.unit;
  const players: PhfPlayer[] = [];
  const playerByName = new Map<string, PhfPlayer>();
  const actions: PhfAction[] = [];
  const runouts: RunoutDraft[] = [{ flop: null, turn: null, river: null }];
  const summaryBoards = new Map<number, string[]>();
  const markerLabels: Array<{ flop?: string; turn?: string; river?: string }> = [{}];
  const showdownLabels: string[] = [];
  const pots: Array<{ name: string; amount: Amount }> = [];
  const summarySeatLines = new Map<number, string>();
  const collectedBy = new Map<string, Amount>();

  let tableName: string | null = null;
  let maxSeats = 0;
  let buttonSeat: number | null = null;
  let heroName: string | null = null;
  let totalPot = 0;
  let fees: PhfFees = { ...ZERO_FEES };
  let anteTotal = 0;
  let anteMax = 0;
  let antePosters = 0;
  let inSummary = false;
  let street: Street = "preflop";
  let runoutIndex = 0;
  let sawShowdownMarker = false;
  let sawHoleCardsMarker = false;
  let dealtLineCount = 0;
  let runTwoTimesLine = false;
  const straddles: PhfGameStraddleDraft[] = [];
  const foldedPlayers = new Set<string>();

  // Per-street commitment, needed to turn "raises X to Y" into chips added.
  let streetCommit = new Map<string, Amount>();

  function push(action: Omit<PhfAction, "index" | "runoutIndex">): void {
    actions.push({ ...action, runoutIndex, index: actions.length });
  }

  function commit(player: string, delta: Amount): Amount {
    const next = (streetCommit.get(player) ?? 0) + delta;
    streetCommit.set(player, next);
    return next;
  }

  function seatOf(name: string): number | null {
    return playerByName.get(name)?.seat ?? null;
  }

  for (let i = 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const lineNo = i + 1;
    if (!trimmed) {
      continue;
    }

    if (/^\*\*\*\s*SUMMARY/i.test(trimmed)) {
      inSummary = true;
      continue;
    }

    if (inSummary) {
      const potMatch = trimmed.match(new RegExp(String.raw`^Total pot ${MONEY}`));
      if (potMatch) {
        totalPot = parseAmount(potMatch[1], unit);
        for (const potMatchEntry of trimmed
          .split("|")[0]
          .matchAll(new RegExp(String.raw`(Main|Side) pot ${MONEY}\.`, "g"))) {
          pots.push({ name: potMatchEntry[1], amount: parseAmount(potMatchEntry[2], unit) });
        }
        fees = {
          rake: parseAmount(trimmed.match(new RegExp(String.raw`Rake ${MONEY}`))?.[1], unit),
          jackpot: parseAmount(trimmed.match(new RegExp(String.raw`Jackpot ${MONEY}`))?.[1], unit),
          bingo: parseAmount(trimmed.match(new RegExp(String.raw`Bingo ${MONEY}`))?.[1], unit),
          fortune: parseAmount(trimmed.match(new RegExp(String.raw`Fortune ${MONEY}`))?.[1], unit),
          tax: parseAmount(trimmed.match(new RegExp(String.raw`Tax ${MONEY}`))?.[1], unit),
          other: 0,
        };
        continue;
      }

      if (/^Hand was run (?:two|three|four) times$/i.test(trimmed)) {
        runTwoTimesLine = true;
        continue;
      }

      const boardMatch = trimmed.match(/^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]/i);
      if (boardMatch) {
        const index = runoutIndexForLabel((boardMatch[1] ?? "").trim());
        summaryBoards.set(index, extractCards(boardMatch[2]));
        continue;
      }

      const summarySeat = trimmed.match(/^Seat\s+(\d+):/);
      if (summarySeat) {
        // Stored untrimmed: some sites leave a trailing space on these lines
        // and the output has to match the input byte for byte.
        summarySeatLines.set(Number(summarySeat[1]), rawLine);
        continue;
      }

      warnings.push({ code: "unknown-summary-line", message: trimmed, line: lineNo });
      continue;
    }

    const tableMatch = trimmed.match(TABLE_REGEX);
    if (tableMatch) {
      tableName = tableMatch[1] || null;
      maxSeats = Number(tableMatch[2]) || 0;
      buttonSeat = tableMatch[3] ? Number(tableMatch[3]) : null;
      continue;
    }

    const seatMatch = trimmed.match(SEAT_REGEX);
    if (seatMatch) {
      const name = seatMatch[2];
      const player: PhfPlayer = {
        seat: Number(seatMatch[1]),
        name,
        startingStack: parseAmount(seatMatch[3], unit),
        isHero: name === "Hero",
        holeCards: [],
        bounty: null,
        sittingOut: false,
        position: null,
        dealtAnnounced: false,
        dealtCards: [],
      };
      players.push(player);
      playerByName.set(name, player);
      if (player.isHero) {
        heroName = name;
      }
      continue;
    }

    const marker = trimmed.match(MARKER_REGEX);
    if (marker) {
      const index = runoutIndexForLabel(marker[1] ?? "");
      const kind = marker[2].replace(/\s+/g, "").toUpperCase();
      const groups = [...marker[3].matchAll(/\[([^\]]*)\]/g)].map((m) => extractCards(m[1]));

      while (runouts.length <= index) {
        runouts.push({ flop: null, turn: null, river: null });
        markerLabels.push({});
      }
      runoutIndex = index;
      const printedLabel = (marker[1] ?? "").toUpperCase();

      if (kind === "SHOWDOWN") {
        sawShowdownMarker = true;
        showdownLabels.push(printedLabel);
        street = "showdown";
        continue;
      }

      const last = groups[groups.length - 1] ?? [];
      if (kind === "FLOP") {
        runouts[index].flop = last.slice(0, 3);
        markerLabels[index].flop = printedLabel;
        street = "flop";
      } else if (kind === "TURN") {
        runouts[index].turn = last[0] ?? null;
        markerLabels[index].turn = printedLabel;
        street = "turn";
      } else {
        runouts[index].river = last[0] ?? null;
        markerLabels[index].river = printedLabel;
        street = "river";
      }
      streetCommit = new Map();
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS/i.test(trimmed)) {
      sawHoleCardsMarker = true;
      continue;
    }

    const dealtMatch = rawLine.match(/^Dealt to\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$/);
    if (dealtMatch) {
      const player = playerByName.get(dealtMatch[1].trim());
      const cards = dealtMatch[2] ? extractCards(dealtMatch[2]) : [];
      dealtLineCount += 1;
      if (player) {
        player.dealtAnnounced = true;
        player.dealtCards = cards;
        if (cards.length > 0) {
          player.holeCards = cards;
          // Some sites label the observer seat with the real screen name.
          if (!heroName) {
            heroName = player.name;
            player.isHero = true;
          }
        }
      }
      continue;
    }

    const uncalledMatch = trimmed.match(
      new RegExp(String.raw`^Uncalled bet \(${MONEY}\) returned to (.+)$`),
    );
    if (uncalledMatch) {
      const amount = parseAmount(uncalledMatch[1], unit);
      const player = uncalledMatch[2].trim();
      push({
        street,
        seat: seatOf(player),
        player,
        type: "uncalled",
        amount: -amount,
        streetTotal: commit(player, -amount),
        allIn: false,
        label: `uncalled ${formatAmount(amount, unit)} returned`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const collectedMatch = trimmed.match(
      new RegExp(String.raw`^(.+?) collected ${MONEY} from (?:the )?(.+?)\s*$`),
    );
    if (collectedMatch) {
      const player = collectedMatch[1].trim();
      const amount = parseAmount(collectedMatch[2], unit);
      collectedBy.set(player, (collectedBy.get(player) ?? 0) + amount);
      push({
        street: "showdown",
        seat: seatOf(player),
        player,
        type: "collect",
        amount,
        streetTotal: 0,
        allIn: false,
        potName: collectedMatch[3],
        label: `wins ${formatAmount(amount, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const anteMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): posts the ante ${MONEY}( and is all-in)?$`),
    );
    if (anteMatch) {
      const player = anteMatch[1];
      const amount = parseAmount(anteMatch[2], unit);
      anteMax = Math.max(anteMax, amount);
      anteTotal += amount;
      antePosters += 1;
      push({
        street: "preflop",
        seat: seatOf(player),
        player,
        type: "ante",
        amount,
        streetTotal: 0,
        allIn: Boolean(anteMatch[3]),
        label: `ante ${formatAmount(amount, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const blindMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): posts (small|big) blind ${MONEY}( and is all-in)?$`),
    );
    if (blindMatch) {
      const player = blindMatch[1];
      const amount = parseAmount(blindMatch[3], unit);
      push({
        street: "preflop",
        seat: seatOf(player),
        player,
        type: blindMatch[2].toLowerCase() === "small" ? "small-blind" : "big-blind",
        amount,
        streetTotal: commit(player, amount),
        allIn: Boolean(blindMatch[4]),
        label: `${blindMatch[2].toLowerCase()} blind ${formatAmount(amount, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    // Dead money: the player owes a blind they sat out for. It goes straight to
    // the pot and does not count toward the current street's bet.
    const missedBlindMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): posts missed blind ${MONEY}$`),
    );
    if (missedBlindMatch) {
      const player = missedBlindMatch[1];
      const amount = parseAmount(missedBlindMatch[2], unit);
      push({
        street: "preflop",
        seat: seatOf(player),
        player,
        type: "missed-blind",
        amount,
        streetTotal: 0,
        allIn: false,
        label: `missed blind ${formatAmount(amount, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    // GG "EV Cashout": settled outside the pot, so it must not change any math.
    const cashoutChoose = trimmed.match(/^(.+?): Chooses to EV Cashout$/);
    if (cashoutChoose) {
      push({
        street,
        seat: seatOf(cashoutChoose[1]),
        player: cashoutChoose[1],
        type: "cashout-choose",
        amount: 0,
        streetTotal: 0,
        allIn: false,
        label: "chooses EV cashout",
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const cashoutPay = trimmed.match(
      new RegExp(String.raw`^(.+?): Pays Cashout Risk \(${MONEY}\)$`),
    );
    if (cashoutPay) {
      push({
        street,
        seat: seatOf(cashoutPay[1]),
        player: cashoutPay[1],
        type: "cashout-pay",
        amount: 0,
        streetTotal: 0,
        allIn: false,
        description: formatAmount(parseAmount(cashoutPay[2], unit), unit),
        label: `pays cashout risk ${formatAmount(parseAmount(cashoutPay[2], unit), unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    // Three verbs, because rooms disagree: PokerStars and WePlay write
    // `posts straddle $4`, GG writes a bare `straddle $0.04`, and a plain
    // `posts $2` is a dead blind. The alternation is spelled out rather than
    // making `posts ` optional so that a stray `Player: 5` cannot match.
    const postMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): (posts straddle|straddle|posts) ${MONEY}( and is all-in)?$`),
    );
    if (postMatch) {
      const player = postMatch[1];
      const verb = postMatch[2];
      const explicitStraddle = verb !== "posts";
      const amount = parseAmount(postMatch[3], unit);
      // Some sites name the straddle; otherwise a bare "posts" before the deal
      // that exceeds the big blind is one, and anything else is dead money.
      const isStraddle =
        explicitStraddle || (street === "preflop" && amount > header.bigBlind);
      if (isStraddle) {
        straddles.push({ player, amount });
      }
      push({
        street,
        seat: seatOf(player),
        player,
        type: isStraddle ? "straddle" : "post",
        amount,
        streetTotal: commit(player, amount),
        allIn: Boolean(postMatch[4]),
        // Echo the room's own verb so the text round-trips; the action type is
        // what code should branch on.
        verb: explicitStraddle ? verb : undefined,
        label: `posts ${formatAmount(amount, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const simple = trimmed.match(/^(.+?): (folds|checks)$/);
    if (simple) {
      const type: ActionType = simple[2] === "folds" ? "fold" : "check";
      if (type === "fold") {
        foldedPlayers.add(simple[1]);
      }
      push({
        street,
        seat: seatOf(simple[1]),
        player: simple[1],
        type,
        amount: 0,
        streetTotal: streetCommit.get(simple[1]) ?? 0,
        allIn: false,
        label: type === "fold" ? "folds" : "checks",
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const callBet = trimmed.match(
      new RegExp(String.raw`^(.+?): (calls|bets) ${MONEY}( and is all-in)?$`),
    );
    if (callBet) {
      const player = callBet[1];
      const amount = parseAmount(callBet[3], unit);
      const type: ActionType = callBet[2] === "calls" ? "call" : "bet";
      push({
        street,
        seat: seatOf(player),
        player,
        type,
        amount,
        streetTotal: commit(player, amount),
        allIn: Boolean(callBet[4]),
        label: `${type === "call" ? "calls" : "bets"} ${formatAmount(amount, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const raiseMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): raises ${MONEY} to ${MONEY}( and is all-in)?$`),
    );
    if (raiseMatch) {
      const player = raiseMatch[1];
      const to = parseAmount(raiseMatch[3], unit);
      const already = streetCommit.get(player) ?? 0;
      const added = to - already;
      streetCommit.set(player, to);
      push({
        street,
        seat: seatOf(player),
        player,
        type: "raise",
        amount: added,
        streetTotal: to,
        allIn: Boolean(raiseMatch[4]),
        label: `raises to ${formatAmount(to, unit)}`,
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const showsMatch = trimmed.match(/^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$/);
    if (showsMatch) {
      const player = showsMatch[1];
      const cards = extractCards(showsMatch[2]);
      const entry = playerByName.get(player);
      if (entry && cards.length > 0) {
        entry.holeCards = cards;
      }
      push({
        street,
        seat: seatOf(player),
        player,
        type: "show",
        amount: 0,
        streetTotal: 0,
        allIn: false,
        cards,
        description: showsMatch[3],
        label: cards.length ? `shows ${cards.join(" ")}` : "shows",
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    const muckMatch = trimmed.match(/^(.+?): (mucks hand|doesn't show hand)$/i);
    if (muckMatch) {
      push({
        street,
        seat: seatOf(muckMatch[1]),
        player: muckMatch[1],
        type: "muck",
        amount: 0,
        streetTotal: 0,
        allIn: false,
        description: muckMatch[2],
        label: "mucks",
        sourceLine: lineNo,
        rawLine: trimmed,
      });
      continue;
    }

    if (CHATTER_REGEX.test(trimmed)) {
      continue;
    }

    warnings.push({ code: "unknown-line", message: trimmed, line: lineNo });
  }

  if (players.length === 0) {
    return null;
  }

  if (!maxSeats) {
    maxSeats = Math.max(players.length, ...players.map((player) => player.seat));
  }

  // Seed geometrically; `assignPositions` re-resolves from the posted blinds
  // once the whole hand is assembled, which is the answer that survives dead
  // buttons and seated-but-not-dealt-in players.
  const positions = resolvePositions(
    players.map((player) => player.seat),
    buttonSeat,
  );
  for (const player of players) {
    player.position = positions.get(player.seat) ?? null;
  }

  // The summary can reveal cards that never appeared in a "shows" line.
  for (const [seat, line] of summarySeatLines) {
    const player = players.find((entry) => entry.seat === seat);
    if (!player) {
      continue;
    }
    const shown = line.match(/(?:showed|mucked)\s+\[([^\]]*)\]/i);
    if (shown && player.holeCards.length === 0) {
      player.holeCards = extractCards(shown[1]);
    }
  }

  // The board the markers built is authoritative; the summary is a cross-check.
  const board: PhfBoard = {
    runouts: runouts.map(
      (run, index): PhfRunout => ({
        index,
        ...run,
        markerLabels: markerLabels[index] ?? {},
        summaryCards: summaryBoards.get(index) ?? null,
      }),
    ),
  };
  if (board.runouts.length === 1 && board.runouts[0].flop === null) {
    const fromSummary = summaryBoards.get(0) ?? [];
    if (fromSummary.length > 0) {
      board.runouts[0] = {
        index: 0,
        flop: fromSummary.slice(0, 3),
        turn: fromSummary[3] ?? null,
        river: fromSummary[4] ?? null,
        markerLabels: {},
        summaryCards: fromSummary,
      };
      warnings.push({ code: "board-from-summary", message: "Board taken from the SUMMARY line." });
    }
  }

  const contributions = new Map<string, Amount>();
  for (const action of actions) {
    if (action.type === "collect" || action.amount === 0) {
      continue;
    }
    contributions.set(action.player, (contributions.get(action.player) ?? 0) + action.amount);
  }

  if (totalPot === 0) {
    totalPot = [...contributions.values()].reduce((sum, value) => sum + value, 0);
  }

  const results = buildResults({
    players,
    actions,
    contributions,
    collectedBy,
    summarySeatLines,
    unit,
    totalPot,
    pots,
    fees,
    heroName,
    board,
    sawShowdownMarker,
    foldedPlayers,
  });

  // Tournament level headers go stale: WePlay keeps printing "Level XI (50/100)"
  // long after the blinds moved on. What was actually posted is the truth for
  // anything that reasons about stack depth, so it wins here; the header value
  // stays available on `tournament.levelSmallBlind` / `levelBigBlind`, which is
  // also what the header is re-serialized from.
  let smallBlind = header.smallBlind;
  let bigBlind = header.bigBlind;
  if (header.tournament) {
    for (const action of actions) {
      if (action.type === "small-blind") {
        smallBlind = Math.max(smallBlind, action.amount);
      } else if (action.type === "big-blind") {
        bigBlind = Math.max(bigBlind, action.amount);
      }
    }
  }

  const anteModel =
    antePosters === 0
      ? "none"
      : antePosters === 1 && players.length > 1
        ? "big-blind-ante"
        : "posted-per-player";

  const hasBlinds = actions.some(
    (action) => action.type === "small-blind" || action.type === "big-blind",
  );
  const bombPot =
    antePosters >= 2 && !hasBlinds
      ? { ante: anteMax, dealtToStreet: "flop" as Street, doubleBoard: board.runouts.length > 1 }
      : null;

  const textStyle: PhfTextStyle = {
    ...DEFAULT_TEXT_STYLE,
    decimals: detectDecimalStyle(rawText),
    dealtLinesForAllPlayers: dealtLineCount > 1,
    showdownSection: sawShowdownMarker,
    holeCardsSection: sawHoleCardsMarker,
    showdownLabels: showdownLabels.length > 0 ? showdownLabels : [""],
    runItTwiceNote: runTwoTimesLine,
    padHour: detectPadHour(header.payload),
  };

  void anteTotal;

  const hand: PhfHand = {
    schema: PHF_SCHEMA,
    meta: {
      siteId: ctx.siteId,
      siteName: ctx.siteName,
      handId: header.handId,
      handKey: header.handId,
      originalFilename: ctx.originalFilename,
      parserId: ctx.parserId ?? "standard",
      parserVersion: ctx.parserVersion ?? STANDARD_TEXT_PARSER_VERSION,
      warnings,
      rawText,
      parsedAt: new Date().toISOString(),
      textStyle,
    },
    game: {
      variant: variantFromLabel(header.gameLabel),
      limit: limitFromLabel(header.gameLabel),
      format: header.tournament ? "tournament" : "cash",
      unit,
      smallBlind,
      bigBlind,
      anteModel,
      ante: anteMax || header.headerAnte,
      straddles: straddles.map((entry, index) => ({
        seat: playerByName.get(entry.player)?.seat ?? -1,
        player: entry.player,
        amount: entry.amount,
        order: index + 1,
      })),
      bombPot,
      label: header.gameLabel,
    },
    table: { name: tableName, maxSeats, buttonSeat },
    tournament: header.tournament,
    players,
    actions,
    board,
    results,
    playedAt: header.playedAt,
  };

  assignPositions(hand);
  return hand;
}

interface PhfGameStraddleDraft {
  player: string;
  amount: Amount;
}

function buildResults(input: {
  players: PhfPlayer[];
  actions: PhfAction[];
  contributions: Map<string, Amount>;
  collectedBy: Map<string, Amount>;
  summarySeatLines: Map<number, string>;
  unit: CurrencyUnit;
  totalPot: Amount;
  pots: Array<{ name: string; amount: Amount }>;
  fees: PhfFees;
  heroName: string | null;
  board: PhfBoard;
  sawShowdownMarker: boolean;
  foldedPlayers: Set<string>;
}): PhfHand["results"] {
  const {
    players,
    actions,
    contributions,
    collectedBy,
    summarySeatLines,
    unit,
    totalPot,
    pots,
    fees,
    heroName,
    board,
    sawShowdownMarker,
    foldedPlayers,
  } = input;

  const shownAtShowdown = new Set(
    actions.filter((action) => action.type === "show").map((action) => action.player),
  );

  const playerResults: PhfPlayerResult[] = players.map((player) => {
    const summaryLine = summarySeatLines.get(player.seat) ?? null;
    const parsed = summaryLine
      ? parseSummarySeatLine(summaryLine, player.name, unit)
      : ({} as Partial<PhfPlayerResult>);
    const won = collectedBy.get(player.name) ?? 0;
    const contributed = contributions.get(player.name) ?? 0;
    return {
      seat: player.seat,
      player: player.name,
      won,
      contributed,
      net: won - contributed,
      wentToShowdown: shownAtShowdown.has(player.name) || parsed.outcome === "showed",
      shownCards: parsed.shownCards ?? [],
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

  const winners = actions
    .filter((action) => action.type === "collect")
    .map((action) => ({
      player: action.player,
      seat: action.seat,
      amount: action.amount,
      runoutIndex: action.runoutIndex,
    }));

  const primary = resolveRunout(board, 0);
  const streetReached: Street =
    primary.length >= 5
      ? "river"
      : primary.length === 4
        ? "turn"
        : primary.length === 3
          ? "flop"
          : "preflop";

  const contenders = players.filter((player) => !foldedPlayers.has(player.name));
  const wentToShowdown = sawShowdownMarker && contenders.length >= 2;

  return {
    totalPot,
    pots,
    fees,
    players: playerResults,
    winners,
    heroNet:
      heroName === null
        ? null
        : (collectedBy.get(heroName) ?? 0) - (contributions.get(heroName) ?? 0),
    wentToShowdown,
    streetReached: wentToShowdown ? "showdown" : streetReached,
  };
}

/** Parses a whole file of standard-format hands. */
export function parseStandardText(
  text: string,
  ctx: Partial<ParseContext> = {},
): PhfHand[] {
  const full: ParseContext = {
    siteId: ctx.siteId ?? "standard",
    siteName: ctx.siteName ?? "PokerConverter standard",
    originalFilename: ctx.originalFilename ?? null,
    parserId: ctx.parserId,
    parserVersion: ctx.parserVersion,
  };
  const out: PhfHand[] = [];
  for (const chunk of splitStandardHands(text)) {
    const hand = parseStandardHand(chunk, full);
    if (hand) {
      out.push(hand);
    }
  }
  return out;
}

/* --------------------------------------------------------------- serializing */

/**
 * Every presentational decision, resolved to a concrete value.
 *
 * `PhfTextStyle` leaves the later-added fields optional so that the eleven site
 * parsers which spread `DEFAULT_TEXT_STYLE` do not silently inherit a wrong
 * default. This turns that tri-state into something the serializer can just
 * use, recovering anything the parser left unset from `meta.rawText` - the
 * source every hand is required to carry.
 */
interface ResolvedStyle {
  decimals: DecimalStyle;
  groupThousands: boolean;
  dealtLineTrailingSpace: boolean;
  summaryFeeColumns: string[];
  /** Verbatim header text to replay, or null to generate one. */
  headerPayload: string | null;
  /** `*** SHOWDOWN ***` or the spaced `*** SHOW DOWN ***` some builds emit. */
  showdownToken: string;
  tournamentNameStyle: "parens" | "inline";
  levelParenSpace: boolean;
}

const DEFAULT_FEE_COLUMNS = ["Rake", "Jackpot", "Bingo", "Fortune", "Tax"];

/** A `Dealt to <player>` line that showed no cards. */
const BLANK_DEALT_LINE = /^Dealt to (?!.*\[).*$/m;

function inferGroupThousands(source: string): boolean {
  // A grouped amount, not a comma in a screen name or in chat.
  return /\d,\d{3}(?!\d)/.test(source);
}

function inferDealtLineTrailingSpace(source: string): boolean {
  const line = source.match(BLANK_DEALT_LINE)?.[0];
  if (line === undefined) {
    // No evidence either way. GG's cash exports - the dialect this format was
    // modelled on - write the trailing space, so that stays the default.
    return true;
  }
  return /\s$/.test(line);
}

function inferFeeColumns(source: string): string[] {
  const line = source.match(/^Total pot\s+.*$/m)?.[0];
  if (line === undefined) {
    return DEFAULT_FEE_COLUMNS;
  }
  if (!line.includes("|")) {
    // GG tournaments print a bare `Total pot 588`. No columns is an answer.
    return [];
  }
  const columns = line
    .split("|")
    // Segment 0 is the pot itself (plus any side-pot breakdown), not a fee.
    .slice(1)
    .map((part) => part.trim().match(/^([A-Za-z][A-Za-z ]*?)\s+\S+$/)?.[1])
    .filter((name): name is string => Boolean(name));
  return columns.length > 0 ? columns : DEFAULT_FEE_COLUMNS;
}

/**
 * The header text the source wrote for this hand, when it is demonstrably the
 * same hand and this module can read it back without losing anything.
 *
 * Replaying it is what keeps rooms with irregular headers byte-exact - GG slips
 * an incidental triple space into `... No Limit   - Level14(300/600)`, which no
 * structured field should ever have to model. The guard is what keeps it
 * honest: if re-reading the captured text disagrees with the hand the parser
 * actually built, the structured generator wins instead.
 */
/**
 * Whether `meta.rawText` is written in the same dialect this hand serializes to.
 *
 * Some parsers normalize rather than preserve: WePlay's rewrites
 * `Weplay Hand #71764146` into `Poker Hand #HD71764146`, drops lines, and
 * expands a one-column `Total pot $11 | Rake $0.55` into the full GG fee set.
 * For those, the source says nothing about how the *output* should look, and
 * reading presentation off it produces exactly the wrong answer. The hand id
 * surviving unchanged is the signal that the parser kept the source's dialect.
 */
function sourcePreservesDialect(hand: PhfHand): boolean {
  const firstLine = (hand.meta.rawText ?? "").replace(/^\ufeff/, "").split(/\r?\n/)[0] ?? "";
  const match = firstLine.match(HEADER_REGEX);
  return Boolean(match && match[1] === hand.meta.handId);
}

function capturedHeaderPayload(hand: PhfHand): string | null {
  const pinned = hand.meta.textStyle.headerPayload;
  if (pinned !== undefined) {
    return pinned;
  }
  const firstLine = hand.meta.rawText.replace(/^\ufeff/, "").split(/\r?\n/)[0] ?? "";
  const match = firstLine.match(HEADER_REGEX);
  if (!match || match[1] !== hand.meta.handId) {
    return null;
  }
  const payload = match[2];

  const reread = parseHeader(hand.meta.handId, payload);
  const tour = hand.tournament;
  const sameFormat = (reread.tournament === null) === (tour === null);
  if (!sameFormat) {
    return null;
  }
  if (
    reread.smallBlind !== hand.game.smallBlind ||
    reread.bigBlind !== hand.game.bigBlind ||
    reread.playedAt !== hand.playedAt ||
    reread.gameLabel !== hand.game.label
  ) {
    return null;
  }
  if (
    tour &&
    reread.tournament &&
    (reread.tournament.id !== tour.id ||
      reread.tournament.levelSmallBlind !== tour.levelSmallBlind ||
      reread.tournament.levelBigBlind !== tour.levelBigBlind)
  ) {
    return null;
  }
  return payload;
}

function resolveTextStyle(hand: PhfHand): ResolvedStyle {
  const style = hand.meta.textStyle;
  // Only read presentation off the source when the source is in the dialect we
  // are about to write; otherwise fall back to the format's own defaults.
  const source = sourcePreservesDialect(hand) ? (hand.meta.rawText ?? "") : "";
  const headerPayload = capturedHeaderPayload(hand);
  // Layout is observable from the source header even when the semantic guard
  // rejected replaying it verbatim, so read it from the line rather than from
  // the capture. With no source in this dialect, keep the format's own shape:
  // `Tournament (Name)#id, $15+$1.50 ... - Level XI (50/100)`.
  const sourceHeader = source.split(/\r?\n/)[0] ?? "";
  const tournamentClause = sourceHeader.match(/:\s*(Tournament\b.*)$/)?.[1] ?? "";
  return {
    decimals: style.decimals,
    groupThousands: style.groupThousands ?? inferGroupThousands(source),
    dealtLineTrailingSpace:
      style.dealtLineTrailingSpace ?? inferDealtLineTrailingSpace(source),
    summaryFeeColumns: style.summaryFeeColumns ?? inferFeeColumns(source),
    headerPayload,
    // GG prints the name inline between the id and the game label; WePlay wraps
    // it in parentheses before the id.
    showdownToken: /\*\*\*\s*(?:FIRST |SECOND |THIRD )?SHOW DOWN\s*\*\*\*/.test(source)
      ? "SHOW DOWN"
      : "SHOWDOWN",
    tournamentNameStyle:
      tournamentClause && !/^Tournament\s*\(/.test(tournamentClause) ? "inline" : "parens",
    // `Level XI (50/100)` versus GG's glued `Level14(300/600)`.
    levelParenSpace: /Level\s*\S+?\s\(/.test(tournamentClause) || !/Level/.test(tournamentClause),
  };
}

export interface SerializeOptions {
  /**
   * Regenerate summary seat lines from structured data instead of replaying the
   * captured `raw` string. Only used by tests that check the generator.
   */
  regenerateSummary?: boolean;
}

/**
 * PHF -> standard text.
 *
 * Byte-compatible with what `converter.ts` used to emit for the WePlay corpus
 * and with the raw text of every hand in `gg-hh/`.
 */
export function toStandardText(hand: PhfHand, options: SerializeOptions = {}): string {
  const unit = hand.game.unit;
  const style = resolveTextStyle(hand);
  const lines: string[] = [];
  const money = (amount: Amount) =>
    formatAmount(amount, unit, style.decimals, style.groupThousands);

  // `raises X to Y` prints X as the amount *over the current bet*, not as the
  // chips the raiser adds, so rendering needs the betting state of the street.
  let currentBet = 0;
  function render(action: PhfAction): string {
    const line = actionLine(action, unit, style, currentBet);
    switch (action.type) {
      case "bet":
      case "raise":
        currentBet = action.streetTotal;
        break;
      case "small-blind":
      case "big-blind":
      case "straddle":
      case "post":
        currentBet = Math.max(currentBet, action.streetTotal);
        break;
      default:
        break;
    }
    return line;
  }

  lines.push(
    `Poker Hand #${hand.meta.handId}: ${style.headerPayload ?? headerPayload(hand, style)}`,
  );
  lines.push(tableLine(hand));

  for (const player of [...hand.players].sort((a, b) => a.seat - b.seat)) {
    lines.push(
      `Seat ${player.seat}: ${player.name} (${money(player.startingStack)} in chips)`,
    );
  }

  const preDeal = hand.actions.filter(
    (action) =>
      action.type === "ante" ||
      action.type === "small-blind" ||
      action.type === "big-blind" ||
      action.type === "missed-blind" ||
      (action.type === "straddle" && action.street === "preflop"),
  );
  for (const action of preDeal) {
    lines.push(render(action));
  }

  if (hand.meta.textStyle.holeCardsSection) {
    lines.push("*** HOLE CARDS ***");
    for (const player of [...hand.players].sort((a, b) => a.seat - b.seat)) {
      if (!player.dealtAnnounced) {
        continue;
      }
      // A seat with unknown cards still gets a line, with a trailing space -
      // that is literally what GG writes and trackers match on it.
      lines.push(
        player.dealtCards.length > 0
          ? `Dealt to ${player.name} [${player.dealtCards.join(" ")}]`
          : `Dealt to ${player.name}${style.dealtLineTrailingSpace ? " " : ""}`,
      );
    }
  }

  const bodyActions = hand.actions.filter((action) => !preDeal.includes(action));
  const emitted = new Set<PhfAction>();

  function emitFor(street: Street, runoutIndex: number | null): void {
    for (const action of bodyActions) {
      if (
        action.street === street &&
        (runoutIndex === null || action.runoutIndex === runoutIndex) &&
        !emitted.has(action)
      ) {
        emitted.add(action);
        lines.push(render(action));
      }
    }
  }

  emitFor("preflop", 0);

  const runCount = hand.board.runouts.length;
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const run = hand.board.runouts[runIndex];
    const resolved = resolveRunout(hand.board, runIndex);
    // Reproduce the prefix the source used; fall back to the positional one.
    const prefix = (street: "flop" | "turn" | "river") => {
      const printed = run.markerLabels?.[street];
      const label = printed ?? (runCount > 1 ? RUN_PREFIXES[runIndex] : "");
      return label ? `${label} ` : "";
    };
    if (run.flop) {
      lines.push(`*** ${prefix("flop")}FLOP *** [${resolved.slice(0, 3).join(" ")}]`);
      currentBet = 0;
      emitFor("flop", runIndex);
    }
    const listed = markerPrefixOrder(run, resolved);
    if (run.turn) {
      lines.push(
        `*** ${prefix("turn")}TURN *** [${listed.slice(0, 3).join(" ")}] [${resolved[3]}]`,
      );
      currentBet = 0;
      emitFor("turn", runIndex);
    }
    if (run.river) {
      lines.push(
        `*** ${prefix("river")}RIVER *** [${listed.slice(0, 4).join(" ")}] [${resolved[4]}]`,
      );
      currentBet = 0;
      emitFor("river", runIndex);
    }
  }

  if (hand.meta.textStyle.showdownSection) {
    const labels = hand.meta.textStyle.showdownLabels.length
      ? hand.meta.textStyle.showdownLabels
      : [runCount > 1 ? RUN_PREFIXES[0] : ""];
    for (let i = 0; i < labels.length; i += 1) {
      lines.push(`*** ${labels[i] ? `${labels[i]} ` : ""}${style.showdownToken} ***`);
      // One showdown block settles every runout; several split them by runout.
      emitFor("showdown", labels.length === 1 ? null : i);
    }
  }

  // Anything the ordering rules above did not place (defensive: a hand-built
  // PHF could tag an action with a street that has no marker).
  for (const action of bodyActions) {
    if (!emitted.has(action)) {
      emitted.add(action);
      lines.push(render(action));
    }
  }

  lines.push("*** SUMMARY ***");
  lines.push(summaryPotLine(hand, style));
  if (hand.meta.textStyle.runItTwiceNote && runCount > 1) {
    lines.push(`Hand was run ${RUN_WORDS[runCount] ?? `${runCount} times`}`);
  }
  for (const line of boardLines(hand)) {
    lines.push(line);
  }
  for (const player of [...hand.players].sort((a, b) => a.seat - b.seat)) {
    const result = hand.results.players.find((entry) => entry.seat === player.seat);
    if (!result) {
      continue;
    }
    if (!options.regenerateSummary && result.raw) {
      lines.push(result.raw);
      continue;
    }
    const generated = generateSummarySeatLine(hand, player, result, style);
    if (generated) {
      lines.push(generated);
    }
  }

  return lines.join("\n");
}

function headerPayload(hand: PhfHand, style: ResolvedStyle): string {
  const unit = hand.game.unit;
  const date = formatPlayedAt(hand.playedAt, hand.meta.textStyle.padHour);
  const money = (amount: Amount, amountUnit: CurrencyUnit) =>
    formatAmount(amount, amountUnit, style.decimals, style.groupThousands);
  const digits = (amount: Amount) =>
    formatAmountDigits(amount, unit, style.decimals, style.groupThousands);
  const tour = hand.tournament;

  if (tour) {
    // Buy-in components: `$4.50+$4.50+$1` knockout, `$15+$1.50` plain, `$55`
    // when the room prints no fee at all. Never invent a `+$0`.
    const parts = [money(tour.buyIn, tour.buyInUnit)];
    if (tour.bounty) {
      parts.push(money(tour.bounty, tour.buyInUnit));
    }
    if (tour.fee || tour.bounty) {
      parts.push(money(tour.fee, tour.buyInUnit));
    }
    const buyInToken = parts.join("+");

    // `Level XI (…)` when the room numbers levels in roman, `Level14(…)` when
    // it glues an arabic numeral to the word, which is what GG does.
    const levelLabel = tour.levelLabel ?? numberToRoman(tour.levelNumber ?? 1);
    const arabic = /^\d+$/.test(levelLabel);
    const level = `Level${arabic ? "" : " "}${levelLabel}${style.levelParenSpace ? " " : ""}`;
    const stakes = `(${digits(tour.levelSmallBlind)}/${digits(tour.levelBigBlind)})`;

    if (style.tournamentNameStyle === "parens") {
      const name = tour.name ? `(${tour.name})` : "";
      return `Tournament ${name}#${tour.id}, ${buyInToken} ${hand.game.label} - ${level}${stakes} - ${date}`;
    }
    // Inline: GG writes the name - buy-in text and all - between the id and the
    // game label, so echo it rather than re-deriving a token it never printed.
    const lead = tour.name ?? buyInToken;
    return `Tournament #${tour.id}, ${lead} ${hand.game.label} - ${level}${stakes} - ${date}`;
  }

  const stakes = `${money(hand.game.smallBlind, unit)}/${money(hand.game.bigBlind, unit)}`;
  return `${hand.game.label} (${stakes}) - ${date}`;
}

function sameCardSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((card, index) => card === right[index]);
}

/**
 * The order a TURN or RIVER marker re-lists the board in.
 *
 * Normally the same order the cards were dealt in, but some GG builds deal
 * `*** FLOP *** [Ad 7d 9d]` and then re-list that identical flop as
 * `[7d 9d Ad]` on every later street and in the SUMMARY. When the summary's
 * order is a re-ordering of the same flop - never a different set of cards -
 * the later markers follow it.
 */
function markerPrefixOrder(runout: PhfRunout | undefined, resolved: string[]): string[] {
  const summary = runout?.summaryCards;
  if (!summary || summary.length !== resolved.length || summary.length < 3) {
    return resolved;
  }
  if (!sameCardSet(summary.slice(0, 3), resolved.slice(0, 3))) {
    return resolved;
  }
  return summary;
}

function tableLine(hand: PhfHand): string {
  const button =
    hand.table.buttonSeat === null ? "" : ` Seat #${hand.table.buttonSeat} is the button`;
  return `Table '${hand.table.name ?? ""}' ${hand.table.maxSeats}-max${button}`;
}

function actionLine(
  action: PhfAction,
  unit: CurrencyUnit,
  style: ResolvedStyle,
  currentBet: Amount,
): string {
  const money = (amount: Amount) =>
    formatAmount(Math.abs(amount), unit, style.decimals, style.groupThousands);
  const allIn = action.allIn ? " and is all-in" : "";
  switch (action.type) {
    case "ante":
      return `${action.player}: posts the ante ${money(action.amount)}${allIn}`;
    case "small-blind":
      return `${action.player}: posts small blind ${money(action.amount)}${allIn}`;
    case "big-blind":
      return `${action.player}: posts big blind ${money(action.amount)}${allIn}`;
    case "missed-blind":
      return `${action.player}: posts missed blind ${money(action.amount)}`;
    case "straddle":
    case "post":
    case "bomb-ante":
      return `${action.player}: ${action.verb ?? "posts"} ${money(action.amount)}${allIn}`;
    case "fold":
      return `${action.player}: folds`;
    case "check":
      return `${action.player}: checks`;
    case "call":
      return `${action.player}: calls ${money(action.amount)}${allIn}`;
    case "bet":
      return `${action.player}: bets ${money(action.amount)}${allIn}`;
    case "raise":
      return `${action.player}: raises ${money(action.streetTotal - currentBet)} to ${money(action.streetTotal)}${allIn}`;
    case "uncalled":
      return `Uncalled bet (${money(action.amount)}) returned to ${action.player}`;
    case "collect":
      return `${action.player} collected ${money(action.amount)} from ${action.potName ?? "pot"}`;
    case "show":
      return `${action.player}: shows [${(action.cards ?? []).join(" ")}]${
        action.description ? ` (${action.description})` : ""
      }`;
    case "muck":
      return `${action.player}: ${action.description ?? "doesn't show hand"}`;
    case "cashout-choose":
      return `${action.player}: Chooses to EV Cashout`;
    case "cashout-pay":
      return `${action.player}: Pays Cashout Risk (${action.description ?? money(0)})`;
    default:
      return action.rawLine;
  }
}

function summaryPotLine(hand: PhfHand, style: ResolvedStyle): string {
  const unit = hand.game.unit;
  const fees = hand.results.fees;
  const money = (amount: Amount) =>
    formatAmount(amount, unit, style.decimals, style.groupThousands);
  // Side pots are appended to the pot total the way the sites write them, each
  // terminated with a period: "Total pot $103.11 Main pot $37.15. Side pot $65.96."
  const breakdown = hand.results.pots
    .map((pot) => ` ${pot.name} pot ${money(pot.amount)}.`)
    .join("");
  // Rooms print between one and five fee columns; echo the set this one used.
  const byName: Record<string, Amount> = {
    Rake: fees.rake,
    Jackpot: fees.jackpot,
    Bingo: fees.bingo,
    Fortune: fees.fortune,
    Tax: fees.tax,
  };
  const columns = style.summaryFeeColumns
    .map((name) => ` | ${name} ${money(byName[name] ?? 0)}`)
    .join("");
  return `Total pot ${money(hand.results.totalPot)}${breakdown}${columns}`;
}

function boardLines(hand: PhfHand): string[] {
  const runCount = hand.board.runouts.length;
  if (runCount === 1) {
    const captured = hand.board.runouts[0]?.summaryCards;
    const cards = captured ?? resolveRunout(hand.board, 0);
    return cards.length > 0 ? [`Board [${cards.join(" ")}]`] : [];
  }
  const out: string[] = [];
  for (let i = 0; i < runCount; i += 1) {
    const label = RUN_PREFIXES[i];
    const run = hand.board.runouts[i];
    if (run.summaryCards) {
      out.push(`${label} Board [${run.summaryCards.join(" ")}]`);
      continue;
    }
    if (i === 0) {
      out.push(`${label} Board [${resolveRunout(hand.board, 0).join(" ")}]`);
      continue;
    }
    // Without a captured line, later runouts list only the cards that actually
    // differ; a shared flop is not repeated, which is how GG prints it.
    const resolved = resolveRunout(hand.board, i);
    const cards: string[] = [];
    if (run.flop) {
      cards.push(...resolved.slice(0, 3));
    }
    if (run.turn) {
      cards.push(resolved[3]);
    }
    if (run.river) {
      cards.push(resolved[4]);
    }
    out.push(`${label} Board [${cards.join(" ")}]`);
  }
  return out;
}

/**
 * Canonical summary line for parsers that do not carry a `raw` string.
 *
 * This reproduces the common grammar; the exotic compound phrasings GG emits
 * for run-it-twice ("... and won ($x) with two pair, ..., and lost") are only
 * reachable through `raw`, which is why `raw` exists.
 */
function generateSummarySeatLine(
  hand: PhfHand,
  player: PhfPlayer,
  result: PhfPlayerResult,
  style: ResolvedStyle,
): string | null {
  const unit = hand.game.unit;
  const money = (amount: Amount) =>
    formatAmount(amount, unit, style.decimals, style.groupThousands);
  const labels = result.positionLabels.length
    ? ` ${result.positionLabels.join(" ")}`
    : "";
  const head = `Seat ${player.seat}: ${player.name}${labels}`;

  switch (result.outcome) {
    case "folded": {
      const where =
        result.foldedStreet === null || result.foldedStreet === "preflop"
          ? "folded before Flop"
          : `folded on the ${capitalize(result.foldedStreet)}`;
      return `${head} ${where}${result.didntBet ? " (didn't bet)" : ""}`;
    }
    case "mucked":
      return `${head} mucked`;
    case "collected":
      return `${head} collected (${money(result.won)})`;
    case "won":
      return result.shownCards.length > 0
        ? `${head} showed [${result.shownCards.join(" ")}] and won (${money(result.won)})${
            result.handDescription ? ` with ${result.handDescription}` : ""
          }`
        : `${head} won (${money(result.won)})`;
    case "lost":
      return `${head} showed [${result.shownCards.join(" ")}] and lost${
        result.handDescription ? ` with ${result.handDescription}` : ""
      }`;
    case "showed":
      return `${head} showed [${result.shownCards.join(" ")}]`;
    default:
      return result.won > 0 ? `${head} collected (${money(result.won)})` : null;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Convenience: many hands to one file, separated the way the app has always done. */
export function toStandardTextFile(hands: PhfHand[], options: SerializeOptions = {}): string {
  return hands.map((hand) => toStandardText(hand, options)).join("\n\n");
}

/** Re-exported so callers do not have to reach into `types` for totals. */
export { totalFees };
