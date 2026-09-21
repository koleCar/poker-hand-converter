/**
 * Winamax parser (winamax.fr / .es / .de).
 *
 * Winamax exports its own grammar - not a PokerStars clone - and it is small
 * enough to state in full:
 *
 * ```
 * Winamax Poker - CashGame - HandId: #5335178-3970-1383796438 - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC
 * Table: 'Milwaukee 02' 5-max (real money) Seat #5 is the button
 * Seat 1: totti6720 (99.36€)
 * *** ANTE/BLINDS ***
 * totti6720 posts small blind 0.25€
 * Dealt to WM_Hero [4c 5s]
 * *** PRE-FLOP ***
 * sined20 raises 1€ to 1.50€
 * *** FLOP *** [4d Kc 9c]
 * sined20 collected 6.01€ from pot
 * *** SUMMARY ***
 * Total pot 6.01€ | Rake 0.24€
 * Board: [4d Kc 9c]
 * Seat 4: sined20 won 6.01€
 * ```
 *
 * The things that bite, every one of them confirmed against the 27-file corpus
 * in `fixtures/samples/winamax/`:
 *
 * - **There is no `Uncalled bet ... returned to` line, ever.** Winamax leaves an
 *   unmatched bet in the pot and hands it back inside `collected`: the hand
 *   above reports a pot of 6.01€ against a *contested* pot of 3.51€, because
 *   sined20's unmatched 2.50€ flop bet is inside both numbers. `Total pot` is
 *   therefore every chip that went in, minus the rake - which is also what the
 *   reference C# parser's own source comment says.
 * - **`No rake` is a literal string**, not `Rake 0€`.
 * - **`Board:` has a colon**, unlike every other room in this project.
 * - **Player names contain spaces and digits** (`fanf4K UR0`, `7 7 7`,
 *   `Kool Shen`, `Incognito 1`, `9574561`), so an action line cannot be split on
 *   the first space. Names are resolved against the seat list, longest first.
 * - **Seat numbers are sparse** and the `N-max` in the table line is the table's
 *   capacity, not the number of players seated.
 * - **All-in is a suffix** (` and is all-in`) on an ordinary money verb.
 * - **`*** PRE-FLOP *** ` carries a trailing space** on every hand in the corpus.
 * - **The money format is the whole risk.** Every amount here is
 *   `<digits>[.<1-2 digits>]€` with no thousands separator, which is exactly
 *   representable. A French-market client writing `0,25 €` or `1 234,50 €` is
 *   not, and a permissive regex would read `1 234,50` as 123450 cents - a hand
 *   that balances perfectly against itself while being wrong by two orders of
 *   magnitude, in a file where nothing else looks unusual. Any amount outside
 *   the proven shape refuses the hand as `unsupported-locale`, and a file
 *   decoded with the wrong codec (the Windows-1252 euro sign, byte `0x80`, read
 *   as UTF-8) refuses as `unsupported-encoding`.
 *
 * **Tournaments are refused outright.** The research corpus contains no Winamax
 * tournament hand at all, and the tournament header in
 * `docs/research/hh-formats/winamax.md` is a paraphrase of a forum post with no
 * fixture behind it. A parser written against that would be a parser written
 * against a guess.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  parseAmount,
  unitForSymbol,
  type Amount,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import {
  buildP6Hand,
  type P6Action,
  type P6Collect,
  type P6Draft,
  type P6Seat,
  type P6Street,
} from "./shared/p6-handbuilder";

const VERSION = "1.0.0";

const HEADER =
  /^Winamax Poker - (CashGame|Tournament)\b.*?HandId: #(\S+) - (.+?) \((.+?)\) - (\d{4})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\s+\S+)?\s*$/;
const TABLE = /^Table: '(.*)' (\d+)-max \((real|play) money\)(?: Seat #(\d+) is the button)?\s*$/;
const SEAT = /^Seat (\d+): (.+) \(([^()]*)\)\s*$/;

/** Digits, then whatever the room appends as a currency glyph. */
const AMOUNT_AND_SYMBOL = /^([\d.,\u00a0\u202f ]+)(.*)$/;

/** The one amount shape this corpus ever uses. Anything else is refused. */
const SAFE_AMOUNT = /^\d+(?:\.\d{1,2})?$/;

/** Currency glyphs we can name with confidence. */
const KNOWN_SYMBOLS = new Set(["€", "$", "£"]);

