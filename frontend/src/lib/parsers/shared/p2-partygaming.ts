/**
 * Text helpers shared by the two PartyGaming-lineage dialects, 888poker and
 * partypoker.
 *
 * The two formats descend from the same ancestor and still share their skeleton
 * - a `***** Hand History for Game N *****` banner, `Seat n: name ( $x )`,
 * `** Dealing ... **` street markers, bracketed amounts - which is exactly why
 * they are dangerous to each other: a partypoker hand fed to the 888 parser
 * looks almost parseable. Everything in here is therefore about telling them
 * apart as much as it is about reading them.
 */

import type { Amount, CurrencyUnit } from "../../phf/types";
import { EUR, GBP, USD, parseAmount } from "../../phf/types";

/** `***** 888poker Hand History for Game 349736402 *****` and its skins. */
export const BANNER_REGEX = /^\*{3,}\s*(.*?)\s*Hand History for Game\s+(\d+)\s*\*{3,}$/;

/**
 * The banner line and the stakes line right under it.
 *
 * Both rooms open some exports with a byte order mark, which sits *in front of*
 * the first banner. Testing the raw text with an anchored regex therefore misses
 * the banner of a single-hand file while finding it in a multi-hand one, so
 * every reader goes through here rather than matching the file directly.
 */
export function bannerAndStakes(text: string): { banner: string; stakes: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/^\uFEFF/, "").trim();
    if (BANNER_REGEX.test(line)) {
      return { banner: line, stakes: (lines[i + 1] ?? "").replace(/^\uFEFF/, "").trim() };
    }
  }
  return null;
}

/**
 * 888's stakes line: `$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28`.
 *
 * The `Blinds` word and the `*** DD MM YYYY` timestamp are what make it 888's
 * and not partypoker's, whose second line is
 * `$0.05/$0.10 USD NL Texas Hold'em - Monday, January 06, 08:54:23 EST 2014`.
 *
 * The stakes themselves are deliberately left as one loose group: European 888
 * clients write `25 $/50 $` with the symbol behind the number, and the whole
 * file then uses a comma decimal separator. Matching that here means such a
 * hand is *attributed* to 888 and refused with a reason, rather than dropped as
 * an unknown site.
 */
export const P888_STAKES_REGEX =
  /^([^/]*?)\/(.*?)\s+Blinds\s+(.+?)\s+-\s+\*{3}\s+(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/;

/** The half of an 888 stakes line in front of `Blinds`, English-locale form. */
export const P888_AMOUNT_REGEX = /^([$€£]?)([\d,]+(?:\.\d+)?)$/;

/**
 * partypoker's stakes line, split in two because the two halves vary
 * independently.
 *
 * The tail is the giveaway: partypoker writes a weekday-name date with a
 * timezone abbreviation, where 888 writes `*** DD MM YYYY HH:MM:SS`.
 */
export const PARTY_DATE_REGEX =
  /^(.+?)\s+-\s+(?:\w+day),\s+(\w+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Za-z]{2,5})\s+(\d{4})\s*$/;

/**
 * The half in front of the date, in both of its shapes:
 * `$0.05/$0.10 USD NL Texas Hold'em` states the blinds, while
 * `$100 USD PL Omaha` states the table's maximum buy-in and says nothing at all
 * about them - which is why the blinds always come from what was posted.
 */
export const PARTY_GAME_REGEX =
  /^([$€£]?)([\d,]+(?:\.\d+)?)(?:\/([$€£]?)([\d,]+(?:\.\d+)?))?\s+([A-Z]{3})\s+(NL|PL|FL|No Limit|Pot Limit|Fixed Limit|Limit)\s+(.+)$/;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Offsets, in minutes, for the zone abbreviations partypoker stamps its hands
 * with. The room writes server-local time plus an abbreviation, while PHF wants
 * a UTC instant, so the offset has to be applied rather than ignored: an hour's
 * error puts a hand in the wrong session.
 */
