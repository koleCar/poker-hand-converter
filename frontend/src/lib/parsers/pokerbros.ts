/**
 * PokerBros parser.
 *
 * PokerBros is a live club/agent app with **no published native export**. Every
 * byte anyone has ever shown is third-party converter output, and the two real
 * files we have encode the *same hand* in two different converter dialects:
 *
 * - **Dialect A**, party-classic: a `***** Hand History for Game N ***** (PokerBros)`
 *   banner, bracketed amounts, HUD stats glued onto the seat lines, no SUMMARY
 *   block, no uncalled-bet line. That is the PartyGaming grammar, so it is read
 *   with the PartyGaming machinery in `shared/p2-*.ts`: the pot, the rake and
 *   the uncalled return all have to be *derived*, which is exactly what
 *   `p2-handbuilder` exists to do.
 * - **Dialect B**, PokerStars-family: an honest `PokerBros Hand #` header and a
 *   grammar that is PokerStars' own, read with `shared/p3-stars-dialect.ts`.
 *
 * So "the PokerBros format" is really "whatever a converter emits", plural, and
 * this parser covers the two dialects that have been seen rather than claiming a
 * format nobody has published. Expect more dialects in the wild.
 *
 * Fixtures: `fixtures/samples/pokerbros/` (two files, one hand).
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  DEFAULT_TEXT_STYLE,
  parseAmount,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import {
  PARTY_DATE_REGEX,
  PARTY_GAME_REGEX,
  bracketAmount,
  isNoiseLine,
  isoFromPartyDate,
  knownZone,
  unitFor,
} from "./shared/p2-partygaming";
import {
  buildHand,
  type DraftAction,
  type DraftCollect,
  type DraftSeat,
  type DraftStreet,
  type HandDraft,
} from "./shared/p2-handbuilder";
import {
  StarsHandDraft,
  detectDecimals,
  detectPadHour,
  hasUnsupportedCurrency,
  limitFromLabel,
  normalizeNewlines,
  stripBom,
  toLines,
  unitForStakes,
  variantFromLabel,
  type DraftGame,
} from "./shared/p3-draft";
import { parseStarsFamilyBody } from "./shared/p3-stars-dialect";

export const POKERBROS_PARSER_VERSION = "1.0.0";

/* ------------------------------------------------------------- detection --- */

/**
 * Dialect A's banner.
 *
 * The trailing `(PokerBros)` is the whole signature: without it the line is a
 * partypoker/888 banner, and `shared/p2-partygaming.ts`'s `BANNER_REGEX`
 * deliberately anchors at the closing stars, so a PokerBros file is not claimed
 * by those two rooms. It must not be claimed by them - the stakes line means
 * something different here.
 */
const PARTY_BANNER_REGEX =
  /^\*{3,}\s*Hand History for Game\s+(\d+)\s*\*{3,}\s*\((PokerBros)\)\s*$/im;

/** Dialect B's header: honest about the room, PokerStars about everything else. */
const STARS_HEADER_REGEX = /^PokerBros Hand #(\d+):\s*(.*)$/;
/** Anchored, for a single chunk; the `_LINE` twin scans a whole file. */
const STARS_HEADER_PREFIX = /^PokerBros Hand #\d+:/;
const STARS_HEADER_LINE = /^PokerBros Hand #\d+:/m;

/* --------------------------------------------------------- dialect B (PS) --- */

function blindsFrom(stakesText: string, unit: CurrencyUnit): { sb: Amount; bb: Amount } {
  const match = stakesText.match(/^\s*(\S+)\/(\S+)/);
  if (!match) {
    return { sb: 0, bb: parseAmount(stakesText.trim(), unit) };
  }
  return { sb: parseAmount(match[1], unit), bb: parseAmount(match[2], unit) };
}

/** `Hold'em No Limit ($0.5/$1 USD) - 2021/03/19 19:51:54 UTC` */
function parseStarsHeader(line: string): { handId: string; payload: string; game: DraftGame } | null {
  const match = line.match(STARS_HEADER_REGEX);
  if (!match) {
    return null;
  }
  const cash = match[2].match(/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/);
  if (!cash) {
    return null;
  }
  const label = cash[1].trim();
  const unit = unitForStakes(cash[2], CHIPS);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(cash[2], unit);
  return {
    handId: match[1],
    payload: match[2],
    game: {
      variant: variantFromLabel(label),
      limit: limitFromLabel(label),
      format: "cash",
      label,
      unit,
      smallBlind: blinds.sb,
      bigBlind: blinds.bb,
    },
  };
}