export const winamaxParser: SiteParser = {
  id: "winamax",
  name: "Winamax",
  version: VERSION,

  detect(text: string): number {
    // `Winamax Poker - ` is the literal every export opens with, and no other
    // site in this project emits the token "Winamax" at all.
    if (/^﻿?Winamax Poker - (?:CashGame|Tournament)\b/m.test(text)) {
      return 0.95;
    }
    if (/^﻿?Winamax Poker - /m.test(text)) {
      return 0.9;
    }
    // Secondary anchor for a header-stripped paste: `*** ANTE/BLINDS ***` is
    // unique to Winamax among every format surveyed for this project.
    if (/^\*\*\* ANTE\/BLINDS \*\*\*/m.test(text)) {
      return 0.5;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    // Multi-hand files pad with five blank lines, but the repeated header is the
    // only thing worth anchoring on; the padding falls out in the trim.
    return text
      .split(/(?=^﻿?Winamax Poker - )/m)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => chunk.startsWith("Winamax Poker - "));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const text = raw.replace(/^﻿/, "").trim();
    const lines = text.split(/\r?\n/);

    // A file decoded with the wrong codec keeps its digits but loses its
    // currency glyph, so every amount still parses, the hand still balances
    // against itself, and the currency is a guess. Refuse rather than guess.
    if (text.includes("�")) {
      throw new ParseSkip(
        "unsupported-encoding",
        "The text contains U+FFFD replacement characters, so it was decoded with the " +
          "wrong codec and the currency cannot be identified. Two files in the Winamax " +
          "corpus encode the euro sign as Windows-1252. Re-save the export as UTF-8.",
      );
    }

    const headerMatch = lines[0]?.match(HEADER);
    if (!headerMatch) {
      throw new ParseSkip("no-header", `Unreadable Winamax header: "${lines[0] ?? ""}".`);
    }
    if (headerMatch[1] === "Tournament") {
      throw new ParseSkip(
        "unsupported-tournament",
        "Winamax tournament hands are not supported: no verified sample of the " +
          "tournament grammar exists, so a parser for it would be written against a guess.",
      );
    }

    const gameLabel = headerMatch[3].trim();
    if (!/^hold\s*'?em\b/i.test(gameLabel)) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${gameLabel}".`,
      );
    }

    /* ------------------------------------------------------------- money --- */

    const stakeParts = headerMatch[4].trim().split("/");
    const stakeTokens = stakeParts.map((part) => part.trim().match(AMOUNT_AND_SYMBOL));
    if (stakeParts.length !== 2 || !stakeTokens[0] || !stakeTokens[1]) {
      throw new ParseSkip("no-header", `Unreadable stakes clause "${headerMatch[4]}".`);
    }
    const symbol = (stakeTokens[1][2] || stakeTokens[0][2]).trim();
    if (!KNOWN_SYMBOLS.has(symbol)) {
      throw new ParseSkip(
        "unsupported-currency",
        `The stakes are quoted in "${symbol}", which is not a currency this parser can ` +
          "name; filing it under the wrong code would corrupt every win-rate it feeds.",
      );
    }
    assertRepresentableAmounts(text, symbol);
    const unit = unitForSymbol(symbol);

    /** A bare digit string, validated against the one shape we can represent. */
    const readDigits = (token: string, line: number): Amount => {
      if (!SAFE_AMOUNT.test(token)) {
        throw new ParseSkip(
          "unsupported-locale",
          `"${token}" on line ${line} is not a plain decimal amount, and guessing at its ` +
            "magnitude would be wrong by a factor of 100.",
        );
      }
      return parseAmount(token, unit);
    };
    /** `99.36€` -> 9936. */
    const readAmount = (token: string, line: number): Amount => {
      if (!token.endsWith(symbol)) {
        throw new ParseSkip(
          "unsupported-locale",
          `"${token}" on line ${line} is not an amount in ${symbol}.`,
        );
      }
      return readDigits(token.slice(0, -symbol.length).trim(), line);
    };

    const smallBlind = readDigits(stakeTokens[0][1].trim(), 1);
    const bigBlind = readDigits(stakeTokens[1][1].trim(), 1);

    const tableMatch = lines[1]?.match(TABLE);
    if (!tableMatch) {
      throw new ParseSkip("no-header", `Unreadable Winamax table line: "${lines[1] ?? ""}".`);
    }

    /* ------------------------------------------------------------- stream -- */

    const warnings: PhfWarning[] = [];
    const seats: P6Seat[] = [];
    const actions: P6Action[] = [];
    const collected: P6Collect[] = [];
    let street: P6Street = "preflop";
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let inSummary = false;
    let reportedPot: Amount | null = null;
    let reportedRake: Amount | null = null;
    let summaryBoard: string[] | null = null;

    /**
     * Player names carry spaces, so an action line is matched against the seat
     * list rather than split on whitespace. Longest first, because `Incognito 1`
     * would otherwise swallow the opening of `Incognito 10`'s lines.
     */
    const names: string[] = [];
    const nameOf = (line: string): string | null =>
      names.find((name) => line.startsWith(`${name} `)) ?? null;

    for (let i = 2; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const lineNo = i + 1;
      if (!line) {
        continue;
      }

      if (/^\*\*\* ANTE\/BLINDS \*\*\*/.test(line) || /^\*\*\* PRE-FLOP \*\*\*/.test(line)) {
        street = "preflop";
        continue;
      }
      if (/^\*\*\* SHOW\s?DOWN \*\*\*/.test(line)) {
        continue;
      }
      if (/^\*\*\* SUMMARY \*\*\*/.test(line)) {
        inSummary = true;
        continue;
      }

      const board = line.match(/^\*\*\* (FLOP|TURN|RIVER) \*\*\*\s*(.*)$/);
      if (board) {
        // Turn and river repeat the known board in the first bracket and add the
        // new card in a second one, so the last bracket is the new cards.
        const groups = [...board[2].matchAll(/\[([^\]]*)\]/g)].map((match) => cardsIn(match[1]));
        const last = groups[groups.length - 1] ?? [];
        if (board[1] === "FLOP") {
          flop = last;
          street = "flop";
        } else if (board[1] === "TURN") {
          turn = last[0] ?? null;
          street = "turn";
        } else {
          river = last[0] ?? null;
          street = "river";
        }
        continue;
      }

      if (inSummary) {
        const pot = line.match(/^Total pot (\S+) \| (?:Rake (\S+)|No rake)\s*$/);
        if (pot) {
          reportedPot = readAmount(pot[1], lineNo);
          reportedRake = pot[2] ? readAmount(pot[2], lineNo) : 0;
          continue;
        }
        const printedBoard = line.match(/^Board: \[([^\]]*)\]\s*$/);
        if (printedBoard) {
          summaryBoard = cardsIn(printedBoard[1]);
          continue;
        }
        if (/^Seat \d+: /.test(line)) {
          // The summary restates the stream; the builder regenerates it from the
          // structured data so that the text round-trips.
          continue;
        }
        warnings.push({ code: "unknown-summary-line", message: line, line: lineNo });
        continue;
      }

      const seat = line.match(SEAT);
      if (seat) {
        const name = seat[2].trim();
        if (!name) {
          throw new ParseSkip("unnamed-seat", `Seat ${seat[1]} has no player name.`);
        }
        if (names.includes(name)) {
          throw new ParseSkip("duplicate-player", `"${name}" is seated twice.`);
        }
        if (seats.some((entry) => entry.seat === Number(seat[1]))) {
          throw new ParseSkip("duplicate-seat", `Seat ${seat[1]} is occupied twice.`);
        }
        seats.push({
          seat: Number(seat[1]),
          name,
          startingStack: readAmount(seat[3].trim(), lineNo),
          // Winamax lists only the seats that were dealt into the hand.
          dealtIn: true,
          isHero: false,
          dealtCards: [],
        });
        names.push(name);
        names.sort((a, b) => b.length - a.length);
        continue;
      }

      const dealt = line.match(/^Dealt to (.+) \[([^\]]*)\]\s*$/);
      if (dealt) {
        // The deal line is the only hero marker Winamax has; there is nothing on
        // the seat line to say whose export this is.
        const owner = seats.find((entry) => entry.name === dealt[1].trim());
        if (!owner) {
          throw new ParseSkip("unseated-actor", `"${dealt[1]}" is dealt cards but is not seated.`);
        }
        owner.isHero = true;
        owner.dealtCards = cardsIn(dealt[2]);
        continue;
      }

      const name = nameOf(line);
      if (!name) {
        warnings.push({ code: "unknown-line", message: line, line: lineNo });
        continue;
      }
      const rest = line.slice(name.length + 1);
      const allIn = / and is all-in$/.test(rest);
      const verb = rest.replace(/ and is all-in$/, "");

      if (verb === "folds" || verb === "checks") {
        actions.push({
          street,
          player: name,
          kind: verb === "folds" ? "fold" : "check",
          line: lineNo,
        });
        continue;
      }

      const blind = verb.match(/^posts (small|big) blind (\S+)(.*)$/);
      if (blind) {
        const qualifier = blind[3].trim();
        if (qualifier && qualifier !== "out of position") {
          warnings.push({ code: "unknown-line", message: line, line: lineNo });
          continue;
        }
        actions.push({
          street: "preflop",
          player: name,
          // `posts big blind X out of position` is a player buying in mid-orbit.
          // The money is live - the poster checks his option on the next line -
          // but it is not the table's big blind and must not move the ring.
          kind: qualifier ? "post" : blind[1] === "small" ? "small-blind" : "big-blind",
          amount: readAmount(blind[2], lineNo),
          allIn,
          line: lineNo,
        });
        continue;
      }

      const ante = verb.match(/^posts ante (\S+)$/);
      if (ante) {
        actions.push({
          street: "preflop",
          player: name,
          kind: "ante",
          amount: readAmount(ante[1], lineNo),
          allIn,
          line: lineNo,
        });
        continue;
      }

      const callBet = verb.match(/^(calls|bets) (\S+)$/);
      if (callBet) {
        actions.push({
          street,
          player: name,
          kind: callBet[1] === "calls" ? "call" : "bet",
          amount: readAmount(callBet[2], lineNo),
          allIn,
          line: lineNo,
        });
        continue;
      }

      const raise = verb.match(/^raises (\S+) to (\S+)$/);
      if (raise) {
        actions.push({
          street,
          player: name,
          kind: "raise",
          // The "to" number is the one worth trusting; the builder recomputes the
          // "by" number from the betting state at serialization time.
          amount: readAmount(raise[2], lineNo),
          toTotal: true,
          allIn,
          line: lineNo,
        });
        continue;
      }

      const shows = verb.match(/^shows \[([^\]]*)\](?: \((.+)\))?$/);
      if (shows) {
        actions.push({
          street,
          player: name,
          kind: "show",
          cards: cardsIn(shows[1]),
          // `One pair : Queens`, `Two pairs : Aces and 7` - the space before the
          // colon is a French-to-English idiom and is kept verbatim.
          description: shows[2],
          line: lineNo,
        });
        continue;
      }

      const collect = verb.match(/^collected (\S+) from (.+)$/);
      if (collect) {
        collected.push({
          player: name,
          amount: readAmount(collect[1], lineNo),
          potName: collect[2],
        });
        continue;
      }

      warnings.push({ code: "unknown-line", message: line, line: lineNo });
    }

    /* ------------------------------------------------------------- checks -- */

    if (seats.length === 0) {
      throw new ParseSkip("no-players", "The hand lists no seats.");
    }
    if (reportedPot === null || reportedRake === null) {
      throw new ParseSkip("truncated-hand", "The hand has no readable `Total pot` line.");
    }

    // Hold'em deals two cards. A different count means the header lied about the
    // game, which is the one way an Omaha hand could reach this far.
    for (const action of actions) {
      if (action.kind === "show" && (action.cards?.length ?? 0) !== 2) {
        throw new ParseSkip(
          "unsupported-variant",
          `A showdown reveals ${action.cards?.length ?? 0} cards, so this is not Hold'em.`,
        );
      }
    }
    for (const seat of seats) {
      if (seat.dealtCards.length > 0 && seat.dealtCards.length !== 2) {
        throw new ParseSkip(
          "unsupported-variant",
          `${seat.name} was dealt ${seat.dealtCards.length} cards, so this is not Hold'em.`,
        );
      }
    }

    // The street markers are authoritative and the summary board is a copy of
    // them, so the markers have to be a prefix of the summary. When the two name
    // different cards there is no way to tell which one is the hand that was
    // played, and storing either would hand a tracker a board that may never
    // have existed. One corpus file (`CashGame_StreetTests_Flop.txt`) deals
    // [3d 3s 2s] and then reports [7h Qs 3c]; it is refused here.
    const markerBoard = [...(flop ?? []), ...(turn ? [turn] : []), ...(river ? [river] : [])];
    if (
      summaryBoard &&
      (markerBoard.length > summaryBoard.length ||
        markerBoard.some((card, index) => summaryBoard[index] !== card))
    ) {
      throw new ParseSkip(
        "board-mismatch",
        `The street markers deal [${markerBoard.join(" ")}] but the summary reports ` +
          `[${summaryBoard.join(" ")}]; the two cannot both be the board.`,
      );
    }
    if (summaryBoard && summaryBoard.length > markerBoard.length) {
      flop = summaryBoard.slice(0, 3);
      turn = summaryBoard[3] ?? null;
      river = summaryBoard[4] ?? null;
      warnings.push({
        code: "board-from-summary",
        message:
          `The street markers stop after ${markerBoard.length} cards; the rest of the ` +
          "board is taken from the summary.",
      });
    }

    if (tableMatch[3] === "play") {
      warnings.push({
        code: "play-money-table",
        message: "The table is flagged as play money, so the amounts are not real currency.",
      });
    }

    const draft: P6Draft = {
      siteId: "winamax",
      siteName: "Winamax",
      parserId: "winamax",
      parserVersion: VERSION,
      handPrefix: "WMX-",
      handId: headerMatch[2],
      gameLabel: canonicalLabel(gameLabel),
      unit,
      // `0.50€` and `1€`: trailing zeros kept on fractional amounts, round
      // amounts unpadded, which is exactly what `fixed2` means here.
      decimals: "fixed2",
      headerSmallBlind: smallBlind,
      headerBigBlind: bigBlind,
      tableName: tableMatch[1] || null,
      maxSeats: Number(tableMatch[2]),
      buttonSeat: tableMatch[4] ? Number(tableMatch[4]) : null,
      tournament: null,
      playedAt: isoFrom(headerMatch, 5),
      seats,
      actions,
      flop,
      turn,
      river,
      collected,
      // The heart of the format: Winamax never returns an unmatched bet, it
      // leaves it in the pot and pays it back inside `collected`.
      collectedIncludesUncalled: true,
      printedUncalled: [],
      // `Total pot` is net of rake, so the gross the stream has to reproduce is
      // the printed pot plus the printed rake.
      reportedGross: reportedPot + reportedRake,
      reportedPayout: null,
      reportedRake,
      rawText: text,
      warnings,
    };

    return buildP6Hand(draft, ctx);
  },
};

