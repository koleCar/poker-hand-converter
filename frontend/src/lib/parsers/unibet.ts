/**
 * Unibet Poker parser (the room's own plain-text export, not its iPoker skin).
 *
 * Unibet has shipped two structurally different headers inside the sample
 * window and nothing announced the change, so both are handled here:
 *
 * - **2021 ("legacy")**
 *   `Game #1463192545: Table €1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04`
 *   - one line, no table-size, no timezone token, and the only place the
 *     currency symbol appears in the header is the table *name* (`€1`).
 * - **2026 ("current", the Relax Gaming client)**
 *   `Unibet Hand #1558006027 - 0.03/0.05 - Pot Limit Omaha - UTC 21:59:40 2026/06/05`
 *   followed by a separate `Table "86113818" 6-max` line, and a tournament
 *   variant that inserts `, Tournament #<id>, <buyin> + <fee>` and
 *   `- Total prize <amount>`.
 *
 * The hand *bodies* are the same in both eras, which is why there is one body
 * reader below and two header readers.
 *
 * Things that bite, all of them fixture- or research-confirmed:
 *
 * - **The board repeats itself.** `*** River *** [2h 3s 6s] [Qs] [4d]` is
 *   flop+turn+river in three separate brackets, not one river card. Only the
 *   last group is new.
 * - **`Total pot` is the gross pot, uncalled money included.** Fixture 01 has a
 *   €0.95 shove that nobody called, no `Uncalled bet` line at all, `Hero wins
 *   €1.10` and `Total pot €1.10` - i.e. the room hands the shove straight back
 *   inside `wins` and counts it in the pot. PHF's `results.totalPot` is the
 *   contested pot, so the number printed here is deliberately *not* copied; it
 *   is only used as a cross-check.
 * - **The per-seat summary figures are not a pot distribution.** `bet X and won
 *   Y` adds a player's own uncalled bet back into `Y`, so the `won` column can
 *   sum to more than the pot. The `net result` column *is* trustworthy, and is
 *   used below as an independent check on the reconstruction.
 * - **The hero's name carries a session token**, `hero[Unibet_28204e08...]`, on
 *   every occurrence. It changes between sessions, so it is stripped: without
 *   that, the same player is a different person in every file.
 * - **Encoding is not reliably UTF-8.** See `refuseLossyText` below.
 * - **`Uncalled bet returned to <name>: <amt>`** is Unibet's shape, not
 *   PokerStars' `Uncalled bet (<amt>) returned to <name>`.
 *
 * Everything from the pot reconstruction on is `shared/p2-handbuilder.ts`: the
 * room states increments and a "wins" total, which is exactly the shape that
 * module was written for. The only thing it cannot do is a tournament header,
 * so the normalized text's first line is rewritten before it is re-read.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import { parseStandardHand } from "../phf/serialize";
import {
  chipsUnitFor,
  formatAmount,
  formatAmountDigits,
  parseAmount,
  parseBuyInToken,
  totalFees,
  unitForSymbol,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import {
  draftToStandardText,
  formatHeaderDate,
  type DraftAction,
  type DraftSeat,
  type DraftStreet,
  type HandDraft,
} from "./shared/p2-handbuilder";
import {
  currencySymbolOf,
  leadingName,
  namesByLength,
  refuseLossyText,
  strictAmount,
} from "./shared/p4-textroom";

const VERSION = "1.0.0";

/* ----------------------------------------------------------------- headers - */

/** 2021: `Game #<id>: Table <cur><n> <LIMIT> - <sb>/<bb> - <game> - <time> <date>`. */
const LEGACY_HEADER =
  /^Game\s+#(\d+):\s+Table\s+(\S+)\s+(PL|NL|FL)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)\s+-\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$/;

/** 2026 cash: `Unibet Hand #<id> - <sb>/<bb> - <game> - UTC <time> <date>`. */
const MODERN_CASH_HEADER =
  /^Unibet\s+Hand\s+#(\d+)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)\s+-\s+(?:UTC\s+)?(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$/;

/** 2026 tournament: the cash header plus buy-in, fee and prize pool. */
const MODERN_TOUR_HEADER =
  /^Unibet\s+Hand\s+#(\d+),\s+Tournament\s+#(\S+?),\s+(\S+)\s+\+\s+(\S+)\s+-\s+([\d.,]+)\/([\d.,]+)\s+-\s+(.+?)(?:\s+-\s+Total\s+prize\s+(\S+))?\s+-\s+(?:UTC\s+)?(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\/(\d{2})\/(\d{2})\s*$/;

