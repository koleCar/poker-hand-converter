/**
 * Ongame Network parser (bwin, Betsson, PokerRoom and the rest of the skins).
 *
 * Ongame is dead as a network - bwin absorbed the last of it - but its exports
 * are a small, closed, well-behaved grammar, so the corpus is cheap to cover:
 *
 * ```
 * ***** History for hand R5-361850810-474 *****
 * Start hand: Mon Jan 06 01:06:00 CET 2014
 * Table: Bonn [361850810] (NO_LIMIT TEXAS_HOLDEM $0.50/$1, Real money)
 * Button: seat 2
 * Players in round: 6
 * Seat 1: BlackH0L3 ($103.75)
 * BONUS 1OOO posts small blind ($0.50)
 * ---
 * Dealing pocket cards
 * BONUS 1OOO raises $1.50 to $2.00
 * --- Dealing flop [Ad, 8c, 3s]
 * ---
 * Summary:
 * Main pot: $4.00 won by BONUS 1OOO ($3.80)
 * Rake taken: $0.20
 * Seat 7: BONUS 1OOO ($133.31), net: +$1.80
 * ***** End of hand R5-361850810-474 *****
 * ```
 *
 * What is worth knowing:
 *
 * - **`raises $1.50 to $2.00` is increment-then-total.** The first number is the
 *   chips the player pushed, the second the street total they arrive at -
 *   `kliketiklok raises $10.00 to $10.50` is a player who had already posted a
 *   $0.50 small blind. Only the total is read; the printed increment is not the
 *   amount over the current bet and is not what the standard text wants.
 * - **`Main pot: $X won by <name> ($Y)`** states the pot *before* the rake and
 *   the winner's share *after* it, so the rake falls out of the difference and
 *   is cross-checked against `Rake taken:` below.
 * - **The pot is already net of the uncalled bet**, which the room never prints.
 *   `shared/p2-handbuilder.ts` derives the return, which is why the reported
 *   winnings are flagged as *not* containing it.
 * - **Nothing identifies the hero.** These are data-mined files: there is no
 *   `Dealt to` line and hole cards only ever appear in the summary, for players
 *   who reached a showdown. A hand with no hero is a validator warning, not an
 *   error, and inventing one would be worse.
 * - **Names are unconstrained**: `---Cockatrice---`, `BONUS 1OOO`, `Tiresias.`.
 *   A name can therefore look exactly like a street separator, so lines are
 *   matched against the seat list rather than by shape.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  parseAmount,
  unitForSymbol,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import { isoFromPartyDate, knownZone } from "./shared/p2-partygaming";
import {
  buildHand,
  type DraftAction,
  type DraftSeat,
  type DraftStreet,
  type HandDraft,
} from "./shared/p2-handbuilder";
import {
  currencySymbolOf,
  expandMonth,
  leadingName,
  namesByLength,
} from "./shared/p4-textroom";

const VERSION = "1.0.0";

const OPEN_BANNER = /^\*{5}\s*History for hand\s+(\S+)\s*\*{5}\s*$/;
const CLOSE_BANNER = /^\*{5}\s*End of hand\s+\S+\s*\*{5}\s*$/;
const START_LINE =
  /^Start hand:\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\S+)\s+(\d{4})\s*$/;
const TABLE_LINE = /^Table:\s+(.*?)\s*\[(\d+)\]\s*\((\S+)\s+(\S+)\s+(\S+?)\/(\S+?),\s*(.*?)\)\s*$/;
const BUTTON_LINE = /^Button:\s*seat\s+(\d+)\s*$/i;
const COUNT_LINE = /^Players in round:\s*(\d+)\s*$/i;
const SEAT_LINE = /^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)\s*$/;
const STREET_LINE = /^---\s*Dealing\s+(flop|turn|river)\s*\[([^\]]*)\]\s*$/i;
const POT_LINE = /^(Main|Side)\s+pot(?:\s+\d+)?:\s+(\S+)\s+won by\s+(.+)\s+\((\S+)\)\s*$/i;
const RAKE_LINE = /^Rake taken:\s+(\S+)\s*$/i;
const SUMMARY_SEAT_LINE =
  /^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)(?:,\s*net:\s*(\S+?))?(?:,\s*\[([^\]]*)\])?\s*$/;

export const ongameParser: SiteParser = {
  id: "ongame",
  name: "Ongame Network",
  version: VERSION,

  detect(text: string): number {
    // `***** History for hand <id> *****` is written by nothing else in scope.
    if (/^\*{5}\s*History for hand\s+\S+\s*\*{5}\s*$/m.test(text)) {
      return 0.95;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .split(/(?=^\*{5}\s*History for hand\s)/m)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => OPEN_BANNER.test(chunk.split(/\r?\n/)[0] ?? ""));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const source = raw.replace(/^﻿/, "").trim();
    const lines = source.split(/\r?\n/);
    const warnings: PhfWarning[] = [];

    const handId = lines[0]?.match(OPEN_BANNER)?.[1];
    if (!handId) {
      throw new ParseSkip("no-header", "The chunk does not open with an Ongame hand banner.");
    }

    const table = lines.find((line) => TABLE_LINE.test(line.trim()))?.trim().match(TABLE_LINE);
    if (!table) {
      throw new ParseSkip("no-header", "The chunk has no readable `Table:` line.");
    }
    const [, tableName, , limitToken, gameToken, smallBlind, bigBlind, money] = table;
    if (!/^TEXAS_HOLDEM$/i.test(gameToken)) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${gameToken}".`,
      );
    }
    if (!/real\s*money/i.test(money)) {
      throw new ParseSkip("play-money", `The table is "${money}", not a real-money table.`);
    }
    const unit = unitForSymbol(currencySymbolOf(smallBlind) || currencySymbolOf(bigBlind));

    // Seats come before any action, and a player's name can look like anything
    // the room allows, so the seat list is read first and every later line is
    // matched against it.
    const seats: DraftSeat[] = [];
    for (const line of lines) {
      if (/^Summary:\s*$/i.test(line.trim())) {
        break;
      }
      const seat = line.trim().match(SEAT_LINE);
      if (seat) {
        seats.push({
          seat: Number(seat[1]),
          name: seat[2].trim(),
          startingStack: parseAmount(seat[3], unit),
          dealtIn: true,
          isHero: false,
          dealtCards: [],
        });
      }
    }
    if (seats.length === 0) {
      throw new ParseSkip("no-players", "The chunk has no seat lines.");
    }
    const names = namesByLength(seats.map((seat) => seat.name));

    const actions: DraftAction[] = [];
    const collected: HandDraft["collected"] = [];
    const reportedNet = new Map<string, Amount>();
    let street: DraftStreet = "preflop";
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let buttonSeat: number | null = null;
    let maxSeats = 0;
    let playedAt: string | null = null;
    let statedRake: Amount | null = null;
    let statedPot = 0;
    let inSummary = false;
    // Showdown reveals only ever appear in the summary, so the street they are
    // tagged with is the last one that was dealt.
    let lastStreet: DraftStreet = "preflop";

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const lineNo = i + 1;
      if (!line || line === "---" || line === "Dealing pocket cards" || CLOSE_BANNER.test(line)) {
        continue;
      }

      if (/^Summary:\s*$/i.test(line)) {
        inSummary = true;
        continue;
      }

      if (!inSummary) {
        const start = line.match(START_LINE);
        if (start) {
          if (!knownZone(start[6])) {
            warnings.push({
              code: "unknown-timezone",
              message: `Timezone "${start[6]}" is not in the offset table; the hand is timed as UTC.`,
              line: lineNo,
            });
          }
          playedAt = isoFromPartyDate(
            expandMonth(start[1]),
            start[2],
            start[3],
            start[4],
            start[5],
            start[6],
            start[7],
          );
          continue;
        }
        if (TABLE_LINE.test(line)) {
          continue;
        }
        const button = line.match(BUTTON_LINE);
        if (button) {
          buttonSeat = Number(button[1]);
          continue;
        }
        const count = line.match(COUNT_LINE);
        if (count) {
          maxSeats = Number(count[1]);
          continue;
        }
        if (SEAT_LINE.test(line)) {
          continue; // read in the seat pass
        }
        const marker = line.match(STREET_LINE);
        if (marker) {
          const cards = extractCards(marker[2]);
          street = marker[1].toLowerCase() as DraftStreet;
          lastStreet = street;
          if (street === "flop") {
            flop = cards;
          } else if (street === "turn") {
            turn = cards[0] ?? null;
          } else {
            river = cards[0] ?? null;
          }
          continue;
        }

        const hit = leadingName(line, names);
        if (hit && readAction(hit.rest, hit.name, unit, street, actions)) {
          continue;
        }
        warnings.push({ code: "unknown-line", message: line, line: lineNo });
        continue;
      }

      const pot = line.match(POT_LINE);
      if (pot) {
        statedPot += parseAmount(pot[2], unit);
        collected.push({
          player: pot[3].trim(),
          amount: parseAmount(pot[4], unit),
          potName: `${pot[1].toLowerCase()} pot`,
        });
        continue;
      }
      const rake = line.match(RAKE_LINE);
      if (rake) {
        statedRake = parseAmount(rake[1], unit);
        continue;
      }
      const seat = line.match(SUMMARY_SEAT_LINE);
      if (seat && names.includes(seat[2].trim())) {
        const name = seat[2].trim();
        if (seat[4] !== undefined) {
          reportedNet.set(name, parseAmount(seat[4], unit));
        }
        if (seat[5]) {
          // The only place hole cards ever appear. A player who is shown here
          // reached a showdown, so it is a reveal and not a deal.
          actions.push({
            street: lastStreet,
            player: name,
            kind: "show",
            cards: extractCards(seat[5]),
          });
        }
        continue;
      }
      warnings.push({ code: "unknown-line", message: line, line: lineNo });
    }

    if (collected.length === 0) {
      throw new ParseSkip(
        "no-winner",
        "No `Main pot: ... won by` line, so the source never says who was given the pot.",
      );
    }
    if (flop && flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The flop line lists ${flop.length} readable cards, so the hand is corrupt.`,
      );
    }

    // Seats that were dealt in but never acted still belong in the ring: Ongame
    // lists only the players in the round, so every seat printed was dealt.
    const draft: HandDraft = {
      siteId: "ongame",
      siteName: "Ongame Network",
      parserId: "ongame",
      parserVersion: VERSION,
      handPrefix: "OG-",
      handId,
      gameLabel: canonicalLabel(limitToken),
      unit,
      decimals: "fixed2",
      headerSmallBlind: parseAmount(smallBlind, unit),
      headerBigBlind: parseAmount(bigBlind, unit),
      tableName: tableName || null,
      maxSeats: Math.max(maxSeats, fallbackMaxSeats(seats)),
      buttonSeat,
      playedAt,
      seats,
      actions,
      flop,
      turn,
      river,
      collected,
      // `Main pot:` is already net of the uncalled bet, which Ongame never
      // prints; the builder derives the return and takes it off the top.
      collectedIncludesUncalled: false,
      rawText: source,
      warnings,
    };

    const hand = buildHand(draft, ctx);
    crossCheck(hand, statedPot, statedRake, reportedNet);
    return hand;
  },
};

/** Reads the part of an action line that follows the player's name. */
function readAction(
  rest: string,
  player: string,
  unit: CurrencyUnit,
  street: DraftStreet,
  actions: DraftAction[],
): boolean {
  // `[all in]` is decoration on an ordinary action and carries a trailing space.
  let body = rest;
  let allIn = false;
  const shove = body.match(/\s*\[all in\]\s*$/i);
  if (shove) {
    allIn = true;
    body = body.slice(0, shove.index).trim();
  }

  const posted = body.match(/^posts\s+(small|big)\s+blind\s+\((\S+)\)$/i);
  if (posted) {
    actions.push({
      street,
      player,
      kind: posted[1].toLowerCase() === "small" ? "small-blind" : "big-blind",
      amount: parseAmount(posted[2], unit),
      allIn,
    });
    return true;
  }
  const ante = body.match(/^posts\s+ante\s+\((\S+)\)$/i);
  if (ante) {
    actions.push({ street, player, kind: "ante", amount: parseAmount(ante[1], unit), allIn });
    return true;
  }
  if (/^folds$/i.test(body)) {
    actions.push({ street, player, kind: "fold" });
    return true;
  }
  if (/^checks$/i.test(body)) {
    actions.push({ street, player, kind: "check" });
    return true;
  }
  const called = body.match(/^calls\s+(\S+)$/i);
  if (called) {
    actions.push({ street, player, kind: "call", amount: parseAmount(called[1], unit), allIn });
    return true;
  }
  const bet = body.match(/^bets\s+(\S+)$/i);
  if (bet) {
    actions.push({ street, player, kind: "bet", amount: parseAmount(bet[1], unit), allIn });
    return true;
  }
  const raised = body.match(/^raises\s+\S+\s+to\s+(\S+)$/i);
  if (raised) {
    // The printed increment is chips pushed, not the amount over the current
    // bet, so only the total is read and the increment is recomputed.
    actions.push({
      street,
      player,
      kind: "raise",
      amount: parseAmount(raised[1], unit),
      toTotal: true,
      allIn,
    });
    return true;
  }
  const shows = body.match(/^(?:shows|mucks|doesn't show)\s*(?:\[([^\]]*)\])?$/i);
  if (shows) {
    actions.push({
      street,
      player,
      kind: /^shows/i.test(body) ? "show" : "muck",
      cards: extractCards(shows[1] ?? ""),
    });
    return true;
  }
  return false;
}

/**
 * Checks the reconstruction against the two figures Ongame states independently.
 *
 * `Rake taken:` and the per-seat `net:` column are computed by the room from its
 * own ledger, so they catch a parse that balances and is still wrong.
 */
function crossCheck(
  hand: PhfHand,
  statedPot: Amount,
  statedRake: Amount | null,
  reportedNet: Map<string, Amount>,
): void {
  const warn = (code: string, message: string) => hand.meta.warnings.push({ code, message });
  if (statedPot > 0 && Math.abs(statedPot - hand.results.totalPot) > 1) {
    warn(
      "pot-mismatch",
      `The summary states a pot of ${statedPot} but the stream accounts for ` +
        `${hand.results.totalPot}.`,
    );
  }
  if (statedRake !== null && Math.abs(statedRake - hand.results.fees.rake) > 1) {
    warn(
      "rake-mismatch",
      `The summary states a rake of ${statedRake} but the reconstruction derives ` +
        `${hand.results.fees.rake}.`,
    );
  }
  for (const result of hand.results.players) {
    const stated = reportedNet.get(result.player);
    if (stated !== undefined && Math.abs(stated - result.net) > 1) {
      warn(
        "net-result-mismatch",
        `${result.player}: the summary states a net of ${stated}, the reconstruction ` +
          `${result.net}.`,
      );
    }
  }
}

/** Ongame writes `NO_LIMIT`; trackers expect the GG wording. */
function canonicalLabel(limit: string): string {
  if (/^POT_LIMIT$/i.test(limit)) {
    return "Hold'em Pot Limit";
  }
  return /^LIMIT$/i.test(limit) ? "Hold'em Limit" : "Hold'em No Limit";
}

/**
 * Seat count, which Ongame never states.
 *
 * `Players in round` is how many were dealt in, not how big the table is, and
 * the seat numbers are physical positions on the felt, so the next real table
 * size above the highest one is the closest honest answer.
 */
function fallbackMaxSeats(seats: DraftSeat[]): number {
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [2, 6, 9, 10].find((size) => size >= highest) ?? highest;
}
