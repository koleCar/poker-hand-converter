/**
 * Run It Once Poker parser.
 *
 * RIO (Phil Galfond's room, 2019-2022, now closed) wrote a close PokerStars
 * clone, and the body of a hand is read by `shared/p3-stars-dialect.ts`. What is
 * genuinely RIO's own, and what this file owns, is:
 *
 * - the header, which is dual-timestamped (`2019/06/25 16:12 UTC [.. CET]`) and
 *   states minutes but not seconds, so the PokerStars date reader cannot read it;
 * - the tournament header, which names the tournament and prints no level at
 *   all, where PokerStars prints a level and no name;
 * - `*** SHOWDOWN ***` as one word - handled in the dispatcher, which accepts
 *   both spellings, but it is the single easiest thing to get wrong when
 *   bootstrapping from a PokerStars parser;
 * - Splash The Pot, which is refused. See `houseMoney` in the dispatcher.
 *
 * Fixtures: `fixtures/samples/run-it-once/`.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  DEFAULT_TEXT_STYLE,
  parseAmount,
  parseBuyInToken,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfTournament,
} from "../phf/types";
import {
  StarsHandDraft,
  buyInUnitFor,
  detectDecimals,
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

export const RUNITONCE_PARSER_VERSION = "1.0.0";

/** `Run It Once Poker Hand #30266126:  Hold'em No Limit (€0.05/€0.10) - ...` */
const HEADER_REGEX = /^Run It Once Poker Hand #(\d+):\s*(.*)$/;
const HEADER_PREFIX = /^Run It Once Poker Hand #\d+:/;
/** Hand files and tournament-summary files, which share the brand line. */
const ANY_HEADER = /^Run It Once Poker (?:Hand|Tournament) #\d+/m;

interface Header {
  handId: string;
  payload: string;
  game: DraftGame;
  tournament: PhfTournament | null;
  playedAt: string | null;
}

/**
 * The timestamp, which RIO prints twice: UTC first, then a bracketed local copy.
 *
 * The UTC one is taken because the room labels it as such - no other parser in
 * this project gets that luxury - and seconds are optional because hand headers
 * stop at minutes while the tournament summary file states seconds.
 */
function parsePlayedAtUtc(payload: string): string | null {
  const match = payload.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC/);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${s ?? "00"}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function blindsFrom(stakesText: string, unit: CurrencyUnit): { sb: Amount; bb: Amount } {
  const match = stakesText.match(/^\s*(\S+)\/(\S+)/);
  if (!match) {
    return { sb: 0, bb: parseAmount(stakesText.trim(), unit) };
  }
  return { sb: parseAmount(match[1], unit), bb: parseAmount(match[2], unit) };
}

/**
 * `Tournament #158168, €4.69+€0.31 Cub3d, Hold'em No Limit (10/20) - <date>`.
 *
 * Unlike PokerStars there is no `Level` clause, so `levelLabel`/`levelNumber`
 * stay null and the level blinds are the ones in the parens - which for a
 * tournament are chips and carry no currency symbol, while the buy-in beside
 * them is real money and does.
 */
function parseTournamentHeader(payload: string): { tournament: PhfTournament; game: DraftGame } | null {
  const match = payload.match(
    /^Tournament #([^,]+), (\S+(?:\+\S+)*)\s+(.*?), (.+?)\s*\(([^)]*)\)\s+-\s+.*$/,
  );
  if (!match) {
    return null;
  }
  const [, id, buyInToken, name, label, stakes] = match;
  const unit = unitForStakes(stakes, CHIPS);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(stakes, unit);
  const buyInUnit = buyInUnitFor(buyInToken, undefined);
  const parts = parseBuyInToken(buyInToken, buyInUnit);
  return {
    tournament: {
      id,
      name: name.trim() || null,
      buyIn: parts.buyIn,
      bounty: parts.bounty,
      fee: parts.fee,
      buyInUnit,
      levelLabel: null,
      levelNumber: null,
      levelSmallBlind: blinds.sb,
      levelBigBlind: blinds.bb,
      levelAnte: 0,
      bounties: [],
    },
    game: {
      variant: variantFromLabel(label),
      limit: limitFromLabel(label),
      format: "tournament",
      label: label.trim(),
      unit,
      smallBlind: blinds.sb,
      bigBlind: blinds.bb,
    },
  };
}

