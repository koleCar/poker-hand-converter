/**
 * iPoker network parser (Betfair, Titan, Paddy Power, Betclic, Red Star,
 * NetBet and the rest of the skins, which all export the same XML).
 *
 * This is the only room here that does not ship text. A file is one or more
 * `<session>` documents, each holding a shared `<general>` block and any number
 * of `<game>` elements:
 *
 * ```xml
 * <round no="1">
 *   <cards type="Pocket" player="Amalfitano1">CJ SJ</cards>
 *   <action no="5" player="Amalfitano1" type="23" sum="€0.40" />
 * </round>
 * ```
 *
 * The things that bite:
 *
 * - **`no` is the running order, document order is not.** Actions inside a
 *   round are grouped by player, so reading them top to bottom gives a hand in
 *   which the same player acts twice in a row.
 * - **Action types are numbers, and they do not agree on what `sum` means.**
 *   Calls, bets and all-ins state the chips added; the raise code states the
 *   street total. The mapping below was derived from this repository's fixture
 *   corpus by arithmetic - every code was checked against the `bet` and `win`
 *   attributes, which state each player's totals independently - and an
 *   unrecognised code that moves chips refuses the hand rather than guessing.
 * - **Cards are suit first**: `D5`, `H10`, `SA`, and lower case `c10` in
 *   data-mined files. `X` means the card was not shown.
 * - **Nothing states the seat count, the hero, the pot, the rake or an uncalled
 *   bet.** The last three are reconstructed in `shared/p2-handbuilder.ts`.
 * - **`bet` includes chips that were never matched.** iPoker leaves an uncalled
 *   bet in the pot and hands it straight back inside `win`, so `win` has to
 *   have the return taken out of it before a rake can be derived.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  parseAmount,
  unitForSymbol,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import { EUR, GBP, USD } from "../phf/types";
import {
  buildHand,
  type DraftAction,
  type DraftSeat,
  type DraftStreet,
  type HandDraft,
} from "./shared/p2-handbuilder";
import { child, childText, children, parseXml, type XmlElement } from "./shared/p2-xml";

const VERSION = "1.0.0";

/**
 * iPoker action codes.
 *
 * Confirmed against the fixture corpus by reconciling every action with the
 * per-player `bet` totals; see the file header. `sum` is an increment except
 * for `23`, which is a street total.
 */
const ACTION_TYPES: Record<string, DraftAction["kind"]> = {
  "0": "fold",
  "1": "small-blind",
  "2": "big-blind",
  "3": "call",
  "4": "check",
  "5": "bet",
  "7": "allin",
  "15": "ante",
  "23": "raise",
};

/** `round no` to street. 0 is the blind round, 1 the deal. */
const ROUND_STREETS: Record<string, DraftStreet> = {
  "0": "preflop",
  "1": "preflop",
  "2": "flop",
  "3": "turn",
  "4": "river",
};

