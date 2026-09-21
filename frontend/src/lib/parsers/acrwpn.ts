/**
 * Americas Cardroom / Winning Poker Network parser.
 *
 * One network, four skins (ACR, Black Chip Poker, True Poker, Ya Poker) and -
 * this is the part that matters - **two structurally different grammars plus a
 * third anonymization mode**, all of which have to come out of one file.
 *
 * ## Dialects
 *
 * | id | Confirmed range | Header |
 * | --- | --- | --- |
 * | `legacy` | 2013-2019 | `Game started at: 2014/3/9 19:37:22` + `Game ID: <id> <sb>/<bb> <table> (<Game>)` |
 * | `modern` | 2019-2022 | `Hand #<id> - Holdem(No Limit) - $0.05/$0.10 - 2019/06/28 02:38:17 UTC` |
 * | `mined` | 2018 | `legacy` grammar with every screen name replaced by a numeric id |
 *
 * `mined` is parsed through the `legacy` path rather than refused: it is the
 * same grammar and the arithmetic balances. What it loses is identity - the
 * numeric ids may or may not be stable across hands, and there is no marker
 * saying which seat is the exporting player - so the hand carries a
 * `numeric-player-ids` warning and nothing downstream should treat those names
 * as screen names. Its summary also reports `Bets: 0` for everybody, so the
 * per-player cross-check below is skipped for it.
 *
 * ## Traps
 *
 * - **No skin ever prints a brand name, in any era.** Detection is structural:
 *   the `Game started at: ` / `Game ID: ` pair for `legacy`, and for `modern` a
 *   bare `Hand #` / `Game Hand #` header anchored to the start of a line and
 *   ending in a `UTC` timestamp. That anchor is what keeps it off PokerStars,
 *   Unibet and Chico, all of which prefix their header with a room name.
 * - **Encoding is unpredictable and uncorrelated with the era**: 14 of the 76
 *   sample files are UTF-16LE, including files dated the same month as
 *   plain-ASCII files of the same grammar. See `shared/p5-encoding.ts`.
 * - **`raises (N)` in `legacy` is an increment, not the street total.** The
 *   published description of this format says the opposite; the corpus does
 *   not. `ButtonSmasher` posts a 0.10 small blind, writes `raises (0.40)`, gets
 *   0.25 back uncalled and the summary reports `Bets: 0.25` - which only works
 *   if the 0.40 was added to the 0.10. Every hand is checked against that
 *   `Bets:` column, so a reading that was wrong anywhere would be refused.
 * - **The `Pot:` line is net of the rake, and on the older jackpot tables it is
 *   also net of an unprinted flat jackpot drop.** Twelve hold'em hands in the
 *   corpus are short by exactly $0.25 against `Pot + Rake`. The pot is
 *   therefore rebuilt from the contributions, and the shortfall above the
 *   stated rake is booked as a jackpot fee.
 * - **`modern` does not always print a `collected` line**; in four of the six
 *   hold'em hands the winner is named only in the SUMMARY block.
 * - A cancelled hand prints blinds and an uncalled return but deals no cards.
 *
 * Round one is Hold'em only: Omaha, Omaha Hi/Lo, seven-card stud and Six Plus
 * Hold'em all appear in the corpus and are deliberately refused.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  parseAmount,
  USD,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import { p5RecoverEncoding } from "./shared/p5-encoding";
import {
  p5BuildHand,
  type P5Action,
  type P5Collect,
  type P5Draft,
  type P5Seat,
  type P5Street,
} from "./shared/p5-handdraft";

const VERSION = "1.0.0";

/** `Game started at: 2014/3/9 19:37:22` - no leading zeros, no timezone. */
const LEGACY_HEADER_RE = /^Game started at:\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\s*$/;
/** `Hand #151588328 - ` / `Game Hand #1296393662 - `, anchored so it cannot
 *  match inside `<Room> Hand #...`. */