/** `2021/03/19 19:51:54 UTC`; the dialect states the zone, so nothing is guessed. */
function parseStarsPlayedAt(payload: string): string | null {
  const match = payload.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseStarsDialect(raw: string, ctx: SiteParserContext): PhfHand {
  const text = stripBom(raw).trim();
  const lines = toLines(text);
  if (hasUnsupportedCurrency(lines[0] ?? "")) {
    throw new ParseSkip(
      "unsupported-currency",
      `PHF has no unit for the currency in "${lines[0]}".`,
    );
  }
  const header = parseStarsHeader(lines[0] ?? "");
  if (!header) {
    throw new ParseSkip("normalized-unparseable", "The chunk has no readable PokerBros header.");
  }
  if (header.game.variant !== "holdem") {
    throw new ParseSkip(
      "unsupported-variant",
      `${header.game.label} is not supported yet; the hand is kept for a future parser.`,
    );
  }

  const draft = new StarsHandDraft({
    siteId: "pokerbros",
    siteName: "PokerBros",
    parserId: "pokerbros",
    parserVersion: POKERBROS_PARSER_VERSION,
    handId: header.handId,
    handKey: `PB${header.handId}`,
    rawText: text,
    originalFilename: ctx.sourceFilename,
    game: header.game,
    tournament: null,
    playedAt: parseStarsPlayedAt(header.payload),
    textStyle: {
      ...DEFAULT_TEXT_STYLE,
      decimals: detectDecimals(text),
      padHour: detectPadHour(header.payload),
    },
  });

  const body = parseStarsFamilyBody(lines, draft, header.game.unit);

  if (draft.playerCount() === 0) {
    throw new ParseSkip("no-seat-block", "The hand lists no seats, so nobody can be attributed.");
  }
  // The one confirmed hand puts the button on seat 2 of a table whose occupied
  // seats are 1, 3, 4, 5 and 6, while its dialect-A twin says seat 1 - so this
  // converter's button number is not reliable. It is kept exactly as printed
  // rather than re-derived: `assignPositions` in the core anchors the ring on
  // the posted blinds, so the positions come out right regardless, and quietly
  // rewriting the source would hide a converter bug worth seeing.
  if (body.buttonSeat !== null && !body.seats.includes(body.buttonSeat)) {
    draft.warn(
      "button-seat-empty",
      `The table line puts the button on seat ${body.buttonSeat}, which nobody occupies; ` +
        "the seat number is kept as printed and the ring is resolved from the blinds.",
    );
  }

  const hand = draft.build();
  const seated = draft.seatedNames();
  const stranger = hand.actions.find((action) => !seated.has(action.player));
  if (stranger) {
    throw new ParseSkip(
      "unseated-actor",
      `"${stranger.player}" acts but is not in the seat block.`,
    );
  }
  return hand;
}

/* ------------------------------------------------------ dialect A (party) --- */

const A_TABLE_REGEX = /^Table\s+(.+?)\s+\((Real|Play) Money\)\s*$/i;
const A_BUTTON_REGEX = /^Seat\s+(\d+)\s+is the button\s*$/i;
/** `Seat 1: Hero ( $122.40 USD ) - (21.60 / 16.35 / 5.71 / 18k)` */
const A_SEAT_REGEX = /^Seat\s+(\d+):\s+(.+?)\s+\(\s*([^)]*?)\s*\)(?:\s+-\s+\(([^)]*)\))?\s*$/;
const A_STREET_REGEX =
  /^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?/i;
const A_SEAT_COUNT_REGEX = /^Total number of players\s*:\s*(\d+)/i;

/**
 * Dialect A, the party-classic converter output.
 *
 * Amounts are bracketed and mean two different things depending on the verb:
 * `raises [$2.50]` is the raise *to* total while `calls [$2.00]` is the chips
 * added. That is not a guess - the dialect-B twin of this very hand writes the
 * same two actions as `raises $1.5 to $2.5` and `calls $2.0`.
 */