export const ipokerParser: SiteParser = {
  id: "ipoker",
  name: "iPoker Network",
  version: VERSION,

  detect(text: string): number {
    if (!/<session\b/i.test(text) || !/<gametype>/i.test(text)) {
      return 0;
    }
    // The `<round no=...><action ... type="N" sum="..."/>` shape is what makes
    // it a hand history rather than some other `<session>` document.
    if (/<round\b[^>]*no=/i.test(text) && /<action\b[^>]*\btype=/i.test(text)) {
      return 0.95;
    }
    return 0.4;
  },

  splitHands(text: string): string[] {
    const out: string[] = [];
    for (const session of text.split(/(?=<session\b)/i)) {
      if (!/<session\b/i.test(session)) {
        continue;
      }
      const code = session.match(/<session\b[^>]*sessioncode="([^"]*)"/i)?.[1] ?? "0";
      // The session `<general>` is the first one, before any `<game>`; the
      // `<general>` blocks inside a game are the per-hand ones.
      const head = session.split(/<game\b/i)[0];
      const general = head.match(/<general>[\s\S]*?<\/general>/i)?.[0] ?? "<general></general>";
      for (const game of session.match(/<game\b[\s\S]*?<\/game>/gi) ?? []) {
        // Each hand is re-emitted as a session of its own so that a chunk is
        // self-contained: the pipeline re-detects and parses chunks in
        // isolation, and the stakes only exist in the session header.
        out.push(`<session sessioncode="${code}">\n${general}\n${game}\n</session>`);
      }
    }
    return out;
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const root = parseXml(raw);
    if (!root || root.tag.toLowerCase() !== "session") {
      throw new ParseSkip("malformed-xml", "The chunk is not a well-formed iPoker session.");
    }
    const sessionGeneral = child(root, "general");
    const game = child(root, "game");
    if (!game) {
      throw new ParseSkip("no-hands", "The session contains no <game> element.");
    }
    const handId = game.attrs.gamecode || "";
    if (!handId) {
      throw new ParseSkip("no-header", "The <game> element has no gamecode.");
    }

    const gameType = childText(sessionGeneral, "gametype");
    const parsedType = gameType.match(/^(\S+)\s+(NL|PL|FL|L)\s+(.*)$/i);
    if (!parsedType) {
      throw new ParseSkip("no-header", `Unreadable <gametype> "${gameType}".`);
    }
    if (!/^hold\s*'?em$/i.test(parsedType[1])) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${gameType}".`,
      );
    }

    const gameGeneral = child(game, "general");
    const playerNodes = children(child(gameGeneral, "players"), "player");
    if (playerNodes.length === 0) {
      throw new ParseSkip("no-players", "The <players> block is empty.");
    }

    const unit = unitOf(playerNodes, childText(sessionGeneral, "tablecurrency"));
    const warnings: PhfWarning[] = [];

    const seats: DraftSeat[] = [];
    const stacks = new Map<string, Amount>();
    const collected: HandDraft["collected"] = [];
    let buttonSeat: number | null = null;
    for (const node of playerNodes) {
      const name = node.attrs.name ?? "";
      const seat = Number(node.attrs.seat ?? 0);
      if (!name || !seat) {
        throw new ParseSkip("no-players", "A <player> element has no name or no seat.");
      }
      const stack = parseAmount(node.attrs.chips, unit);
      seats.push({ seat, name, startingStack: stack, dealtIn: false, isHero: false, dealtCards: [] });
      stacks.set(name, stack);
      if (node.attrs.dealer === "1") {
        buttonSeat = seat;
      }
      const win = parseAmount(node.attrs.win, unit);
      if (win > 0) {
        collected.push({ player: name, amount: win });
      }
    }
    const seatByName = new Map(seats.map((seat) => [seat.name, seat]));

    /* ------------------------------------------------------- rounds -------- */

    const pocket = new Map<string, string[]>();
    const dealt = new Set<string>();
    const folded = new Set<string>();
    const ordered: Array<{ order: number; street: DraftStreet; node: XmlElement }> = [];
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let lastStreet: DraftStreet = "preflop";

    for (const round of children(game, "round")) {
      const street = ROUND_STREETS[round.attrs.no ?? ""];
      if (!street) {
        throw new ParseSkip("unknown-round", `Unknown <round no="${round.attrs.no}">.`);
      }
      for (const card of children(round, "cards")) {
        const kind = (card.attrs.type ?? "").toLowerCase();
        const cards = card.text.split(/\s+/).filter(Boolean).map(ipokerCard);
        if (kind === "pocket") {
          const owner = card.attrs.player ?? "";
          dealt.add(owner);
          const known = cards.filter((entry): entry is string => entry !== null);
          if (known.length > 0) {
            pocket.set(owner, known);
          }
          continue;
        }
        const known = cards.filter((entry): entry is string => entry !== null);
        if (kind === "flop") {
          flop = known;
          lastStreet = "flop";
        } else if (kind === "turn") {
          turn = known[0] ?? null;
          lastStreet = "turn";
        } else if (kind === "river") {
          river = known[0] ?? null;
          lastStreet = "river";
        } else {
          warnings.push({ code: "unknown-line", message: `<cards type="${card.attrs.type}">` });
        }
      }
      for (const action of children(round, "action")) {
        ordered.push({ order: Number(action.attrs.no ?? 0), street, node: action });
      }
    }
    ordered.sort((a, b) => a.order - b.order);

    const actions: DraftAction[] = [];
    const streetCommit = new Map<string, Amount>();
    const handCommit = new Map<string, Amount>();
    for (const entry of ordered) {
      const player = entry.node.attrs.player ?? "";
      const code = entry.node.attrs.type ?? "";
      const sum = parseAmount(entry.node.attrs.sum, unit);
      if (!seatByName.has(player)) {
        // iPoker occasionally emits an action for a seat it never listed; the
        // hand cannot be reconstructed from it, and inventing the seat would
        // change the position ring for everybody else.
        throw new ParseSkip("unseated-actor", `"${player}" acts but is not in <players>.`);
      }
      const kind = ACTION_TYPES[code];
      if (!kind) {
        if (sum !== 0) {
          throw new ParseSkip(
            "unknown-action-type",
            `Action type "${code}" moves ${sum} and is not in the code table.`,
          );
        }
        // A zero-sum code cannot change any pot maths. Type 8 shows up this way
        // for a seat that was never dealt in, so it is dropped rather than
        // guessed at - deliberately, and without marking the seat as playing.
        continue;
      }

      dealt.add(player);
      if (kind === "fold") {
        folded.add(player);
        actions.push({ street: entry.street, player, kind });
        continue;
      }
      if (kind === "check") {
        actions.push({ street: entry.street, player, kind });
        continue;
      }

      // `23` states the street total, every other code an increment. Both are
      // tracked here only to work out which action put a player all in.
      const toTotal = code === "23";
      const key = `${entry.street} ${player}`;
      const previousStreet = streetCommit.get(key) ?? 0;
      const added = toTotal ? Math.max(0, sum - previousStreet) : sum;
      streetCommit.set(key, previousStreet + added);
      const total = (handCommit.get(player) ?? 0) + added;
      handCommit.set(player, total);
      actions.push({
        street: entry.street,
        player,
        kind,
        amount: sum,
        toTotal,
        allIn: total >= (stacks.get(player) ?? Number.POSITIVE_INFINITY),
      });
    }

    /* ------------------------------------------------------ showdown ------- */

    for (const [player, cards] of pocket) {
      if (!seatByName.has(player)) {
        continue;
      }
      if (folded.has(player)) {
        // A revealed hand that folded is a muck: the cards are real, but the
        // seat never reached a showdown.
        actions.push({ street: lastStreet, player, kind: "muck", cards });
        continue;
      }
      actions.push({ street: lastStreet, player, kind: "show", cards });
    }

    const nickname = childText(sessionGeneral, "nickname");
    const hero = resolveHero(nickname, pocket, seatByName);
    for (const seat of seats) {
      seat.dealtIn = dealt.has(seat.name);
      if (seat.name === hero) {
        seat.isHero = true;
        seat.dealtCards = pocket.get(seat.name) ?? [];
        seat.dealtIn = true;
      }
    }
    for (const entry of collected) {
      const seat = seatByName.get(entry.player);
      if (seat) {
        seat.dealtIn = true;
      }
    }

    const tableName = childText(sessionGeneral, "tablename");
    const stakes = parsedType[3].split("/");
    const draft: HandDraft = {
      siteId: "ipoker",
      siteName: "iPoker Network",
      parserId: "ipoker",
      parserVersion: VERSION,
      handPrefix: "IPN-",
      handId,
      gameLabel: canonicalLabel(parsedType[2]),
      unit,
      decimals: "fixed2",
      // On a fixed-limit table `<gametype>Holdem L $5/$10</gametype>` states the
      // small and big *bet*, not the blinds, so these are only a fallback for
      // what was posted.
      headerSmallBlind: parseAmount(stakes[0], unit),
      headerBigBlind: parseAmount(stakes[1] ?? stakes[0], unit),
      tableName: tableName.replace(/,\s*\d+\s*$/, "") || null,
      maxSeats: maxSeatsFor(tableName, seats),
      buttonSeat,
      playedAt: isoFromIpokerDate(childText(gameGeneral, "startdate")),
      seats,
      actions,
      flop,
      turn,
      river,
      collected,
      // iPoker never returns an uncalled bet; it comes back inside `win`.
      collectedIncludesUncalled: true,
      rawText: raw.trim(),
      warnings,
    };

    if (flop && flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The flop lists ${flop.length} readable cards, so the hand is corrupt.`,
      );
    }

    return buildHand(draft, ctx);
  },
};

/**
 * The hero, when the export says who it is.
 *
 * `<nickname>` carries it in a personal export and is `N/A` in every data-mined
 * file. The fallback is a hand where exactly one seat's cards are known: a
 * showdown reveals at least two, so a single revealed hand can only be the
 * owner of the export.
 */
function resolveHero(
  nickname: string,
  pocket: Map<string, string[]>,
  seats: Map<string, DraftSeat>,
): string | null {
  if (nickname && nickname !== "N/A" && seats.has(nickname)) {
    return nickname;
  }
  const known = [...pocket.keys()].filter((name) => seats.has(name));
  return known.length === 1 ? known[0] : null;
}

/** `D5` -> `5d`, `H10` -> `Th`, `c10` -> `Tc`. `X` means "not shown". */
function ipokerCard(token: string): string | null {
  const match = token.trim().match(/^([shdcSHDC])(10|[2-9tjqkaTJQKA])$/);
  if (!match) {
    return null;
  }
  const rank = match[2].toUpperCase();
  return `${rank === "10" ? "T" : rank}${match[1].toLowerCase()}`;
}

/**
 * The unit the amounts are in.
 *
 * The symbol on the amounts wins over `<tablecurrency>`, which disagrees with
 * it in real files: one fixture has `<tablecurrency>GBP</tablecurrency>`,
 * `<currency>EUR</currency>` and `£` on every number.
 */
function unitOf(players: XmlElement[], tableCurrency: string): CurrencyUnit {
  for (const player of players) {
    const symbol = (player.attrs.chips ?? "").match(/[$€£]/)?.[0];
    if (symbol) {
      return unitForSymbol(symbol);
    }
  }
  switch (tableCurrency.toUpperCase()) {
    case "EUR":
      return EUR;
    case "GBP":
      return GBP;
    default:
      return USD;
  }
}

/** `2014-01-06 14:44:37` -> ISO. iPoker stamps server time with no zone. */
function isoFromIpokerDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const stamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}

function canonicalLabel(limit: string): string {
  if (/^PL$/i.test(limit)) {
    return "Hold'em Pot Limit";
  }
  if (/^(?:FL|L)$/i.test(limit)) {
    return "Hold'em Limit";
  }
  return "Hold'em No Limit";
}

/**
 * Seat count, which iPoker never states.
 *
 * The table name carries a heads-up marker on the tables where it matters; for
 * the rest the seat numbers are physical positions on the felt, so the next
 * real table size above the highest one is the closest honest answer.
 */
function maxSeatsFor(tableName: string, seats: DraftSeat[]): number {
  if (/heads\s*-?\s*up/i.test(tableName)) {
    return 2;
  }
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [6, 9, 10].find((size) => size >= highest) ?? highest;
}