const MODERN_HEADER_RE = /^(?:Game\s)?Hand\s#(\d+)\s-\s(.*)$/;
const SPLIT_RE = /(?=^(?:Game started at:|(?:Game )?Hand #\d+ - ))/m;

/** `2019/11/08 04:43:23 UTC`, always zero padded in the modern dialect. */
const MODERN_DATE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*UTC\s*$/;

export type WpnDialect = "legacy" | "modern" | "mined";

/** Cards are written `10d` in the legacy dialect and `Td` in the modern one. */
const CARD_RE = /\b(?:10|[2-9TJQKA])[cdhs]\b/g;

function cardsIn(text: string): string[] {
  return (text.match(CARD_RE) ?? []).map((card) => (card.startsWith("10") ? `T${card[2]}` : card));
}

function isoFrom(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
): string {
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  ).toISOString();
}

/** Which grammar a chunk is written in, for dispatch and for test reporting. */
export function wpnDialect(chunk: string): WpnDialect | null {
  const first = p5RecoverEncoding(chunk).split(/\r?\n/)[0] ?? "";
  if (LEGACY_HEADER_RE.test(first.trim())) {
    return /^Seat \d+: \d+ \(/m.test(chunk) ? "mined" : "legacy";
  }
  if (MODERN_HEADER_RE.test(first.trim())) {
    return "modern";
  }
  return null;
}

/* ------------------------------------------------------------------ shared - */

interface Parsed {
  draft: P5Draft;
  handKey: string;
}

/** Everything a dialect reader fills in before the shared builder runs. */
interface Scratch {
  seats: P5Seat[];
  seatByName: Map<string, P5Seat>;
  actions: P5Action[];
  collected: P5Collect[];
  holeCards: Map<string, string[]>;
  warnings: PhfWarning[];
  statedContributions: Map<string, Amount>;
  street: P5Street;
  flop: string[] | null;
  turn: string | null;
  river: string | null;
  smallBlind: Amount;
  bigBlind: Amount;
  statedPayout: Amount | null;
  statedRake: Amount | null;
}

function newScratch(): Scratch {
  return {
    seats: [],
    seatByName: new Map(),
    actions: [],
    collected: [],
    holeCards: new Map(),
    warnings: [],
    statedContributions: new Map(),
    street: "preflop",
    flop: null,
    turn: null,
    river: null,
    smallBlind: 0,
    bigBlind: 0,
    statedPayout: null,
    statedRake: null,
  };
}

/**
 * Resolves the longest seat name that `text` starts with.
 *
 * The modern dialect puts the actor at the start of the line with no `Player `
 * keyword and real WPN screen names contain spaces, so the seat block is the
 * only thing that says where the name ends.
 */
function matchName(text: string, names: string[]): string | null {
  for (const name of names) {
    if (text === name || text.startsWith(`${name} `)) {
      return name;
    }
  }
  return null;
}

function sortedNames(seats: P5Seat[]): string[] {
  return seats.map((seat) => seat.name).sort((a, b) => b.length - a.length);
}

/** Applies the board cards a street marker carried, and moves the street on. */
function applyMarker(scratch: Scratch, kind: string, payload: string): void {
  const groups = [...payload.matchAll(/\[([^\]]*)\]/g)].map((group) => cardsIn(group[1]));
  const last = groups[groups.length - 1] ?? [];
  if (kind === "FLOP") {
    scratch.flop = last.slice(0, 3);
    scratch.street = "flop";
  } else if (kind === "TURN") {
    scratch.turn = last[0] ?? null;
    scratch.street = "turn";
  } else {
    scratch.river = last[0] ?? null;
    scratch.street = "river";
  }
}

/**
 * Fills in an `allin` that stated no amount, from what the seat had left.
 *
 * The legacy dialect writes a bare `Player X allin` when the client did not
 * know the figure. The amount is not a guess - an all-in is the rest of the
 * stack by definition - but it does have to be worked out after the whole
 * stream is read, because it depends on everything the seat put in before it.
 */
function resolveBareAllIns(scratch: Scratch): void {
  const spent = new Map<string, Amount>();
  for (const action of scratch.actions) {
    if (action.kind === "allin" && action.amount === undefined) {
      const seat = scratch.seatByName.get(action.player);
      if (!seat) {
        throw new ParseSkip("unseated-actor", `"${action.player}" is all-in but is not seated.`);
      }
      action.amount = Math.max(0, seat.startingStack - (spent.get(action.player) ?? 0));
    }
    // Reveals and folds move nothing; an uncalled return comes back out.
    const moved =
      action.kind === "uncalled"
        ? -(action.amount ?? 0)
        : (action.amount ?? 0) + (action.dead ?? 0);
    spent.set(action.player, (spent.get(action.player) ?? 0) + moved);
  }
}

/* ------------------------------------------------------------------ legacy - */

/** `Magnetite   (JP) - 5 (Hold'em)` / `PMS_27056799 (Hold'em) 8-max`. */
const LEGACY_GAME_RE = /^(.*?)\s*\(([^()]*)\)\s*(?:(\d+)\s*-\s*max)?\s*$/i;

interface LegacyHeader {
  handId: string;
  gameName: string;
  tableName: string;
  smallBlind: Amount;
  bigBlind: Amount;
  maxSeats: number | null;
  /** Tournament table number, when the table text carries one. */
  tableNumber: string | null;
  playedAt: string | null;
}

function readLegacyHeader(lines: string[], unitHint: CurrencyUnit): LegacyHeader | null {
  const started = lines[0]?.trim().match(LEGACY_HEADER_RE);
  const idLine = lines.find((line) => /^Game ID:/.test(line.trim()));
  if (!started || !idLine) {
    return null;
  }
  const id = idLine.trim().match(/^Game ID:\s*(\S+)\s+(\S+)\/(\S+)\s*(.*)$/);
  if (!id) {
    return null;
  }
  const info = id[4].trim();
  const game = info.match(LEGACY_GAME_RE);
  if (!game) {
    return null;
  }
  let table = game[1].trim();
  // `$5 Regular 9-Max, Table 1` - the table number is the only tournament
  // coordinate the legacy dialect ever prints.
  const tableNumber = table.match(/,\s*Table\s+(\d+)\s*$/);
  if (tableNumber) {
    table = table.slice(0, tableNumber.index).trim();
  }
  const maxInName = table.match(/(\d+)\s*-\s*max/i);
  return {
    handId: id[1],
    gameName: game[2].trim(),
    tableName: table,
    smallBlind: parseAmount(id[2], unitHint),
    bigBlind: parseAmount(id[3], unitHint),
    maxSeats: game[3] ? Number(game[3]) : maxInName ? Number(maxInName[1]) : null,
    tableNumber: tableNumber ? tableNumber[1] : null,
    playedAt: isoFrom(started[1], started[2], started[3], started[4], started[5], started[6]),
  };
}

/** Action verbs that carry no money and can safely be dropped. */
const LEGACY_NOISE_RE =
  /^(?:is timed out\.?|sitting out|wait BB|is disconnected and ALL IN\.?|mucks cards|is connected|is disconnected|stands up|sits down)$/i;

function parseLegacy(raw: string, ctx: SiteParserContext, dialect: WpnDialect): Parsed {
  const lines = raw.split(/\r?\n/);
  // The unit only matters for the divisor, and both possibilities share it
  // until we know whether this is a tournament; read the header twice rather
  // than guess, using cents first so fractional blinds survive.
  const probe = readLegacyHeader(lines, USD);
  if (!probe) {
    throw new ParseSkip("no-header", "The chunk has no readable `Game started at:` / `Game ID:` pair.");
  }
  if (!/^hold'?em$/i.test(probe.gameName)) {
    throw new ParseSkip(
      "unsupported-variant",
      `Round one is Hold'em only; this hand is "${probe.gameName}".`,
    );
  }

  const summaryIndex = lines.findIndex((line) => /^-+\s*Summary\s*-+$/i.test(line.trim()));
  if (summaryIndex < 0) {
    throw new ParseSkip("truncated-hand", "The hand has no `------ Summary ------` block.");
  }
  const potLine = lines
    .slice(summaryIndex)
    .map((line) => line.trim())
    .find((line) => /^Pot:/.test(line));
  if (!potLine) {
    throw new ParseSkip("truncated-hand", "The summary block has no `Pot:` line.");
  }
  // Cash prints a rake clause even when it is zero; a tournament never does.
  const isTournament = !/\.\s*Rake/i.test(potLine);
  if (ctx.options.cashOnly && isTournament) {
    throw new ParseSkip("tournament-in-cash-mode", "Tournament hand skipped.");
  }
  const unit = isTournament ? CHIPS : USD;
  const header = readLegacyHeader(lines, unit)!;
  const scratch = newScratch();
  scratch.smallBlind = header.smallBlind;
  scratch.bigBlind = header.bigBlind;

  const pot = potLine.match(
    /^Pot:\s*([\d.]+)(?:\.\s*Rake\s*([\d.]+))?(?:\.\s*JP fee\s*([\d.]+))?\s*$/i,
  );
  if (!pot) {
    throw new ParseSkip("truncated-hand", `Unreadable pot line "${potLine}".`);
  }
  scratch.statedPayout = parseAmount(pot[1], unit);
  scratch.statedRake =
    pot[2] === undefined ? null : parseAmount(pot[2], unit) + parseAmount(pot[3], unit);

  let buttonSeat: number | null = null;
  let dealtAnyCard = false;

  /* -------------------------------------------------------- seats first --- */

  for (const line of lines.slice(0, summaryIndex)) {
    const seat = line.trim().match(/^Seat\s+(\d+):\s+(.*?)\s+\(([\d.,]+)\)\.?\s*$/);
    if (seat) {
      const player: P5Seat = {
        seat: Number(seat[1]),
        name: seat[2],
        startingStack: parseAmount(seat[3], unit),
        isHero: false,
        // Only seats the dealer actually dealt to are in the hand; a seat that
        // is merely sitting at the table would shift everybody's position.
        dealtIn: false,
        dealtCards: [],
      };
      if (scratch.seatByName.has(player.name)) {
        throw new ParseSkip("duplicate-player", `"${player.name}" is seated twice.`);
      }
      scratch.seats.push(player);
      scratch.seatByName.set(player.name, player);
      continue;
    }
    const button = line.trim().match(/^Seat\s+(\d+)\s+is the button$/);
    if (button) {
      buttonSeat = Number(button[1]);
    }
  }
  if (scratch.seats.length === 0) {
    throw new ParseSkip("no-players", "The hand lists no seats.");
  }
  const names = sortedNames(scratch.seats);

  /* ------------------------------------------------------------- actions -- */

  for (let i = 1; i < summaryIndex; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    if (/^(?:Game started at:|Game ID:|Seat\s)/.test(line)) {
      continue;
    }
    const marker = line.match(/^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*\s*:?(.*)$/i);
    if (marker) {
      applyMarker(scratch, marker[1].toUpperCase(), marker[2]);
      continue;
    }
    const uncalled = line.match(/^Uncalled bet\s*\(([\d.,]+)\)\s*returned to\s*(.*)$/i);
    if (uncalled) {
      const player = uncalled[2].trim();
      if (!scratch.seatByName.has(player)) {
        // The source lost the name. Which seat gets the money back changes the
        // pot for two players, so there is nothing safe to assume.
        throw new ParseSkip(
          "unnamed-actor",
          `An uncalled bet of ${uncalled[1]} is returned to a player the export did not name.`,
        );
      }
      scratch.actions.push({
        street: scratch.street,
        player,
        kind: "uncalled",
        amount: parseAmount(uncalled[1], unit),
      });
      continue;
    }
    if (/^Game ended at:/.test(line)) {
      continue;
    }

    const acted = line.match(/^Player\s(.*)$/);
    if (!acted) {
      scratch.warnings.push({ code: "unknown-line", message: line, line: i + 1 });
      continue;
    }
    const rest = acted[1];
    const player = matchName(rest, names);
    if (player === null) {
      // `Player  folds` with no name at all is real; anything it does to the
      // pot is unattributable, so only the no-op lines can be dropped.
      const verb = rest.trim();
      if (LEGACY_NOISE_RE.test(verb) || /^(?:folds|checks)$/i.test(verb)) {
        continue;
      }
      throw new ParseSkip("unnamed-actor", `The export did not name the player in "${line}".`);
    }
    const verb = rest.slice(player.length).trim();
    const seat = scratch.seatByName.get(player)!;

    if (verb === "received a card.") {
      seat.dealtIn = true;
      dealtAnyCard = true;
      continue;
    }
    const upcard = verb.match(/^received card:\s*\[([^\]]*)\]$/i);
    if (upcard) {
      seat.dealtIn = true;
      seat.isHero = true;
      dealtAnyCard = true;
      seat.dealtCards = [...seat.dealtCards, ...cardsIn(upcard[1])];
      scratch.holeCards.set(player, seat.dealtCards);
      continue;
    }
    if (LEGACY_NOISE_RE.test(verb)) {
      continue;
    }

    const push = (kind: P5Action["kind"], amount?: Amount, dead?: Amount) => {
      seat.dealtIn = true;
      scratch.actions.push({ street: scratch.street, player, kind, amount, dead });
    };

    const blind = verb.match(/^has\s(small|big)\sblind\s*\(([\d.,]+)\)$/i);
    if (blind) {
      const amount = parseAmount(blind[2], unit);
      if (/^small$/i.test(blind[1])) {
        scratch.smallBlind = Math.max(scratch.smallBlind, amount);
        push("small-blind", amount);
      } else {
        scratch.bigBlind = Math.max(scratch.bigBlind, amount);
        push("big-blind", amount);
      }
      continue;
    }
    const dead = verb.match(/^posts\s*\(([\d.,]+)\)\s*as a dead bet$/i);
    if (dead) {
      // Dead money is in the pot but nobody has to match it; the live half of
      // the same post arrives on the following line as a plain `posts (N)`.
      push("post", 0, parseAmount(dead[1], unit));
      continue;
    }
    const simple = verb.match(
      /^(posts ante|ante|posts|straddle|bring in|calls|raises|bets|caps|allin)\s*\(([\d.,]+)\)$/i,
    );
    if (simple) {
      const amount = parseAmount(simple[2], unit);
      switch (simple[1].toLowerCase()) {
        case "posts ante":
        case "ante":
          push("ante", amount);
          break;
        case "posts":
        case "bring in":
          push("post", amount);
          break;
        case "straddle":
          push("straddle", amount);
          break;
        case "calls":
          push("call", amount);
          break;
        case "bets":
          push("bet", amount);
          break;
        // `raises (N)` and `caps (N)` state the chips pushed, not the street
        // total; see the file header for the hand that proves it.
        case "raises":
        case "caps":
          push("raise", amount);
          break;
        default:
          push("allin", amount);
          break;
      }
      continue;
    }
    if (/^allin$/i.test(verb)) {
      // No figure: the amount is whatever the seat had left, filled in later.
      push("allin", undefined);
      continue;
    }
    if (/^folds$/i.test(verb)) {
      push("fold");
      continue;
    }
    if (/^checks$/i.test(verb)) {
      push("check");
      continue;
    }
    scratch.warnings.push({ code: "unknown-line", message: line, line: i + 1 });
  }

  if (!dealtAnyCard) {
    throw new ParseSkip(
      "cancelled-hand",
      "No cards were dealt; the table cancelled the hand before the deal.",
    );
  }

  /* ------------------------------------------------------------- summary -- */

  // `Bets: 0.10. Collects: 2. Wins: 1.50.` - the amount ends before the
  // sentence period, so the fractional part has to be matched explicitly.
  const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
  let allBetsZero = true;
  for (let i = summaryIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || /^(?:Pot:|Board:|Game ended at:)/i.test(line)) {
      if (/^Board:/i.test(line)) {
        const summaryBoard = cardsIn(line);
        if (summaryBoard.length > 0 && scratch.flop === null) {
          scratch.flop = summaryBoard.slice(0, 3);
          scratch.turn = summaryBoard[3] ?? null;
          scratch.river = summaryBoard[4] ?? null;
        }
      }
      continue;
    }
    const entry = line.match(/^\*?Player\s(.*)$/);
    if (!entry) {
      scratch.warnings.push({ code: "unknown-summary-line", message: line, line: i + 1 });
      continue;
    }
    const player = matchName(entry[1], names);
    const tail = player === null ? entry[1] : entry[1].slice(player.length);
    const bets = tail.match(new RegExp(String.raw`Bets:\s*${NUM}`));
    const collects = tail.match(new RegExp(String.raw`Collects:\s*${NUM}`));
    if (player === null) {
      // A summary line for somebody who never sat down. Harmless while it moves
      // no money, and unreconstructable when it does.
      if (parseAmount(bets?.[1], unit) === 0 && parseAmount(collects?.[1], unit) === 0) {
        continue;
      }
      throw new ParseSkip("unseated-actor", `The summary reports money for an unseated player: "${line}".`);
    }
    if (bets) {
      const amount = parseAmount(bets[1], unit);
      scratch.statedContributions.set(player, amount);
      if (amount !== 0) {
        allBetsZero = false;
      }
    }
    if (collects && parseAmount(collects[1], unit) > 0) {
      scratch.collected.push({ player, amount: parseAmount(collects[1], unit) });
    }

    const cards = tail.match(/\[([^\]]*)\]/);
    const revealed = cards ? cardsIn(cards[1]) : [];
    if (revealed.length === 2 && !scratch.holeCards.has(player)) {
      scratch.holeCards.set(player, revealed);
    }
    const folded = scratch.actions.some(
      (action) => action.player === player && action.kind === "fold",
    );
    if (folded) {
      continue;
    }
    const known = scratch.holeCards.get(player) ?? [];
    if (/\bshows:/i.test(tail)) {
      scratch.actions.push({
        street: scratch.street,
        player,
        kind: "show",
        cards: known,
        description: tail.match(/shows:\s*(.*?)\s*(?:\[|\.?\s*Bets:)/i)?.[1] || undefined,
      });
    } else if (scratch.seatByName.get(player)?.dealtIn) {
      scratch.actions.push({ street: scratch.street, player, kind: "muck", cards: known });
    }
  }

  if (allBetsZero && scratch.statedContributions.size > 0) {
    // The data-mined export zeroes the whole column, so it cannot cross-check.
    scratch.statedContributions.clear();
  }

  resolveBareAllIns(scratch);

  const dealtIn = scratch.seats.filter((seat) => seat.dealtIn).length;
  if (dialect === "mined") {
    scratch.warnings.push({
      code: "numeric-player-ids",
      message:
        "Every seat is a numeric id rather than a screen name, and no seat is " +
        "marked as the hero; the names are not usable as player identities.",
    });
  }

  const draft: P5Draft = {
    siteId: "acrwpn",
    siteName: "ACR / Winning Poker Network",
    parserId: "acrwpn",
    parserVersion: VERSION,
    handId: header.handId,
    gameLabel: "Hold'em No Limit",
    unit,
    decimals: "fixed2",
    smallBlind: scratch.smallBlind,
    bigBlind: scratch.bigBlind,
    tableName: header.tableNumber
      ? `${header.tableName} ${header.tableNumber}`.trim()
      : header.tableName || null,
    maxSeats: header.maxSeats ?? ([2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn),
    buttonSeat,
    playedAt: header.playedAt,
    tournament: isTournament
      ? {
          // The legacy dialect never prints a tournament number - only the
          // table text, which names the format rather than the instance.
          id: "unknown",
          name: header.tableName.replace(/[()]/g, "").trim() || null,
          buyInToken: "$0",
          levelLabel: "1",
        }
      : null,
    seats: scratch.seats,
    actions: scratch.actions,
    flop: scratch.flop && scratch.flop.length === 3 ? scratch.flop : null,
    turn: scratch.turn,
    river: scratch.river,
    collected: scratch.collected,
    // The printed pot is net of every fee, so the contributions are the pot.
    statedPot: null,
    statedRake: scratch.statedRake,
    statedContributions: scratch.statedContributions.size > 0 ? scratch.statedContributions : null,
    holeCards: scratch.holeCards,
    rawText: raw.trim(),
    warnings: scratch.warnings,
  };

  const paid = scratch.collected.reduce((sum, entry) => sum + entry.amount, 0);
  if (scratch.statedPayout !== null && Math.abs(paid - scratch.statedPayout) > 1) {
    throw new ParseSkip(
      "payout-mismatch",
      `The summary reports a pot of ${scratch.statedPayout} but the per-player ` +
        `columns only account for ${paid} of it.`,
    );
  }

  return { draft, handKey: `WPN${header.handId}` };
}