/**
 * Refuses any hand whose amounts are not in the one shape this corpus proves.
 *
 * This is the guard that matters most in the file. `parseAmount` strips every
 * non-digit before reading a number, so `1 234,50 €` would come back as 123450
 * cents. Checking the shape of every `<digits><symbol>` token up front is the
 * only way to be sure that never happens, because by the time an individual
 * amount reaches `parseAmount` the evidence has already been thrown away.
 */
function assertRepresentableAmounts(text: string, symbol: string): void {
  const token = new RegExp(
    String.raw`([\d][\d.,\u00a0\u202f ]*)${escapeRegExp(symbol)}`,
    "g",
  );
  for (const match of text.matchAll(token)) {
    if (!SAFE_AMOUNT.test(match[1])) {
      throw new ParseSkip(
        "unsupported-locale",
        `"${match[1]}${symbol}" is not a plain decimal amount. This parser only reads the ` +
          "period-decimal, no-separator format the verified corpus uses; a locale that " +
          "groups thousands or uses a comma decimal would be misread by a factor of 100.",
      );
    }
  }
}

/** `Holdem no limit` -> `Hold'em No Limit`, the label the standard text uses. */
function canonicalLabel(label: string): string {
  if (/pot\s*limit/i.test(label)) {
    return "Hold'em Pot Limit";
  }
  if (/no\s*limit/i.test(label)) {
    return "Hold'em No Limit";
  }
  return "Hold'em Limit";
}

/**
 * Header timestamp to ISO.
 *
 * Every hand in the corpus is stamped `UTC`; the reference parser also mentions
 * `CET`, `CEST` and `PST`, none of which appears here. Following the house
 * convention for this project the printed clock is read as the instant and the
 * zone token is left in `meta.rawText` rather than applied - `parsers/pokerstars.ts`
 * treats `ET` the same way, and a parser that silently disagreed with its
 * neighbours would be worse than one that is consistently naive.
 */
function isoFrom(match: RegExpMatchArray, at: number): string | null {
  const stamp = Date.UTC(
    Number(match[at]),
    Number(match[at + 1]) - 1,
    Number(match[at + 2]),
    Number(match[at + 3]),
    Number(match[at + 4]),
    Number(match[at + 5]),
  );
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}

function cardsIn(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