function parseHeader(line: string): Header | null {
  const match = line.match(HEADER_REGEX);
  if (!match) {
    return null;
  }
  const [, handId, payload] = match;
  const playedAt = parsePlayedAtUtc(payload);

  const tournament = parseTournamentHeader(payload);
  if (tournament) {
    return { handId, payload, game: tournament.game, tournament: tournament.tournament, playedAt };
  }

  // `Hold'em No Limit (€0.05/€0.10) - 2019/06/25 16:12 UTC [...]`
  const cash = payload.match(/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/);
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
    handId,
    payload,
    game: {
      variant: variantFromLabel(label),
      limit: limitFromLabel(label),
      format: "cash",
      label,
      unit,
      smallBlind: blinds.sb,
      bigBlind: blinds.bb,
    },
    tournament: null,
    playedAt,
  };
}

function parseOneHand(raw: string, ctx: SiteParserContext): PhfHand {
  const text = stripBom(raw).trim();
  const lines = toLines(text);
  if (hasUnsupportedCurrency(lines[0] ?? "")) {
    throw new ParseSkip(
      "unsupported-currency",
      `PHF has no unit for the currency in "${lines[0]}".`,
    );
  }
  const header = parseHeader(lines[0] ?? "");
  if (!header) {
    throw new ParseSkip(
      "normalized-unparseable",
      "The chunk has no readable Run It Once Poker header line.",
    );
  }
  if (header.game.variant !== "holdem") {
    throw new ParseSkip(
      "unsupported-variant",
      `${header.game.label} is not supported yet; the hand is kept for a future parser.`,
    );
  }
  if (ctx.options.cashOnly && header.tournament) {
    throw new ParseSkip(
      "tournament-in-cash-mode",
      "Tournament hand skipped because the converter is in cash-only mode.",
    );
  }

  const draft = new StarsHandDraft({
    siteId: "runitonce",
    siteName: "Run It Once Poker",
    parserId: "runitonce",
    parserVersion: RUNITONCE_PARSER_VERSION,
    handId: header.handId,
    // RIO ids are bare integers, so they are namespaced to keep them from
    // colliding with another room's numeric ids in `stored_hands.hand_key`.
    handKey: `RIO${header.handId}`,
    rawText: text,
    originalFilename: ctx.sourceFilename,
    game: header.game,
    tournament: header.tournament,
    playedAt: header.playedAt,
    textStyle: {
      ...DEFAULT_TEXT_STYLE,
      decimals: detectDecimals(text),
      // The header states minutes only, so there is no hour to pad either way.
      padHour: true,
    },
  });

  const body = parseStarsFamilyBody(lines, draft, header.game.unit);

  if (draft.playerCount() === 0) {
    throw new ParseSkip("no-seat-block", "The hand lists no seats, so nobody can be attributed.");
  }
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

export const runitonceParser: SiteParser = {
  id: "runitonce",
  name: "Run It Once Poker",
  version: RUNITONCE_PARSER_VERSION,

  detect(text: string): number {
    // Nobody else writes "Run It Once Poker", and the tournament-summary file
    // carries the same brand line - claiming it means the upload is attributed
    // to RIO and reported as "no hands" rather than as an unknown site.
    if (ANY_HEADER.test(stripBom(text))) {
      return 0.95;
    }
    if (/\bRun It Once Poker\b/.test(text)) {
      return 0.3;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    // Only `Hand #` chunks are hands. A tournament *summary* file is recognised
    // by `detect` but split to nothing, which surfaces as a `no-hands` failure
    // naming RIO instead of a silent drop.
    return normalizeNewlines(stripBom(text))
      .split(/(?=^Run It Once Poker Hand #\d+:)/m)
      .map((chunk) => stripBom(chunk).trim())
      .filter((chunk) => HEADER_PREFIX.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    return parseOneHand(raw, ctx);
  },
};