/* ------------------------------------------------------------------ modern - */

function parseModern(raw: string, ctx: SiteParserContext): Parsed {
  const lines = raw.split(/\r?\n/);
  const head = lines[0].trim().match(MODERN_HEADER_RE);
  if (!head) {
    throw new ParseSkip("no-header", "The chunk has no readable `Hand #` header.");
  }
  const handId = head[1];
  const payload = head[2];
  const date = payload.match(MODERN_DATE_RE);
  const playedAt = date
    ? isoFrom(date[1], date[2], date[3], date[4], date[5], date[6])
    : null;

  const tour = payload.match(
    /^(?:(.*?)\s)?Tournament\s#(\S+)\s-\s(.+?)\(([^)]*)\)\s-\sLevel\s(\S+)\s*\(([^)]*)\)\s*-/,
  );
  const cash = payload.match(/^(.+?)\(([^)]*)\)\s-\s(\S+)\/(\S+)\s-/);
  if (!tour && !cash) {
    throw new ParseSkip("no-header", `Unreadable modern header payload "${payload}".`);
  }
  const gameName = (tour ? tour[3] : cash![1]).trim();
  if (!/^hold'?em$/i.test(gameName)) {
    throw new ParseSkip(
      "unsupported-variant",
      `Round one is Hold'em only; this hand is "${gameName}".`,
    );
  }
  if (ctx.options.cashOnly && tour) {
    throw new ParseSkip("tournament-in-cash-mode", "Tournament hand skipped.");
  }
  if (/^\*\*\*\s*RUN IT TWICE/im.test(raw)) {
    throw new ParseSkip("run-it-twice", "Run-it-twice hands are not supported yet.");
  }

  const limit = (tour ? tour[4] : cash![2]).trim();
  const unit = tour ? CHIPS : USD;
  const scratch = newScratch();
  if (tour) {
    const stakes = tour[6].split("/");
    scratch.smallBlind = parseAmount(stakes[0], unit);
    scratch.bigBlind = parseAmount(stakes[1] ?? stakes[0], unit);
  } else {
    scratch.smallBlind = parseAmount(cash![3], unit);
    scratch.bigBlind = parseAmount(cash![4], unit);
  }

  let tableName: string | null = null;
  let maxSeats: number | null = null;
  let buttonSeat: number | null = null;
  let inSummary = false;
  const summaryWins: P5Collect[] = [];

  // The table line is the only place the seat count and the button appear, and
  // cash tables print a bare location name where tournaments print `Table 'n'`.
  const table = lines[1]?.trim().match(/^(.*?)\s*(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?\s*$/);
  if (table) {
    tableName = table[1].replace(/^Table\s+'(.*)'$/, "$1").trim() || null;
    maxSeats = Number(table[2]);
    buttonSeat = table[3] ? Number(table[3]) : null;
  }

  for (let i = table ? 2 : 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    const seat = line.match(/^Seat\s+(\d+):\s+(.*?)\s+\(\$?([\d.,]+)\)(\s+is sitting out)?\s*$/);
    if (seat && !inSummary) {
      const player: P5Seat = {
        seat: Number(seat[1]),
        name: seat[2],
        startingStack: parseAmount(seat[3], unit),
        isHero: false,
        dealtIn: !seat[4],
        dealtCards: [],
      };
      if (scratch.seatByName.has(player.name)) {
        throw new ParseSkip("duplicate-player", `"${player.name}" is seated twice.`);
      }
      scratch.seats.push(player);
      scratch.seatByName.set(player.name, player);
      continue;
    }
    if (/^\*\*\*\s*SUMMARY/i.test(line)) {
      inSummary = true;
      continue;
    }
    // `Main pot $0.15 | Rake $0.00` after every street marker is a running
    // figure, not a final one, and only the SUMMARY block may be trusted.
    if (/^(?:Main|Side) pot\b/i.test(line) && !inSummary) {
      continue;
    }
    if (/^\*\*\*\s*HOLE CARDS/i.test(line)) {
      continue;
    }
    if (/^\*\*\*\s*SHOW\s?DOWN/i.test(line)) {
      continue;
    }
    const marker = line.match(/^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*(.*)$/i);
    if (marker && !inSummary) {
      applyMarker(scratch, marker[1].toUpperCase(), marker[2]);
      continue;
    }

    if (inSummary) {
      const pot = line.match(
        /^Total pot\s+\$?([\d.,]+)(?:\s*\|\s*Rake\s+\$?([\d.,]+))?(?:\s*\|\s*JP Fee\s+\$?([\d.,]+))?/i,
      );
      if (pot) {
        scratch.statedPayout = parseAmount(pot[1], unit);
        scratch.statedRake =
          pot[2] === undefined ? null : parseAmount(pot[2], unit) + parseAmount(pot[3], unit);
        continue;
      }
      if (/^Board\s*\[/i.test(line)) {
        continue;
      }
      const summarySeat = line.match(/^Seat\s+(\d+):\s+(.*)$/);
      if (summarySeat) {
        const player = matchName(summarySeat[2], sortedNames(scratch.seats));
        if (player === null) {
          scratch.warnings.push({ code: "unknown-summary-line", message: line, line: i + 1 });
          continue;
        }
        const tail = summarySeat[2].slice(player.length);
        const cards = tail.match(/\[([^\]]*)\]/);
        const revealed = cards ? cardsIn(cards[1]) : [];
        if (revealed.length === 2 && !scratch.holeCards.has(player)) {
          scratch.holeCards.set(player, revealed);
        }
        const won = tail.match(/\bwon\s+\$?([\d.,]+)/i);
        if (won) {
          summaryWins.push({ player, amount: parseAmount(won[1], unit) });
        }
        continue;
      }
      scratch.warnings.push({ code: "unknown-summary-line", message: line, line: i + 1 });
      continue;
    }

    const dealt = line.match(/^Dealt to\s+(.*?)\s+\[([^\]]*)\]\s*$/);
    if (dealt) {
      const seatEntry = scratch.seatByName.get(dealt[1].trim());
      if (seatEntry) {
        seatEntry.isHero = true;
        seatEntry.dealtIn = true;
        seatEntry.dealtCards = cardsIn(dealt[2]);
        scratch.holeCards.set(seatEntry.name, seatEntry.dealtCards);
      }
      continue;
    }
    const uncalled = line.match(/^Uncalled bet\s*\(\$?([\d.,]+)\)\s*returned to\s*(.*)$/i);
    if (uncalled) {
      const player = uncalled[2].trim();
      if (!scratch.seatByName.has(player)) {
        throw new ParseSkip("unnamed-actor", `An uncalled bet is returned to "${player}".`);
      }
      scratch.actions.push({
        street: scratch.street,
        player,
        kind: "uncalled",
        amount: parseAmount(uncalled[1], unit),
      });
      continue;
    }

    const names = sortedNames(scratch.seats);
    const player = matchName(line, names);
    if (player === null) {
      scratch.warnings.push({ code: "unknown-line", message: line, line: i + 1 });
      continue;
    }
    let verb = line.slice(player.length).trim();
    const allIn = /\sand is all-in$/i.test(verb);
    verb = verb.replace(/\sand is all-in$/i, "");
    const seatEntry = scratch.seatByName.get(player)!;
    const push = (kind: P5Action["kind"], amount?: Amount, extra?: Partial<P5Action>) => {
      seatEntry.dealtIn = true;
      scratch.actions.push({ street: scratch.street, player, kind, amount, allIn, ...extra });
    };

    const blind = verb.match(/^posts the (small|big) blind\s+\$?([\d.,]+)$/i);
    if (blind) {
      const amount = parseAmount(blind[2], unit);
      if (/^small$/i.test(blind[1])) {
        scratch.smallBlind = Math.max(scratch.smallBlind, amount);
        push("small-blind", amount);
      } else {
        scratch.bigBlind = Math.max(scratch.bigBlind, amount);
        push("big-blind", amount);
      }
      continue;
    }
    const ante = verb.match(/^posts ante\s+\$?([\d.,]+)$/i);
    if (ante) {
      push("ante", parseAmount(ante[1], unit));
      continue;
    }
    const deadPost = verb.match(/^posts dead\s+\$?([\d.,]+)$/i);
    if (deadPost) {
      push("post", 0, { dead: parseAmount(deadPost[1], unit) });
      continue;
    }
    const post = verb.match(/^posts\s+\$?([\d.,]+)$/i);
    if (post) {
      push("post", parseAmount(post[1], unit));
      continue;
    }
    const raise = verb.match(/^raises\s+\$?([\d.,]+)\s+to\s+\$?([\d.,]+)$/i);
    if (raise) {
      push("raise", parseAmount(raise[2], unit), { toTotal: true });
      continue;
    }
    const callBet = verb.match(/^(calls|bets|caps)\s+\$?([\d.,]+)$/i);
    if (callBet) {
      const amount = parseAmount(callBet[2], unit);
      const kind = /^calls$/i.test(callBet[1]) ? "call" : /^bets$/i.test(callBet[1]) ? "bet" : "raise";
      push(kind, amount);
      continue;
    }
    if (/^folds$/i.test(verb)) {
      push("fold");
      continue;
    }
    if (/^checks$/i.test(verb)) {
      push("check");
      continue;
    }
    const collect = verb.match(/^collected\s+\$?([\d.,]+)\s+from\s+(.*)$/i);
    if (collect) {
      scratch.collected.push({
        player,
        amount: parseAmount(collect[1], unit),
        potName: collect[2].trim().replace(/\s+\d+$/, ""),
      });
      continue;
    }
    const shows = verb.match(/^shows\s*\[([^\]]*)\](?:\s*\((.*)\))?$/i);
    if (shows) {
      const cards = cardsIn(shows[1]);
      if (cards.length > 0) {
        scratch.holeCards.set(player, cards);
        seatEntry.dealtIn = true;
      }
      scratch.actions.push({
        street: scratch.street,
        player,
        kind: "show",
        cards,
        // The description carries its own best-five bracket; keep the words.
        description: shows[2]?.replace(/\s*\[[^\]]*\]\s*$/, "") || undefined,
      });
      continue;
    }
    if (/^(?:does not show|doesn't show|mucks hand|mucks)$/i.test(verb)) {
      scratch.actions.push({
        street: scratch.street,
        player,
        kind: "muck",
        cards: scratch.holeCards.get(player) ?? [],
      });
      continue;
    }
    if (/^(?:is sitting out|sits out|has timed out|is disconnected|is connected|said,)/i.test(verb)) {
      continue;
    }
    scratch.warnings.push({ code: "unknown-line", message: line, line: i + 1 });
  }

  if (scratch.seats.length === 0) {
    throw new ParseSkip("no-players", "The hand lists no seats.");
  }
  // Four of the six modern hold'em hands in the corpus never print a
  // `collected` line; the SUMMARY block is the only place the winner appears.
  if (scratch.collected.length === 0) {
    scratch.collected.push(...summaryWins);
  }
  resolveBareAllIns(scratch);

  const dealtIn = scratch.seats.filter((seat) => seat.dealtIn).length;
  const draft: P5Draft = {
    siteId: "acrwpn",
    siteName: "ACR / Winning Poker Network",
    parserId: "acrwpn",
    parserVersion: VERSION,
    handId,
    gameLabel: `Hold'em ${/pot\s*limit/i.test(limit) ? "Pot Limit" : /fixed\s*limit/i.test(limit) ? "Fixed Limit" : "No Limit"}`,
    unit,
    decimals: "fixed2",
    smallBlind: scratch.smallBlind,
    bigBlind: scratch.bigBlind,
    tableName,
    maxSeats: maxSeats ?? ([2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn),
    buttonSeat,
    playedAt,
    tournament: tour
      ? {
          id: tour[2],
          name: (tour[1] ?? "").replace(/[()]/g, "").trim() || null,
          buyInToken: "$0",
          levelLabel: tour[5],
        }
      : null,
    seats: scratch.seats,
    actions: scratch.actions,
    flop: scratch.flop && scratch.flop.length === 3 ? scratch.flop : null,
    turn: scratch.turn,
    river: scratch.river,
    collected: scratch.collected,
    statedPot: null,
    statedRake: scratch.statedRake,
    statedContributions: null,
    holeCards: scratch.holeCards,
    rawText: raw.trim(),
    warnings: scratch.warnings,
  };

  const paid = scratch.collected.reduce((sum, entry) => sum + entry.amount, 0);
  if (scratch.statedPayout !== null && Math.abs(paid - scratch.statedPayout) > 1) {
    throw new ParseSkip(
      "payout-mismatch",
      `The summary reports a pot of ${scratch.statedPayout} but only ${paid} is ` +
        "accounted for.",
    );
  }

  return { draft, handKey: `WPN${handId}` };
}