function parsePartyDialect(raw: string, ctx: SiteParserContext): PhfHand {
  const text = raw.replace(/^﻿/, "").trimEnd();
  const lines = text.split(/\r?\n/);
  const warnings: PhfWarning[] = [];

  const bannerIndex = lines.findIndex((line) => PARTY_BANNER_REGEX.test(line.trim()));
  const banner = lines[bannerIndex]?.trim().match(PARTY_BANNER_REGEX);
  if (!banner) {
    throw new ParseSkip("normalized-unparseable", "The chunk has no PokerBros banner line.");
  }
  const handId = banner[1];

  const stakesLine = (lines[bannerIndex + 1] ?? "").trim();
  const date = stakesLine.match(PARTY_DATE_REGEX);
  const game = date?.[1].match(PARTY_GAME_REGEX);
  if (!date || !game) {
    throw new ParseSkip(
      "normalized-unparseable",
      "The PokerBros stakes line is missing or unreadable, so the game is unknown.",
    );
  }
  if (!/(?:texas\s+)?hold\s*'?em|holdem/i.test(game[7])) {
    throw new ParseSkip(
      "unsupported-variant",
      `Round one is Hold'em only; this hand is "${game[7].trim()}".`,
    );
  }
  // `$100.00 USD NL Holdem`: the single number is the table's maximum buy-in,
  // not the stakes - the blinds appear nowhere in the header and always come
  // from what was posted. The buy-in itself has no home in PHF and is dropped.
  const unit = unitFor(game[1] || game[3]);
  const playedAt = isoFromPartyDate(date[2], date[3], date[4], date[5], date[6], date[7], date[8]);
  if (!knownZone(date[7])) {
    warnings.push({
      code: "unknown-timezone",
      message: `Timezone "${date[7]}" is not in the offset table; the hand is timed as UTC.`,
    });
  }
  // The clock is 12-hour without a meridiem: this file says `07:51:54 ET` for
  // the hand its dialect-B twin timestamps `19:51:54 UTC`. The printed wall
  // clock is kept as-is rather than shifted on a guess, and flagged.
  warnings.push({
    code: "ambiguous-timestamp",
    message:
      `The header time "${date[4]}:${date[5]}:${date[6]} ${date[7]}" is a 12-hour clock with ` +
      "no AM/PM marker, so the hand may be twelve hours out.",
  });

  const seats: DraftSeat[] = [];
  const actions: DraftAction[] = [];
  const collected: DraftCollect[] = [];
  let street: DraftStreet = "preflop";
  let flop: string[] | null = null;
  let turn: string | null = null;
  let river: string | null = null;
  let buttonSeat: number | null = null;
  let tableName: string | null = null;
  let maxSeats = 0;

  const money = (bracket: string) => bracketAmount(bracket, unit);
  const seatNames = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    if (i === bannerIndex || i === bannerIndex + 1) {
      continue;
    }
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const table = line.match(A_TABLE_REGEX);
    if (table) {
      tableName = table[1];
      continue;
    }
    const button = line.match(A_BUTTON_REGEX);
    if (button) {
      buttonSeat = Number(button[1]);
      continue;
    }
    const seatCount = line.match(A_SEAT_COUNT_REGEX);
    if (seatCount) {
      maxSeats = Number(seatCount[1]);
      continue;
    }
    const seat = line.match(A_SEAT_REGEX);
    if (seat) {
      // The fourth group is this converter's HUD tuple - VPIP / PFR / 3-bet /
      // hands played. They are aggregates about the player, not facts about this
      // hand, and PHF has nowhere to put them, so they are dropped on purpose.
      seats.push({
        seat: Number(seat[1]),
        name: seat[2],
        startingStack: parseAmount(seat[3].replace(/[^\d.,]/g, ""), unit),
        dealtIn: true,
        isHero: seat[2] === "Hero",
        dealtCards: [],
      });
      seatNames.add(seat[2]);
      continue;
    }

    const marker = line.match(A_STREET_REGEX);
    if (marker) {
      const kind = marker[1].toLowerCase();
      const cards = extractCards(marker[2] ?? "");
      if (kind === "down cards") {
        street = "preflop";
      } else if (kind === "flop") {
        street = "flop";
        flop = cards.slice(0, 3);
      } else if (kind === "turn") {
        street = "turn";
        turn = cards[cards.length - 1] ?? null;
      } else {
        street = "river";
        river = cards[cards.length - 1] ?? null;
      }
      continue;
    }

    const dealt = line.match(/^Dealt to\s+(.+?)\s*\[\s*([^\]]*?)\s*\]\s*$/);
    if (dealt) {
      const target = seats.find((entry) => entry.name === dealt[1]);
      if (target) {
        target.dealtCards = extractCards(dealt[2]);
      } else {
        warnings.push({ code: "dealt-to-unseated", message: line, line: i + 1 });
      }
      continue;
    }

    const blind = line.match(/^(.+?)\s+posts\s+(small|big)\s+blind\s+\[([^\]]*)\]\.?\s*$/i);
    if (blind) {
      actions.push({
        street,
        player: blind[1],
        kind: blind[2].toLowerCase() === "small" ? "small-blind" : "big-blind",
        amount: money(blind[3]),
      });
      continue;
    }

    const simple = line.match(/^(.+?)\s+(folds|checks)\s*$/i);
    if (simple && seatNames.has(simple[1])) {
      actions.push({
        street,
        player: simple[1],
        kind: simple[2].toLowerCase() === "folds" ? "fold" : "check",
      });
      continue;
    }

    const wager = line.match(/^(.+?)\s+(bets|calls|raises)\s+\[([^\]]*)\]\s*$/i);
    if (wager && seatNames.has(wager[1])) {
      const verb = wager[2].toLowerCase();
      actions.push({
        street,
        player: wager[1],
        kind: verb === "raises" ? "raise" : verb === "calls" ? "call" : "bet",
        amount: money(wager[3]),
        // A raise states the total it raises *to*; a bet and a call state the
        // chips added. See the header comment for the cross-dialect evidence.
        toTotal: verb === "raises",
      });
      continue;
    }

    const wins = line.match(/^(.+?)\s+wins\s+([^\s]+)\s*(?:USD|EUR|GBP)?\s*(?:from (?:the )?(.+?))?\s*$/i);
    if (wins && seatNames.has(wins[1])) {
      collected.push({
        player: wins[1],
        amount: parseAmount(wins[2], unit),
        potName: wins[3]?.trim(),
      });
      continue;
    }

    if (isNoiseLine(line)) {
      continue;
    }
    warnings.push({ code: "unknown-line", message: line, line: i + 1 });
  }

  if (seats.length === 0) {
    throw new ParseSkip("no-seat-block", "The hand lists no seats, so nobody can be attributed.");
  }
  // The deal line and the seat named `Hero` disagree in the one confirmed
  // dialect-A file: seat 1 is called `Hero` while the face-up cards go to seat
  // 3, whose dialect-B twin holds two different cards. Nothing inside the file
  // says which is right, so the source is followed literally - the face-up seat
  // is the hero, as in every other room - and the disagreement is flagged.
  const namedHero = seats.find((entry) => entry.isHero);
  const dealtTo = seats.find((entry) => entry.dealtCards.length > 0);
  if (namedHero && dealtTo && namedHero !== dealtTo) {
    warnings.push({
      code: "hero-attribution",
      message:
        `Seat ${namedHero.seat} is named "${namedHero.name}" but the face-up cards were dealt to ` +
        `seat ${dealtTo.seat} (${dealtTo.name}); this converter is known to mis-attribute them.`,
    });
  }

  const draft: HandDraft = {
    siteId: "pokerbros",
    siteName: "PokerBros",
    parserId: "pokerbros",
    parserVersion: POKERBROS_PARSER_VERSION,
    handPrefix: "PB",
    handId,
    gameLabel: "Hold'em No Limit",
    unit,
    decimals: "fixed2",
    // The header states a maximum buy-in, never the blinds; both come from what
    // was posted.
    headerSmallBlind: 0,
    headerBigBlind: 0,
    tableName,
    maxSeats: maxSeats || Math.max(...seats.map((entry) => entry.seat)),
    buttonSeat,
    playedAt,
    seats,
    actions,
    flop,
    turn,
    river,
    collected,
    // This dialect never prints an uncalled return, exactly like the partypoker
    // grammar it copies, so the winner's own overbet comes back inside `wins`
    // and `p2-handbuilder` has to take it out again. The one confirmed hand was
    // called down and so does not exercise it.
    collectedIncludesUncalled: true,
    rawText: text,
    warnings,
  };

  const hand = buildHand(draft, ctx);
  // `buildHand` folds the prefix into the id it re-reads from its own text;
  // PHF wants the site's own id on `handId` and the namespaced one as the key.
  hand.meta.handId = handId;
  hand.meta.handKey = `PB${handId}`;
  return hand;
}