const ZONE_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  BST: 60,
  WET: 0,
  WEST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  MSK: 180,
  AST: -240,
  ADT: -180,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

/** Whether we know how to place a zone abbreviation on the UTC line. */
export function knownZone(abbreviation: string): boolean {
  return abbreviation.toUpperCase() in ZONE_OFFSETS;
}

/**
 * Builds a UTC ISO timestamp from a partypoker date line.
 *
 * Unknown zones are treated as UTC; the caller records a warning so the hand is
 * still usable but the guess is visible.
 */
export function isoFromPartyDate(
  monthName: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
  zone: string,
  year: string,
): string | null {
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) {
    return null;
  }
  const offset = ZONE_OFFSETS[zone.toUpperCase()] ?? 0;
  const local = Date.UTC(
    Number(year),
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(local)) {
    return null;
  }
  return new Date(local - offset * 60_000).toISOString();
}

/** `06 01 2014 22:40:28` (day month year) -> ISO. 888 stamps no zone. */
export function isoFrom888Date(
  day: string,
  month: string,
  year: string,
  hour: string,
  minute: string,
  second: string,
): string | null {
  const value = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(value) ? null : new Date(value).toISOString();
}

export function unitFor(symbol: string): CurrencyUnit {
  switch (symbol) {
    case "€":
      return EUR;
    case "£":
      return GBP;
    default:
      return USD;
  }
}

/** `[$1 + $2]`, `[$0.05 USD]`, `[ $0.19 ]` -> minor units, summed. */
export function bracketAmount(raw: string, unit: CurrencyUnit): Amount {
  const parts = raw.match(/[\d,]+(?:\.\d+)?/g) ?? [];
  return parts.reduce((sum, part) => sum + parseAmount(part, unit), 0);
}

/**
 * Splits a file into hands on the `*****` banner line.
 *
 * `#Game No : N` is a redundant restatement of the number on the banner right
 * below it, but the rooms print it and it is part of the hand's own text, so it
 * is kept with the hand it introduces rather than left at the end of the
 * previous one.
 */
export function splitBanneredHands(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!BANNER_REGEX.test(lines[i].replace(/^\uFEFF/, "").trim())) {
      continue;
    }
    const previous = lines[i - 1]?.replace(/^\uFEFF/, "").trim() ?? "";
    starts.push(/^#\s*Game No\s*:/.test(previous) ? i - 1 : i);
  }
  return starts
    .map((start, index) =>
      lines.slice(start, starts[index + 1] ?? lines.length).join("\n").replace(/^\uFEFF/, "").trim(),
    )
    .filter((chunk) => chunk.length > 0);
}

/**
 * Lines that carry no pot or card information.
 *
 * Kept as an explicit list rather than a catch-all so that a genuinely new line
 * shape still raises `unknown-line` instead of being swallowed.
 */
const NOISE_REGEX =
  /^(?:#\s*Game No\s*:|Game #\d+ starts\.|Total number of players\s*:|Your time bank will be activated)/;

const NOISE_SUFFIX_REGEX =
  /(?:\bhas joined the table\.?|\bhas left the table\.?|\bis sitting out\b|\bwill be using (?:his|her|their) time bank for this hand\.?|\bdid not respond in time\b|\bwas removed from the table for failing to post\b|\bfinished the tournament\b)$/;

/** True for a line we deliberately drop; see `NOISE_REGEX` for the reasoning. */
export function isNoiseLine(line: string): boolean {
  return NOISE_REGEX.test(line) || NOISE_SUFFIX_REGEX.test(line);
}

/**
 * Table chat, which partypoker interleaves with the action as
 * `Roycey1992: always play ur opponent`.
 *
 * A chat line is only recognisable by its speaker being a seated player, so the
 * seat list has to be known before this can be called - which is why chat is
 * filtered in a second pass rather than in the main loop.
 */
export function isChatLine(line: string, seatNames: Set<string>): boolean {
  const match = line.match(/^(.+?):\s/);
  return match !== null && seatNames.has(match[1]);
}