/* ------------------------------------------------------------------ parser - */

export const acrwpnParser: SiteParser = {
  id: "acrwpn",
  name: "ACR / Winning Poker Network",
  version: VERSION,

  detect(text: string): number {
    const body = p5RecoverEncoding(text);
    // Legacy: two literals no other room in the corpus prints, on two lines.
    if (LEGACY_HEADER_RE.test(firstMatchingLine(body, /^Game started at:/m) ?? "")) {
      if (/^Game ID:\s*\S+\s+\S+\/\S+/m.test(body)) {
        return 0.95;
      }
      return 0.3;
    }
    // Modern: a bare `Hand #` / `Game Hand #` header, anchored to the start of
    // a line so that `<Room> Hand #...` cannot match, and closing with the UTC
    // stamp this dialect always prints.
    if (/^(?:Game\s)?Hand\s#\d+\s-\s.*\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*UTC\s*$/m.test(body)) {
      return 0.95;
    }
    // The per-street running pot line exists nowhere else, but on its own it is
    // only an excerpt of a hand rather than a hand.
    if (/^(?:Main|Side) pot\s+\S+\s*\|\s*Rake\s/m.test(body)) {
      return 0.4;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return p5RecoverEncoding(text)
      .split(SPLIT_RE)
      .map((chunk) => chunk.trim())
      .filter((chunk) => wpnDialect(chunk) !== null);
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const text = p5RecoverEncoding(raw).trim();
    const dialect = wpnDialect(text);
    if (dialect === null) {
      throw new ParseSkip("no-header", "The chunk matches no WPN header shape.");
    }
    const parsed =
      dialect === "modern" ? parseModern(text, ctx) : parseLegacy(text, ctx, dialect);
    return p5BuildHand(parsed.draft, ctx, parsed.handKey);
  },
};

function firstMatchingLine(text: string, pattern: RegExp): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (pattern.test(line)) {
      return line.trim();
    }
  }
  return null;
}
