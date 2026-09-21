/**
 * Entraction parser (the Swedish network behind Redbet, Nordicbet and the rest;
 * bought by IGT in 2011 and wound down).
 *
 * Column-formatted plain text, and unusually pleasant to read:
 *
 * ```
 * Game # 2646539198 - Texas Hold'em No Limit EUR 0.25/0.50 - Table "Burguillos"
 *
 * Players(max 6):
 * Pinokio1                    (EUR 50.25 in seat 3)
 *
 * Dealer:                     pauli1
 * Small Blind:                Pinokio1    (0.25)
 * Big Blind:                  pauli1      (0.50)
 *
 * Pinokio1                    Call        (0.25)
 *
 * Flop                        Ah - 6c - Jd
 *
 * Pinokio1 shows:             As - Qs
 * pauli1 wins:                EUR 27.25
 * Rake:                       EUR 0.75
 *
 * Game ended 2012-05-31 08:56:27 GMT+01:00
 * ```
 *
 * What is worth knowing:
 *
 * - **Every amount is an increment**, including `Raise`. `pauli1 Raise (7.75)`
 *   is 7.75 chips pushed, not a raise to 7.75; the street total is the sum. That
 *   is exactly the shape `shared/p2-handbuilder.ts` takes.
 * - **`Payback` is the uncalled bet**, printed as an action of its own and in a
 *   shape nothing else in this project uses. It is read for cross-checking only:
 *   the builder derives the return from the betting state, and emitting the line
 *   as well would return the money twice.
 * - **Boards are cumulative.** `River  4d - 2d - Js - 5s - As` is the whole
 *   board, not the river card, so only the new tail of each line is taken.
 * - **The only timestamp is `Game ended`**, which is when the hand finished
 *   rather than when it was dealt. It is off by the length of the hand - seconds
 *   to a minute or two - and it is all the room gives, so `playedAt` carries it.
 * - **Nothing identifies the hero.** Hole cards appear only for players who
 *   reached a showdown (or whose mucked hand was printed), so these files have
 *   no owner. A hand with no hero is a validator warning; inventing one is worse.
 * - **Names can contain spaces** (`zinzan 71`) and the columns are padded, so
 *   lines are matched against the seat list rather than by column width.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  unitForCode,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import {
  buildHand,
  type DraftAction,
  type DraftSeat,
  type DraftStreet,
  type HandDraft,
} from "./shared/p2-handbuilder";
import {
  leadingName,
  namesByLength,
  refuseLossyText,
  strictAmount,
} from "./shared/p4-textroom";

const VERSION = "1.0.0";

/**
 * `Game # <id> - <game> <limit> <CUR> <sb>/<bb> - Table "<name>"`.
 *
 * The space after `#` and the absence of a colon are what keep this apart from
 * Unibet's 2021 header, `Game #1463192545: Table €1 NL - ...`.
 */
const HEADER =
  /^Game\s#\s*(\d+)\s+-\s+(.+?)\s+(No Limit|Pot Limit|Fixed Limit)\s+([A-Z]{3})\s+([\d.,]+)\/([\d.,]+)\s+-\s+Table\s+"(.*)"\s*$/;

const MAX_SEATS = /^Players\(max\s+(\d+)\)\s*:\s*$/i;
const SEAT_LINE = /^(.*?)\s+\(([A-Z]{3})\s+([\d.,]+)\s+in seat\s+(\d+)\)\s*$/;
const DEALER_LINE = /^Dealer:\s+(.+?)\s*$/;
const BLIND_LINE = /^(Small|Big)\s+Blind:\s+(.+?)\s+\(([\d.,]+)\)\s*$/i;
const STREET_LINE = /^(Flop|Turn|River)\s+(\S.*?)\s*$/;
const RAKE_LINE = /^Rake:\s+[A-Z]{3}\s+([\d.,]+)\s*$/;
const ENDED_LINE = /^Game ended\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(?:GMT([+-]\d{2}):?(\d{2}))?\s*$/;