/* --------------------------------------------------------------- the parser */

export const pokerbrosParser: SiteParser = {
  id: "pokerbros",
  name: "PokerBros",
  version: POKERBROS_PARSER_VERSION,

  detect(text: string): number {
    const head = normalizeNewlines(stripBom(text));
    // Both signatures name the room in a place no other room writes it.
    if (STARS_HEADER_LINE.test(head) || PARTY_BANNER_REGEX.test(head)) {
      return 0.95;
    }
    if (/\bPokerBros\b/.test(head)) {
      return 0.3;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    const normalized = normalizeNewlines(stripBom(text));
    // A file is one dialect or the other; nothing in the wild mixes them, and
    // splitting on both would cut a hand in half if one ever did.
    if (STARS_HEADER_LINE.test(normalized)) {
      return normalized
        .split(/(?=^PokerBros Hand #\d+:)/m)
        .map((chunk) => chunk.trim())
        .filter((chunk) => STARS_HEADER_PREFIX.test(chunk));
    }
    return normalized
      .split(/(?=^\*{3,}\s*Hand History for Game\s+\d+\s*\*{3,}\s*\(PokerBros\))/m)
      .map((chunk) => chunk.trim())
      .filter((chunk) => PARTY_BANNER_REGEX.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const text = stripBom(raw).trimStart();
    if (STARS_HEADER_PREFIX.test(text)) {
      return parseStarsDialect(raw, ctx);
    }
    if (PARTY_BANNER_REGEX.test(text)) {
      return parsePartyDialect(raw, ctx);
    }
    throw new ParseSkip(
      "normalized-unparseable",
      "The chunk matches neither PokerBros dialect we have real bytes for.",
    );
  },
};