/** The separate tournament-summary export, which is not a hand history. */
const SUMMARY_FILE_HEADER = /^Unibet\s+Tournament\s+#(\S+?),/;

/** Anything that starts a new record in a Unibet file. */
const CHUNK_START = /(?=^(?:Unibet\s+(?:Hand|Tournament)\s+#|Game\s+#\d+:\s+Table\s))/m;

const TABLE_LINE = /^Table\s+"([^"]*)"\s+(\d+)-max\s*$/;
const SEAT_LINE = /^Seat\s+(\d+):\s+(.+)\s+\((\S+)\)$/;
const SECTION_LINE = /^\*\*\*\s*(.+?)\s*\*\*\*(.*)$/;
const SUMMARY_SEAT_LINE =
  /^Seat\s+(\d+):\s+(.+):\s+bet\s+(\S+)\s+and\s+won\s+(\S+),\s+net\s+result:\s+(\S+)\s*$/;
const TOTAL_POT_LINE = /^Total\s+pot\s+(\S+)(?:\s+Rake\s+(\S+))?\s*$/;
const UNCALLED_LINE = /^Uncalled\s+bet\s+returned\s+to\s+(.+):\s+(\S+)\s*$/;

/** The session token Unibet welds onto the hero's name in the 2026 format. */
const HERO_TOKEN = /\[Unibet_[0-9a-fA-F]+\]/g;
const HERO_SEAT = /^Seat\s+\d+:\s+(.+?)\[Unibet_[0-9a-fA-F]+\]\s+\(/m;

interface Header {
  handId: string;
  gameLabel: string;
  variantWord: string;
  limit: "nl" | "pl" | "fl";
  smallBlind: string;
  bigBlind: string;
  playedAt: string;
  /** Table name, when the header carries one (2021 only). */
  tableName: string | null;
  /** Fast-fold brand from the game label (`Banzai`), or null. */
  fastFold: string | null;
  tournament: { id: string; buyInToken: string; prizeToken: string | null } | null;
}

function isoAt(h: string, mi: string, s: string, y: string, mo: string, d: string): string {
  // Both eras print `HH:MM:SS YYYY/MM/DD`; only the 2026 one states that it is
  // UTC. The 2021 timestamps have no zone at all - the upstream parser's author
  // was not sure either - so they are read as UTC and the error, if any, is a
  // constant offset rather than a wrong instant per hand.
  return new Date(
    `${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${s}Z`,
  ).toISOString();
}

function limitFromLabel(label: string, token?: string): "nl" | "pl" | "fl" {
  if (token) {
    return token === "PL" ? "pl" : token === "FL" ? "fl" : "nl";
  }
  if (/\bpot\s+limit\b/i.test(label)) {
    return "pl";
  }
  if (/\b(?:fixed\s+limit|limit)\b/i.test(label) && !/\bno\s+limit\b/i.test(label)) {
    return "fl";
  }
  return "nl";
}

function readHeader(line: string): Header | null {
  const tour = line.match(MODERN_TOUR_HEADER);
  if (tour) {
    return {
      handId: tour[1],
      gameLabel: tour[7],
      variantWord: tour[7],
      limit: limitFromLabel(tour[7]),
      smallBlind: tour[5],
      bigBlind: tour[6],
      playedAt: isoAt(tour[9], tour[10], tour[11], tour[12], tour[13], tour[14]),
      tableName: null,
      fastFold: fastFoldOf(tour[7]),
      tournament: {
        id: tour[2],
        buyInToken: `${tour[3]}+${tour[4]}`,
        prizeToken: tour[8] ?? null,
      },
    };
  }
  const cash = line.match(MODERN_CASH_HEADER);
  if (cash) {
    return {
      handId: cash[1],
      gameLabel: cash[4],
      variantWord: cash[4],
      limit: limitFromLabel(cash[4]),
      smallBlind: cash[2],
      bigBlind: cash[3],
      playedAt: isoAt(cash[5], cash[6], cash[7], cash[8], cash[9], cash[10]),
      tableName: null,
      fastFold: fastFoldOf(cash[4]),
      tournament: null,
    };
  }
  const legacy = line.match(LEGACY_HEADER);
  if (legacy) {
    return {
      handId: legacy[1],
      gameLabel: legacy[6],
      variantWord: legacy[6],
      limit: limitFromLabel(legacy[6], legacy[3]),
      smallBlind: legacy[4],
      bigBlind: legacy[5],
      playedAt: isoAt(legacy[7], legacy[8], legacy[9], legacy[10], legacy[11], legacy[12]),
      // The 2021 header has no table line at all; the `€1 NL` token is the only
      // thing identifying the table, so it is kept as the name.
      tableName: `${legacy[2]} ${legacy[3]}`,
      fastFold: fastFoldOf(legacy[6]),
      tournament: null,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ parser - */

export const unibetParser: SiteParser = {
  id: "unibet",
  name: "Unibet Poker",
  version: VERSION,

  detect(text: string): number {
    // Unibet also runs (or ran) an iPoker skin, whose export is XML and belongs
    // to `parsers/ipoker.ts`. The two share nothing but the brand name, so an
    // XML document is never ours no matter how often it says "Unibet".
    if (/<\s*(?:session|game|description)\b/i.test(text)) {
      return 0;
    }
    if (/^Unibet\s+Hand\s+#\d+(?:,\s+Tournament\s+#|\s+-\s)/m.test(text)) {
      return 0.95;
    }
    // `Game #` on its own is not ours - Entraction opens every hand with
    // `Game # <id> - Texas Hold'em ...` - so the whole legacy shape has to be
    // there, colon and `Table <currency><digits> <limit>` included.
    if (/^Game\s+#\d+:\s+Table\s+\S+\s+(?:PL|NL|FL)\s+-\s+[\d.,]+\/[\d.,]+\s+-\s/m.test(text)) {
      return 0.95;
    }
    // The tournament-summary export. Recognised so that it gets a named refusal
    // instead of "no parser recognised this file".
    if (/^Unibet\s+Tournament\s+#\S+,/m.test(text)) {
      return 0.9;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .split(CHUNK_START)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter(
        (chunk) =>
          SUMMARY_FILE_HEADER.test(chunk) || readHeader(chunk.split(/\r?\n/)[0] ?? "") !== null,
      );
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const source = raw.replace(/^﻿/, "").trim();
    refuseLossyText(source, "Unibet");

    if (SUMMARY_FILE_HEADER.test(source.split(/\r?\n/)[0] ?? "")) {
      throw new ParseSkip(
        "tournament-summary",
        "This is a Unibet tournament-summary record, not a hand history; there are " +
          "no hands in it to convert.",
      );
    }

    // The hero's session token has to go before anything else reads a name, or
    // the same player is a different person in every file. Which seat it was on
    // is the one thing worth keeping from it.
    const heroName = source.match(HERO_SEAT)?.[1] ?? null;
    const lines = source.replace(HERO_TOKEN, "").split(/\r?\n/);

    const header = readHeader(lines[0]);
    if (!header) {
      throw new ParseSkip("no-header", "The chunk does not open with a Unibet header line.");
    }
    if (!/hold\s*'?\s*em/i.test(header.variantWord)) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${header.variantWord.trim()}".`,
      );
    }
    if (ctx.options.cashOnly && header.tournament) {
      throw new ParseSkip("tournament-in-cash-mode", "Tournament hand skipped.");
    }

    const warnings: PhfWarning[] = [];
    const seats: DraftSeat[] = [];
    const actions: DraftAction[] = [];
    const collected: HandDraft["collected"] = [];
    const dealt = new Map<string, string[]>();
    const shown = new Set<string>();
    const reported = new Map<string, { won: Amount; net: Amount }>();

    let tableName = header.tableName;
    let maxSeats = 0;
    let buttonSeat: number | null = null;
    let street: DraftStreet = "preflop";
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let inSummary = false;
    let statedPot: Amount | null = null;
    let statedRake: Amount | null = null;
    let statedUncalled: { player: string; amount: Amount } | null = null;
    let bigBlind = 0;

    // Everything below needs the seat list, which Unibet prints before any
    // action, and the unit, which only the seat stacks state reliably: the 2026
    // cash header's blinds carry no symbol at all. So the seats are read in a
    // first pass and the unit is fixed before the actions are read.
    const seatLines: Array<{ seat: number; name: string; stack: string; sittingOut: boolean }> = [];
    for (const line of lines) {
      const text = line.trim();
      const seat = text.replace(/\s*\(sitting out\)\s*$/i, "").match(SEAT_LINE);
      if (seat && !SUMMARY_SEAT_LINE.test(text)) {
        seatLines.push({
          seat: Number(seat[1]),
          name: seat[2].trim(),
          stack: seat[3],
          sittingOut: /\(sitting out\)\s*$/i.test(text),
        });
      }
    }
    if (seatLines.length === 0) {
      throw new ParseSkip("no-players", "The chunk has no `*** Seated players ***` block.");
    }

    // `chipsUnitFor` is asked about the hand *body* only. The 2026 tournament
    // header writes its blinds as `25.00/50.00` purely as formatting while every
    // in-hand amount is a bare integer, so handing it the header would read a
    // whole-chip structure as a fractional one and scale the hand by 100.
    const unit = unitFor(header, seatLines, lines.slice(1).join("\n"), warnings);
    const names = namesByLength(seatLines.map((entry) => entry.name));
    for (const entry of seatLines) {
      seats.push({
        seat: entry.seat,
        name: entry.name,
        startingStack: strictAmount(entry.stack, unit, "a seat stack"),
        dealtIn: false,
        isHero: entry.name === heroName,
        dealtCards: [],
      });
    }

    const act = (player: string, action: Omit<DraftAction, "street" | "player">) => {
      actions.push({ street, player, ...action });
    };

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const lineNo = i + 1;
      if (!line || line === "=== HAND HISTORIES ===" || line === "=== TOURNAMENT SUMMARIES ===") {
        continue;
      }

      const section = line.match(SECTION_LINE);
      if (section) {
        const name = section[1].toLowerCase();
        const cards = [...section[2].matchAll(/\[([^\]]*)\]/g)];
        // Turn and river repeat every earlier street in brackets of their own,
        // so only the last group is this street's new card(s).
        const fresh = extractCards(cards[cards.length - 1]?.[1] ?? "");
        if (name === "flop") {
          street = "flop";
          flop = fresh;
        } else if (name === "turn") {
          street = "turn";
          turn = fresh[0] ?? null;
        } else if (name === "river") {
          street = "river";
          river = fresh[0] ?? null;
        } else if (name === "summary") {
          inSummary = true;
        }
        // `seated players`, `blinds and button`, `hole cards`, `preflop` and
        // `showdown` all leave the betting street where it was: preflop for the
        // first four, and the last betting street for a showdown, which is what
        // the reveal belongs to.
        continue;
      }

      if (inSummary) {
        const pot = line.match(TOTAL_POT_LINE);
        if (pot) {
          statedPot = strictAmount(pot[1], unit, "the summary total pot");
          statedRake = pot[2] === undefined ? null : strictAmount(pot[2], unit, "the summary rake");
          continue;
        }
        const seat = line.match(SUMMARY_SEAT_LINE);
        if (seat) {
          reported.set(seat[2].trim(), {
            won: strictAmount(seat[4], unit, "a summary seat line"),
            net: strictAmount(seat[5], unit, "a summary seat line"),
          });
          continue;
        }
        warnings.push({ code: "unknown-line", message: line, line: lineNo });
        continue;
      }

      const seat = line.replace(/\s*\(sitting out\)\s*$/i, "").match(SEAT_LINE);
      if (seat && seatLines.some((entry) => entry.seat === Number(seat[1]))) {
        continue; // already read in the seat pass
      }

      const table = line.match(TABLE_LINE);
      if (table) {
        tableName = table[1];
        maxSeats = Number(table[2]);
        continue;
      }

      const dealtTo = line.match(/^Dealt\s+to\s+(.+)\s+\[([^\]]*)\]\s*$/);
      if (dealtTo && names.includes(dealtTo[1].trim())) {
        dealt.set(dealtTo[1].trim(), extractCards(dealtTo[2]));
        continue;
      }
      const dealtIn = line.match(/^Dealt\s+in\s+(.+)\s*$/);
      if (dealtIn && names.includes(dealtIn[1].trim())) {
        dealt.set(dealtIn[1].trim(), []);
        continue;
      }

      const uncalled = line.match(UNCALLED_LINE);
      if (uncalled && names.includes(uncalled[1].trim())) {
        statedUncalled = {
          player: uncalled[1].trim(),
          amount: strictAmount(uncalled[2], unit, "an uncalled-bet line"),
        };
        continue;
      }

      const hit = leadingName(line, names);
      if (hit) {
        const handled = readAction(hit.rest, {
          player: hit.name,
          unit,
          bigBlind,
          act,
          collected,
          shown,
          warn: (code, message) => warnings.push({ code, message, line: lineNo }),
        });
        if (handled === "button") {
          buttonSeat = seats.find((entry) => entry.name === hit.name)?.seat ?? null;
          continue;
        }
        if (handled === "big-blind") {
          const last = actions[actions.length - 1];
          bigBlind = Math.max(bigBlind, last?.amount ?? 0);
          continue;
        }
        if (handled === "refuse") {
          throw new ParseSkip(
            "cashout",
            "The hand contains an EV cash-out, which settles outside the pot and " +
              "is not modelled for this room yet.",
          );
        }
        if (handled) {
          continue;
        }
      }

      warnings.push({ code: "unknown-line", message: line, line: lineNo });
    }

    if (collected.length === 0) {
      throw new ParseSkip(
        "no-winner",
        "No `wins` line, so the source never says who was given the pot. Unibet " +
          "omits the winner on some preflop-fold hands and the pot cannot be " +
          "assigned without guessing.",
      );
    }

    // A `Dealt to <name> [cards]` line for somebody other than the hero is a
    // retroactive reveal, not a face-up deal, so it is emitted as a reveal. When
    // the player also has a `shows` line the reveal is already in the stream and
    // the deal line is only cross-checked against it.
    for (const seat of seats) {
      const cards = dealt.get(seat.name);
      seat.dealtIn = cards !== undefined;
      if (!cards || cards.length === 0) {
        continue;
      }
      if (seat.isHero) {
        seat.dealtCards = cards;
        continue;
      }
      if (!shown.has(seat.name)) {
        actions.push({ street, player: seat.name, kind: "muck", cards });
      }
    }
    // Falling back to "exactly one seat was shown cards" covers the 2021 format,
    // which has no session token: a showdown reveals at least two hands, so a
    // single known hand can only be the owner of the export.
    if (!heroName) {
      const known = [...dealt.entries()].filter(([, cards]) => cards.length > 0);
      if (known.length === 1) {
        const seat = seats.find((entry) => entry.name === known[0][0]);
        if (seat) {
          seat.isHero = true;
          seat.dealtCards = known[0][1];
          const muck = actions.findIndex(
            (action) => action.kind === "muck" && action.player === seat.name,
          );
          if (muck >= 0) {
            actions.splice(muck, 1);
          }
        }
      }
    }
    for (const entry of collected) {
      const seat = seats.find((candidate) => candidate.name === entry.player);
      if (seat) {
        // The big blind of a walk is dealt in whether or not a `Dealt` line said so.
        seat.dealtIn = true;
      }
    }

    if (flop && flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The flop marker lists ${flop.length} readable cards, so the hand is corrupt.`,
      );
    }

    const draft: HandDraft = {
      siteId: "unibet",
      siteName: "Unibet Poker",
      parserId: "unibet",
      parserVersion: VERSION,
      handPrefix: "UB-",
      handId: header.handId,
      gameLabel: canonicalLabel(header.limit),
      unit,
      decimals: "fixed2",
      headerSmallBlind: headerBlind(header.smallBlind, unit, "the header small blind"),
      headerBigBlind: headerBlind(header.bigBlind, unit, "the header big blind"),
      tableName,
      maxSeats: maxSeats || fallbackMaxSeats(seats),
      buttonSeat,
      playedAt: header.playedAt,
      seats,
      actions,
      flop,
      turn,
      river,
      collected,
      // Fixture 01 is the proof: a €0.95 shove nobody called, no `Uncalled bet`
      // line, `Hero wins €1.10` and a €1.10 stated pot. The shove comes back
      // inside `wins`. When the room *does* print a return line it has already
      // been taken out, so the flag follows the line.
      collectedIncludesUncalled: statedUncalled === null,
      rawText: source,
      warnings,
    };

    const hand = buildUnibetHand(draft, header, ctx);
    crossCheck(hand, { statedPot, statedRake, statedUncalled, reported, unit, warnings });
    return hand;
  },
};

/* ------------------------------------------------------------------- build - */

/**
 * Draft in, PHF out, with a tournament header the shared builder cannot write.
 *
 * `draftToStandardText` always emits the cash header shape, so a tournament's
 * first line is rewritten before the text is re-read. Nothing is invented on the
 * way: Unibet states blinds but never a level, and the standard grammar's `Level`
 * clause is optional, so the rewritten header simply omits it and `levelLabel`
 * stays null through the round trip.
 */
function buildUnibetHand(draft: HandDraft, header: Header, ctx: SiteParserContext): PhfHand {
  if (draft.seats.filter((seat) => seat.dealtIn).length < 2) {
    throw new ParseSkip(
      "too-few-players",
      "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
    );
  }

  let text = draftToStandardText(draft);
  if (header.tournament) {
    const buyInUnit = unitForSymbol(currencySymbolOf(header.tournament.buyInToken));
    const parts = parseBuyInToken(header.tournament.buyInToken, buyInUnit);
    const buyIn = formatAmount(parts.buyIn, buyInUnit, "fixed2");
    const fee = formatAmount(parts.fee, buyInUnit, "fixed2");
    const stakes =
      `${formatAmountDigits(draft.headerSmallBlind, draft.unit, "fixed2")}/` +
      `${formatAmountDigits(draft.headerBigBlind, draft.unit, "fixed2")}`;
    const date = draft.playedAt ? formatHeaderDate(draft.playedAt) : "";
    // No `Level` clause: Unibet states blinds but never a level, and the
    // standard grammar now lets the clause be absent rather than forcing a
    // fabricated `Level I` that reads back as level 1.
    const payload =
      `Tournament #${header.tournament.id}, ${buyIn}+${fee} ${draft.gameLabel} - ` +
      `(${stakes}) - ${date}`;
    text = text.replace(/^(Poker Hand #\S+:).*$/m, `$1 ${payload}`);
  }

  const hand = parseStandardHand(text, {
    siteId: draft.siteId,
    siteName: draft.siteName,
    originalFilename: ctx.sourceFilename,
    parserId: draft.parserId,
    parserVersion: draft.parserVersion,
  });
  if (!hand) {
    throw new ParseSkip(
      "normalized-unparseable",
      "The normalized text was not readable as a standard-format hand.",
    );
  }

  hand.meta.rawText = draft.rawText;
  hand.meta.warnings = [...draft.warnings, ...hand.meta.warnings];
  hand.meta.handKey = hand.meta.handId;
  if (header.fastFold) {
    hand.table.fastFold = header.fastFold;
  }
  if (hand.tournament && header.tournament?.prizeToken) {
    // `Total prize €4` is real money like the buy-in, not chips.
    hand.tournament.prizePool = parseAmount(
      header.tournament.prizeToken,
      hand.tournament.buyInUnit,
    );
  }
  return hand;
}

/* -------------------------------------------------------------- line reader - */

interface ActionContext {
  player: string;
  unit: CurrencyUnit;
  bigBlind: Amount;
  act: (player: string, action: Omit<DraftAction, "street" | "player">) => void;
  collected: HandDraft["collected"];
  shown: Set<string>;
  warn: (code: string, message: string) => void;
}

/**
 * Reads the part of an action line that follows the player's name.
 *
 * Returns `true` when the line was understood, the literal `"button"` /
 * `"big-blind"` when the caller has bookkeeping to do, `"refuse"` for a line
 * that moves money we do not model, and `false` when it means nothing here.
 */
function readAction(
  rest: string,
  ctx: ActionContext,
): boolean | "button" | "big-blind" | "refuse" {
  const { player, unit, act } = ctx;

  // `folds  (timed out)` carries two spaces before the parenthesis and
  // `folds (disconnect)` one; both are decoration on an ordinary action.
  let body = rest.replace(/\s+\((?:timed out|disconnect(?:ed)?|time out)\)\s*$/i, "").trim();
  let allIn = false;
  const shove = body.match(/,\s*and\s+is\s+all-in\s*$/i);
  if (shove) {
    allIn = true;
    body = body.slice(0, shove.index).trim();
  }

  if (/^has the button$/i.test(body)) {
    return "button";
  }
  if (/^(?:is\s+)?sitting out$/i.test(body) || /^sits out$/i.test(body)) {
    return true;
  }

  const posted = body.match(
    /^posts\s+(small blind|big blind|small & big blinds|button blind|straddle|the ante?)\s+(\S+)$/i,
  );
  if (posted) {
    const kind = posted[1].toLowerCase();
    const amount = strictAmount(posted[2], unit, "a posting line");
    if (kind === "small blind") {
      act(player, { kind: "small-blind", amount, allIn });
      return true;
    }
    if (kind === "big blind") {
      act(player, { kind: "big-blind", amount, allIn });
      return "big-blind";
    }
    if (kind === "the ant" || kind === "the ante") {
      // The upstream parser's regex expects the misspelling `posts the ant`.
      // Nothing in the corpus settles whether that is a real site typo, so both
      // spellings are read and the odd one is flagged rather than trusted.
      if (kind === "the ant") {
        ctx.warn("unconfirmed-line", `Ante written as "posts the ant": ${body}`);
      }
      act(player, { kind: "ante", amount, allIn });
      return true;
    }
    if (kind === "small & big blinds") {
      // A player returning from a sit-out posts the big blind live plus a dead
      // small blind on one line. The split needs the big blind, which by this
      // point has been posted by somebody.
      const live = Math.min(ctx.bigBlind || amount, amount);
      ctx.warn("unconfirmed-line", `Combined blind post read as ${live} live: ${body}`);
      act(player, { kind: "post", amount: live, dead: amount - live, allIn });
      return true;
    }
    ctx.warn("unconfirmed-line", `Posting shape read as a live post: ${body}`);
    act(player, { kind: kind === "straddle" ? "straddle" : "post", amount, allIn });
    return true;
  }

  if (/^folds$/i.test(body)) {
    act(player, { kind: "fold" });
    return true;
  }
  if (/^checks$/i.test(body)) {
    act(player, { kind: "check" });
    return true;
  }

  const called = body.match(/^calls\s+(\S+)$/i);
  if (called) {
    act(player, { kind: "call", amount: strictAmount(called[1], unit, "a call"), allIn });
    return true;
  }
  const bet = body.match(/^bets\s+(\S+)$/i);
  if (bet) {
    act(player, { kind: "bet", amount: strictAmount(bet[1], unit, "a bet"), allIn });
    return true;
  }
  const raised = body.match(/^raises\s+\S+\s+to\s+(\S+)$/i);
  if (raised) {
    // Both numbers are printed; only the "to" total is reliable. Fixture 01's
    // `raises €0.95 to €0.95` states a raise-by that is the whole stack rather
    // than the amount over the big blind, so the "by" figure is not read at all.
    act(player, {
      kind: "raise",
      amount: strictAmount(raised[1], unit, "a raise"),
      toTotal: true,
      allIn,
    });
    return true;
  }

  const shows = body.match(/^shows\s+\[([^\]]*)\](?:,\s*(.*))?$/i);
  if (shows) {
    ctx.shown.add(player);
    act(player, {
      kind: "show",
      cards: extractCards(shows[1]),
      description: shows[2]?.trim() || undefined,
    });
    return true;
  }
  const mucks = body.match(/^(?:mucks|does not show(?: cards)?|doesn't show(?: hand)?)(?:\s+\[([^\]]*)\])?$/i);
  if (mucks) {
    ctx.shown.add(player);
    act(player, { kind: "muck", cards: extractCards(mucks[1] ?? "") });
    return true;
  }

  // `wins side pot #1, <amt>` / `wins <amt> from main pot` / `wins <amt>`.
  const sidePot = body.match(/^wins\s+(main|side)\s+pot(?:\s+#\d+)?,\s+(\S+)$/i);
  if (sidePot) {
    ctx.collected.push({
      player,
      amount: strictAmount(sidePot[2], unit, "a side-pot win line"),
      potName: `${sidePot[1].toLowerCase()} pot`,
    });
    return true;
  }
  const wins = body.match(/^wins\s+(\S+)(?:\s+from\s+(main|side)\s+pot(?:\s+#\d+)?)?$/i);
  if (wins) {
    ctx.collected.push({
      player,
      amount: strictAmount(wins[1], unit, "a win line"),
      potName: wins[2] ? `${wins[2].toLowerCase()} pot` : "pot",
    });
    return true;
  }

  // Money that settles outside the pot. Bounties and tournament placings do not
  // touch the pot, so they are noted and dropped; a cash-out does, so it is
  // refused rather than converted with a pot that is quietly wrong.
  if (/^cashed out the hand for\b/i.test(body)) {
    return "refuse";
  }
  if (
    /^wins\s+(?:the\s+)?\S+\s+(?:bounty\s+)?for eliminating\b/i.test(body) ||
    /^wins the tournament and receives\b/i.test(body) ||
    /^finished the tournament in\b/i.test(body)
  ) {
    ctx.warn(
      "outside-pot",
      `Bounty or placing payment recorded in the raw text only: ${ctx.player} ${body}`,
    );
    return true;
  }

  return false;
}

/* ----------------------------------------------------------- cross-checking - */

/**
 * Checks the reconstruction against the numbers Unibet states independently.
 *
 * The point is to catch a parse that balances but is still wrong. `net result`
 * is the useful column: it is `what the player received minus what they put in`,
 * which is exactly PHF's `net`, and it is computed by the room from its own
 * ledger rather than from the lines we just read.
 */
function crossCheck(
  hand: PhfHand,
  input: {
    statedPot: Amount | null;
    statedRake: Amount | null;
    statedUncalled: { player: string; amount: Amount } | null;
    reported: Map<string, { won: Amount; net: Amount }>;
    unit: CurrencyUnit;
    warnings: PhfWarning[];
  },
): void {
  const warn = (code: string, message: string) => hand.meta.warnings.push({ code, message });

  if (input.statedRake !== null && Math.abs(input.statedRake - hand.results.fees.rake) > 1) {
    warn(
      "rake-mismatch",
      `The summary states a rake of ${input.statedRake} but the reconstruction ` +
        `derives ${hand.results.fees.rake}.`,
    );
  }

  if (input.statedPot !== null) {
    // Unibet's `Total pot` is gross: it counts money that was returned uncalled.
    const returned = hand.actions
      .filter((action) => action.type === "uncalled")
      .reduce((sum, action) => sum - action.amount, 0);
    if (Math.abs(hand.results.totalPot + returned - input.statedPot) > 1) {
      warn(
        "pot-mismatch",
        `The summary states a pot of ${input.statedPot} but the stream accounts ` +
          `for ${hand.results.totalPot + returned}.`,
      );
    }
  }

  const derived = hand.actions.find((action) => action.type === "uncalled");
  if (input.statedUncalled && !derived) {
    warn(
      "uncalled-mismatch",
      `The source returns ${input.statedUncalled.amount} to ${input.statedUncalled.player} ` +
        "but the betting stream leaves nothing uncalled.",
    );
  } else if (input.statedUncalled && derived) {
    if (
      derived.player !== input.statedUncalled.player ||
      Math.abs(-derived.amount - input.statedUncalled.amount) > 1
    ) {
      warn(
        "uncalled-mismatch",
        `The source returns ${input.statedUncalled.amount} to ${input.statedUncalled.player}; ` +
          `the stream returns ${-derived.amount} to ${derived.player}.`,
      );
    }
  }

  for (const result of hand.results.players) {
    const stated = input.reported.get(result.player);
    if (stated && Math.abs(stated.net - result.net) > 1) {
      warn(
        "net-result-mismatch",
        `${result.player}: the summary states a net of ${stated.net}, the ` +
          `reconstruction ${result.net}.`,
      );
    }
  }

  if (totalFees(hand.results.fees) < 0) {
    warn("negative-rake", "The derived rake is negative.");
  }
}

/* ----------------------------------------------------------------- helpers - */

/**
 * The unit every amount in the hand is in.
 *
 * The seat stacks are the only reliable source: the 2026 cash header prints its
 * blinds without a symbol, and a tournament prints a real-money buy-in in the
 * header while every in-hand number is a bare chip count. So "no symbol on the
 * stacks" means chips, which is only allowed to be true when the header agrees
 * that this is a tournament.
 */
/**
 * Read a header blind, tolerating a purely decorative fractional part.
 *
 * The 2026 tournament header writes `25.00/50.00` while every in-hand amount is
 * a bare integer, so `unitFor` deliberately reads the structure as whole chips
 * (see its comment - reading the header instead would scale the hand by 100).
 * That leaves `strictAmount` refusing `25.00` as `too-precise`, which is the
 * wrong answer here: the guard exists to stop a separator being *guessed* at,
 * and a zero fractional part is exactly representable however it is read.
 * Anything with real precision behind the point still goes to `strictAmount`.
 */
function headerBlind(token: string, unit: CurrencyUnit, where: string): Amount {
  const whole = unit.minorUnits === 1 ? token.trim().match(/^(\d+)\.0+$/) : null;
  return whole ? strictAmount(whole[1], unit, where) : strictAmount(token, unit, where);
}

function unitFor(
  header: Header,
  seatLines: Array<{ stack: string }>,
  body: string,
  warnings: PhfWarning[],
): CurrencyUnit {
  const symbol = seatLines.map((entry) => currencySymbolOf(entry.stack)).find(Boolean) ?? "";
  if (!symbol) {
    if (!header.tournament) {
      throw new ParseSkip(
        "no-currency",
        "No seat stack carries a currency symbol and the header is not a " +
          "tournament header, so the amounts cannot be read as either cash or chips.",
      );
    }
    return chipsUnitFor(body);
  }
  if (header.tournament) {
    // Research says tournament chip counts never carry a symbol. If one turns
    // up, the stacks are still chips - but say so rather than silently rescale.
    warnings.push({
      code: "unexpected-currency",
      message: `Tournament stacks carry the symbol "${symbol}"; read as chips anyway.`,
    });
    return chipsUnitFor(body);
  }
  return unitForSymbol(symbol);
}

/**
 * Unibet's fast-fold brand, which lives inside the game label.
 *
 * `No Limit Hold'Em Banzai` is a Banzai pool; canonicalising the label to
 * `Hold'em No Limit` drops the word, so it is lifted out first.
 */
function fastFoldOf(gameLabel: string): string | null {
  return /\bbanzai\b/i.test(gameLabel) ? "Banzai" : null;
}

/** Unibet writes `No Limit Hold'Em`; trackers expect the GG wording. */
function canonicalLabel(limit: "nl" | "pl" | "fl"): string {
  if (limit === "pl") {
    return "Hold'em Pot Limit";
  }
  return limit === "fl" ? "Hold'em Limit" : "Hold'em No Limit";
}

/** The 2021 header states no table size; the 2026 one does. */
function fallbackMaxSeats(seats: DraftSeat[]): number {
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [2, 3, 4, 6, 9, 10].find((size) => size >= highest) ?? highest;
}