export const entractionParser: SiteParser = {
  id: "entraction",
  name: "Entraction",
  version: VERSION,

  detect(text: string): number {
    // The whole header shape, not just `Game #`: Unibet's 2021 export also opens
    // with those two tokens and must not be claimed here.
    if (HEADER.test(text) || /^Game\s#\s*\d+\s+-\s+.+\s+-\s+Table\s+"/m.test(text)) {
      return 0.95;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .split(/(?=^Game\s#\s*\d+\s+-\s)/m)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => HEADER.test(chunk.split(/\r?\n/)[0] ?? ""));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const source = raw.replace(/^﻿/, "").trim();
    refuseLossyText(source, "Entraction");
    const lines = source.split(/\r?\n/);
    const warnings: PhfWarning[] = [];

    const header = lines[0].match(HEADER);
    if (!header) {
      throw new ParseSkip("no-header", "The chunk does not open with an Entraction header line.");
    }
    const [, handId, gameWord, limitWord, currency, smallBlind, bigBlind, tableName] = header;
    if (!/^Texas\s+Hold'?em$/i.test(gameWord)) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${gameWord}".`,
      );
    }
    const unit = unitForCode(currency);

    // Seats are listed before any action, and names can contain spaces, so the
    // seat list is read first and every later line is matched against it.
    const seats: DraftSeat[] = [];
    let maxSeats = 0;
    for (const line of lines) {
      const size = line.trim().match(MAX_SEATS);
      if (size) {
        maxSeats = Number(size[1]);
        continue;
      }
      const seat = line.match(SEAT_LINE);
      if (seat) {
        seats.push({
          seat: Number(seat[4]),
          name: seat[1].trim(),
          startingStack: strictAmount(seat[3], unit, "a seat line"),
          dealtIn: true,
          isHero: false,
          dealtCards: [],
        });
      }
    }
    if (seats.length === 0) {
      throw new ParseSkip("no-players", "The chunk has no `(<CUR> <amount> in seat <n>)` lines.");
    }
    const names = namesByLength(seats.map((seat) => seat.name));

    const actions: DraftAction[] = [];
    const collected: HandDraft["collected"] = [];
    let street: DraftStreet = "preflop";
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let buttonSeat: number | null = null;
    let playedAt: string | null = null;
    let statedRake: Amount | null = null;
    let statedPayback: { player: string; amount: Amount } | null = null;

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trimEnd();
      const lineNo = i + 1;
      if (!line.trim() || MAX_SEATS.test(line.trim()) || SEAT_LINE.test(line)) {
        continue;
      }

      const dealer = line.match(DEALER_LINE);
      if (dealer) {
        buttonSeat = seats.find((seat) => seat.name === dealer[1].trim())?.seat ?? null;
        if (buttonSeat === null) {
          warnings.push({
            code: "unknown-line",
            message: `Dealer "${dealer[1].trim()}" is not a seated player.`,
            line: lineNo,
          });
        }
        continue;
      }

      const blind = line.match(BLIND_LINE);
      if (blind && names.includes(blind[2].trim())) {
        // Heads-up hands print the big blind first; the order is kept as the
        // room wrote it, because the ring is anchored on who posted, not on
        // which line came first.
        actions.push({
          street: "preflop",
          player: blind[2].trim(),
          kind: /^small$/i.test(blind[1]) ? "small-blind" : "big-blind",
          amount: strictAmount(blind[3], unit, "a blind line"),
        });
        continue;
      }

      const marker = line.match(STREET_LINE);
      if (marker) {
        // The line repeats the whole board so far; only the tail is new.
        const cards = extractCards(marker[2].replace(/\s+-\s+/g, " "));
        if (/^flop$/i.test(marker[1])) {
          street = "flop";
          flop = cards.slice(0, 3);
        } else if (/^turn$/i.test(marker[1])) {
          street = "turn";
          turn = cards[3] ?? null;
        } else {
          street = "river";
          river = cards[4] ?? null;
        }
        continue;
      }

      const rake = line.match(RAKE_LINE);
      if (rake) {
        statedRake = strictAmount(rake[1], unit, "the rake line");
        continue;
      }
      const ended = line.match(ENDED_LINE);
      if (ended) {
        playedAt = isoFromEntractionDate(ended);
        continue;
      }

      const hit = leadingName(line.trim(), names);
      if (hit) {
        const payback = hit.rest.match(/^Payback\s+\(([\d.,]+)\)$/i);
        if (payback) {
          // Read for the cross-check only: `p2-handbuilder` derives the return
          // from the betting state and emitting it here would pay it twice.
          statedPayback = {
            player: hit.name,
            amount: strictAmount(payback[1], unit, "a Payback line"),
          };
          continue;
        }
        if (readAction(hit.rest, hit.name, unit, street, actions, collected)) {
          continue;
        }
      }

      warnings.push({ code: "unknown-line", message: line.trim(), line: lineNo });
    }

    if (collected.length === 0) {
      throw new ParseSkip(
        "no-winner",
        "No `<name> wins:` line, so the source never says who was given the pot.",
      );
    }
    if (flop && flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The flop line lists ${flop.length} readable cards, so the hand is corrupt.`,
      );
    }

    const draft: HandDraft = {
      siteId: "entraction",
      siteName: "Entraction",
      parserId: "entraction",
      parserVersion: VERSION,
      handPrefix: "ENT-",
      handId,
      gameLabel: canonicalLabel(limitWord),
      unit,
      decimals: "fixed2",
      headerSmallBlind: strictAmount(smallBlind, unit, "the header stakes"),
      headerBigBlind: strictAmount(bigBlind, unit, "the header stakes"),
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
      // `Payback` takes the uncalled bet out before `wins:` is printed.
      collectedIncludesUncalled: false,
      rawText: source,
      warnings,
    };

    const hand = buildHand(draft, ctx);
    crossCheck(hand, statedRake, statedPayback);
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
  collected: HandDraft["collected"],
): boolean {
  const wagered = rest.match(/^(Call|Bet|Raise|All-In)\s+\(([\d.,]+)\)$/i);
  if (wagered) {
    const verb = wagered[1].toLowerCase();
    actions.push({
      street,
      player,
      // `All-In` covers a call, a bet and a raise alike; which one it was only
      // follows from the betting state, which the builder has.
      kind: verb === "all-in" ? "allin" : (verb as "call" | "bet" | "raise"),
      amount: strictAmount(wagered[2], unit, "an action line"),
      allIn: verb === "all-in",
    });
    return true;
  }
  if (/^Fold$/i.test(rest)) {
    actions.push({ street, player, kind: "fold" });
    return true;
  }
  if (/^Check$/i.test(rest)) {
    actions.push({ street, player, kind: "check" });
    return true;
  }
  const shows = rest.match(/^shows:\s+(.+)$/i);
  if (shows) {
    actions.push({
      street,
      player,
      kind: "show",
      cards: extractCards(shows[1].replace(/\s+-\s+/g, " ")),
    });
    return true;
  }
  // `didn't show hand (Jd - Qh - 6s - Ac)`: a muck whose cards the room printed
  // anyway, which is how a losing all-in hand is reported.
  const mucked = rest.match(/^didn't show hand(?:\s+\((.+)\))?$/i);
  if (mucked) {
    actions.push({
      street,
      player,
      kind: "muck",
      cards: extractCards((mucked[1] ?? "").replace(/\s+-\s+/g, " ")),
    });
    return true;
  }
  const wins = rest.match(/^wins:\s+[A-Z]{3}\s+([\d.,]+)$/i);
  if (wins) {
    collected.push({
      player,
      amount: strictAmount(wins[1], unit, "a wins line"),
      potName: "pot",
    });
    return true;
  }
  return false;
}

/**
 * Checks the reconstruction against the two figures Entraction states itself.
 *
 * `Rake:` and `Payback` are computed by the room from its own ledger, so they
 * catch a parse that balances and is still wrong.
 */
function crossCheck(
  hand: PhfHand,
  statedRake: Amount | null,
  statedPayback: { player: string; amount: Amount } | null,
): void {
  const warn = (code: string, message: string) => hand.meta.warnings.push({ code, message });
  if (statedRake !== null && Math.abs(statedRake - hand.results.fees.rake) > 1) {
    warn(
      "rake-mismatch",
      `The hand states a rake of ${statedRake} but the reconstruction derives ` +
        `${hand.results.fees.rake}.`,
    );
  }
  const derived = hand.actions.find((action) => action.type === "uncalled");
  if (statedPayback && !derived) {
    warn(
      "payback-mismatch",
      `The hand pays ${statedPayback.amount} back to ${statedPayback.player} but the ` +
        "betting stream leaves nothing uncalled.",
    );
  } else if (statedPayback && derived) {
    if (
      derived.player !== statedPayback.player ||
      Math.abs(-derived.amount - statedPayback.amount) > 1
    ) {
      warn(
        "payback-mismatch",
        `The hand pays ${statedPayback.amount} back to ${statedPayback.player}; the ` +
          `stream returns ${-derived.amount} to ${derived.player}.`,
      );
    }
  } else if (!statedPayback && derived) {
    warn(
      "payback-mismatch",
      `The stream returns ${-derived.amount} to ${derived.player} but the hand prints ` +
        "no `Payback` line.",
    );
  }
}

/** `Game ended 2012-05-31 23:30:38 GMT+01:00` -> a UTC instant. */
function isoFromEntractionDate(match: RegExpMatchArray): string | null {
  const [, y, mo, d, h, mi, s, offsetHours, offsetMinutes] = match;
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(local)) {
    return null;
  }
  // The offset is stated, so it is applied rather than guessed. A missing one is
  // read as UTC, which is the only defensible default.
  const sign = offsetHours?.startsWith("-") ? -1 : 1;
  const offset = offsetHours
    ? sign * (Math.abs(Number(offsetHours)) * 60 + Number(offsetMinutes ?? 0))
    : 0;
  return new Date(local - offset * 60_000).toISOString();
}

/** Entraction writes `No Limit`; trackers expect the GG wording. */
function canonicalLabel(limit: string): string {
  if (/^Pot Limit$/i.test(limit)) {
    return "Hold'em Pot Limit";
  }
  return /^Fixed Limit$/i.test(limit) ? "Hold'em Limit" : "Hold'em No Limit";
}

/** `Players(max N)` is authoritative when present; this is the fallback. */
function fallbackMaxSeats(seats: DraftSeat[]): number {
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [2, 6, 9, 10].find((size) => size >= highest) ?? highest;
}
