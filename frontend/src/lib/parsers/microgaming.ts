/**
 * MicroGaming Poker Network (MPN) parser - the network behind Betsafe, Ladbrokes,
 * Unibet's pre-2019 rooms and dozens of other skins, shut down in 2016.
 *
 * One `<Game>` element per hand, everything in attributes:
 *
 * ```xml
 * <Game hhversion="4" id="5049092037" date="2013-09-23 14:27:55"
 *       tablename="Turbo: Micro NLHE 22 - €2 Max" stakes="0.01|0.02" betlimit="NL"
 *       gametype="Hold&apos;em" currencysymbol="rCA=" tablesize="6" rake="0">
 *   <Seats>
 *     <Seat num="1" alias="DuckGhoul" unicodealias="RAB1AGMAawBHAGgAbwB1AGwA"
 *           balance="2.00" dealer="true"/>
 *   </Seats>
 *   <Gameplay>
 *     <Action seq="1" type="SmallBlind" seat="3" value="0.01"/>
 *     <Action seq="10" type="DealFlop"><Card value="9" suit="c" id="21"/>…</Action>
 *     <Action type="Win"><Seat num="5" amount="0.16" lowhandwin="0"/></Action>
 *   </Gameplay>
 * </Game>
 * ```
 *
 * What is worth knowing:
 *
 * - **Every `value` is an increment**, `Raise` included. In the 3-bet fixture the
 *   small blind's `Raise value="0.06"` takes him to `0.07`, not to `0.06`; read
 *   as a total, the reported winnings exceed everything that was put in, which is
 *   how the two readings were told apart.
 * - **Names carry their own lossless encoding.** `unicodealias` is Base64 of the
 *   UTF-16LE name, so it survives whatever the file's byte encoding did to the
 *   plain `alias`. It is preferred wherever it is present - the same trick
 *   recovers the currency symbol from `currencysymbol`, which is the only place
 *   the file states one.
 * - **`MoneyReturned` is the uncalled bet**, stated outright. It is read for
 *   cross-checking only: `shared/p2-handbuilder.ts` derives the return from the
 *   betting state, and emitting the line as well would hand the money back twice.
 * - **`BadBeatContribution` is not pot money.** It is a jackpot drop taken from
 *   the player's stack straight to the jackpot fund, and it never appears in the
 *   `Win` amount - the badbeat fixture balances exactly without it. It is
 *   therefore *not* a `PhfFees` entry, which is a deduction from the pot; it is a
 *   `PhfChipMovement` with `toPot: false`, the same shape Run It Once's Splash
 *   the Pot uses from the other end. Chip conservation ignores it and the
 *   replayer takes it off the contributor's starting stack, which is what keeps
 *   that stack from reading a cent or two high all hand.
 * - **`Disconnect` carries a `value` that is milliseconds, not money** (`30000`).
 *   Reading it as chips would add £300 to a hand.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  parseAmount,
  unitForSymbol,
  type Amount,
  type CurrencyUnit,
  type PhfChipMovement,
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
import { child, children, parseXml, type XmlElement } from "./shared/p2-xml";
import { decodeBase64Utf16, strictAmount } from "./shared/p4-textroom";

const VERSION = "1.0.0";

/** `<Action type>` values that move chips into the pot, and what they mean. */
const WAGERS: Record<string, DraftAction["kind"]> = {
  SmallBlind: "small-blind",
  BigBlind: "big-blind",
  Ante: "ante",
  Call: "call",
  Bet: "bet",
  Raise: "raise",
  AllIn: "allin",
};

const STREETS: Record<string, DraftStreet> = {
  DealFlop: "flop",
  DealTurn: "turn",
  DealRiver: "river",
};

export const microgamingParser: SiteParser = {
  id: "microgaming",
  name: "MicroGaming Network",
  version: VERSION,

  detect(text: string): number {
    // `<Game hhversion="N" id="N"` is written by nothing else in scope; the
    // other XML rooms here open `<HISTORY`, `<session` or `<description`.
    if (/<Game\s+hhversion="\d+"\s+id="\d+"/i.test(text)) {
      return 0.95;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .split(/(?=<Game\s+hhversion=)/i)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => /^<Game\s+hhversion=/i.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const source = raw.replace(/^﻿/, "").trim();
    const game = parseXml(source);
    if (!game || game.tag.toLowerCase() !== "game") {
      throw new ParseSkip("malformed-xml", "The chunk is not a well-formed <Game> element.");
    }

    const handId = game.attrs.id ?? "";
    if (!handId) {
      throw new ParseSkip("no-header", "The <Game> element has no id.");
    }
    const gameType = game.attrs.gametype ?? "";
    if (!/^hold\s*'?\s*em$/i.test(gameType.trim())) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${gameType}".`,
      );
    }
    if (game.attrs.istournament === "1") {
      throw new ParseSkip(
        "tournament-unsupported",
        "MicroGaming tournament hands are not covered yet; the buy-in is not stated " +
          "in the hand, so a tournament could only be recorded with an invented one.",
      );
    }
    if (game.attrs.realmoney === "false") {
      throw new ParseSkip("play-money", "The table is play money, not real money.");
    }

    const warnings: PhfWarning[] = [];
    // The symbol lives only in `currencysymbol`, Base64 of a UTF-16LE string.
    const symbol = decodeBase64Utf16(game.attrs.currencysymbol ?? "");
    if (!symbol) {
      warnings.push({
        code: "unknown-currency",
        message: "The hand states no decodable currency symbol; amounts are read as USD.",
      });
    }
    const unit: CurrencyUnit = symbol ? unitForSymbol(symbol) : unitForSymbol("$");

    const stakes = (game.attrs.stakes ?? "").split("|");

    /* -------------------------------------------------------------- seats -- */

    const seatNodes = children(child(game, "Seats"), "Seat");
    if (seatNodes.length === 0) {
      throw new ParseSkip("no-players", "The <Seats> block is empty.");
    }
    const seats: DraftSeat[] = [];
    const bySeat = new Map<number, DraftSeat>();
    let buttonSeat: number | null = null;
    for (const node of seatNodes) {
      const num = Number(node.attrs.num ?? 0);
      const name = decodeBase64Utf16(node.attrs.unicodealias ?? "") || (node.attrs.alias ?? "");
      if (!num || !name) {
        throw new ParseSkip("no-players", "A <Seat> element has no number or no alias.");
      }
      const seat: DraftSeat = {
        seat: num,
        name,
        startingStack: strictAmount(node.attrs.balance ?? "", unit, "a <Seat> balance"),
        // A seat that was sitting out was not dealt in; anybody else is
        // confirmed below by having acted.
        dealtIn: false,
        isHero: false,
        dealtCards: [],
      };
      seats.push(seat);
      bySeat.set(num, seat);
      if (node.attrs.dealer === "true") {
        buttonSeat = num;
      }
    }

    /* ------------------------------------------------------------ actions -- */

    const actions: DraftAction[] = [];
    const collected: HandDraft["collected"] = [];
    let street: DraftStreet = "preflop";
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let statedReturn: { player: string; amount: Amount } | null = null;
    const chipMovements: PhfChipMovement[] = [];

    const gameplay = child(game, "Gameplay");
    for (const node of children(gameplay, "Action")) {
      const type = node.attrs.type ?? "";

      if (type === "Win") {
        for (const winner of children(node, "Seat")) {
          const seat = bySeat.get(Number(winner.attrs.num ?? 0));
          if (!seat) {
            throw new ParseSkip(
              "unseated-actor",
              `A <Win> names seat ${winner.attrs.num}, which is not in <Seats>.`,
            );
          }
          seat.dealtIn = true;
          collected.push({
            player: seat.name,
            amount: strictAmount(winner.attrs.amount ?? "", unit, "a <Win> amount"),
          });
        }
        continue;
      }

      const dealStreet = STREETS[type];
      if (dealStreet) {
        const cards = children(node, "Card").map(cardOf);
        street = dealStreet;
        if (dealStreet === "flop") {
          flop = cards;
        } else if (dealStreet === "turn") {
          turn = cards[0] ?? null;
        } else {
          river = cards[0] ?? null;
        }
        continue;
      }

      const seat = bySeat.get(Number(node.attrs.seat ?? 0));
      if (!seat) {
        if (type === "BadBeatContribution" || type === "Disconnect") {
          continue;
        }
        throw new ParseSkip(
          "unseated-actor",
          `Action ${node.attrs.seq ?? "?"} (${type}) names seat ${node.attrs.seat}, ` +
            "which is not in <Seats>.",
        );
      }
      seat.dealtIn = true;

      const wager = WAGERS[type];
      if (wager) {
        actions.push({
          street,
          player: seat.name,
          kind: wager,
          amount: parseAmount(node.attrs.value, unit),
          allIn: type === "AllIn",
        });
        continue;
      }
      if (type === "Fold") {
        actions.push({ street, player: seat.name, kind: "fold" });
        continue;
      }
      if (type === "Check") {
        actions.push({ street, player: seat.name, kind: "check" });
        continue;
      }
      if (type === "ShowCards" || type === "MuckCards") {
        actions.push({
          street,
          player: seat.name,
          kind: type === "ShowCards" ? "show" : "muck",
          cards: children(node, "Card").map(cardOf),
        });
        continue;
      }
      if (type === "MoneyReturned") {
        // Read for the cross-check only; the builder derives the return itself.
        statedReturn = {
          player: seat.name,
          amount: strictAmount(node.attrs.value ?? "", unit, "a MoneyReturned value"),
        };
        continue;
      }
      if (type === "BadBeatContribution") {
        // A jackpot drop: it leaves the stack without ever entering the pot, so
        // it is a chip movement rather than a contribution or a fee.
        chipMovements.push({
          kind: "bad-beat-drop",
          fromSeat: seat.seat,
          fromPlayer: seat.name,
          toPot: false,
          amount: parseAmount(node.attrs.value, unit),
          // `raw` is emitted verbatim by `toStandardText`, so it has to be a
          // line the standard grammar can read back. This room's source "line"
          // is an XML fragment, and the grammar has no form for a seat-to-house
          // movement anyway, so it is left null: the drop lives in the PHF
          // object, which is what the replayer and the database read, and the
          // XML is still in `meta.rawText`.
          raw: null,
          // MicroGaming drops it before the blinds are posted.
          anchor: "before-postings",
        });
        continue;
      }
      if (type === "Disconnect") {
        // `value` is a timeout in milliseconds, not chips.
        continue;
      }

      warnings.push({ code: "unknown-line", message: `<Action type="${type}">` });
    }

    if (collected.length === 0) {
      throw new ParseSkip(
        "no-winner",
        'No <Action type="Win"> element, so the source never says who was given the pot.',
      );
    }
    if (flop && flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The DealFlop action lists ${flop.length} readable cards, so the hand is corrupt.`,
      );
    }

    const draft: HandDraft = {
      siteId: "microgaming",
      siteName: "MicroGaming Network",
      parserId: "microgaming",
      parserVersion: VERSION,
      handPrefix: "MG-",
      handId,
      gameLabel: canonicalLabel(game.attrs.betlimit ?? "NL"),
      unit,
      decimals: "fixed2",
      headerSmallBlind: strictAmount(stakes[0] ?? "", unit, "the header stakes"),
      headerBigBlind: strictAmount(stakes[1] ?? stakes[0] ?? "", unit, "the header stakes"),
      tableName:
        decodeBase64Utf16(game.attrs.unicodetablename ?? "") || (game.attrs.tablename ?? null),
      maxSeats: Number(game.attrs.tablesize ?? 0) || fallbackMaxSeats(seats),
      buttonSeat,
      playedAt: isoFromMicrogamingDate(game.attrs.date ?? ""),
      seats,
      actions,
      flop,
      turn,
      river,
      collected,
      // MicroGaming only prints `MoneyReturned` when the return follows an
      // all-in. When it does, the money is already out of the winner's `Win`
      // amount; when a bet is simply folded to, the room leaves the money in the
      // pot and hands it back inside `Win`. Getting this backwards moves the
      // whole uncalled bet into the rake - fixture 05 is the one that shows it,
      // because there the returnee and the winner are different players.
      collectedIncludesUncalled: statedReturn === null,
      rawText: source,
      warnings,
    };

    const hand = buildHand(draft, ctx);
    if (chipMovements.length > 0) {
      // Attached after the build because the drop never touches the pot, so it
      // has no place in the normalized standard text the builder works through.
      hand.chipMovements = [...(hand.chipMovements ?? []), ...chipMovements];
    }
    crossCheck(hand, statedReturn);
    return hand;
  },
};

/**
 * Checks the derived uncalled return against the `MoneyReturned` the room states.
 *
 * Only a *disagreement* is worth a warning. A derived return with no
 * `MoneyReturned` action is the normal case for a bet that was folded to, which
 * MicroGaming does not report at all, so it is not flagged.
 */
function crossCheck(hand: PhfHand, statedReturn: { player: string; amount: Amount } | null): void {
  const warn = (code: string, message: string) => hand.meta.warnings.push({ code, message });
  const derived = hand.actions.find((action) => action.type === "uncalled");
  if (statedReturn && !derived) {
    warn(
      "uncalled-mismatch",
      `The hand returns ${statedReturn.amount} to ${statedReturn.player} but the betting ` +
        "stream leaves nothing uncalled.",
    );
  } else if (statedReturn && derived) {
    if (
      derived.player !== statedReturn.player ||
      Math.abs(-derived.amount - statedReturn.amount) > 1
    ) {
      warn(
        "uncalled-mismatch",
        `The hand returns ${statedReturn.amount} to ${statedReturn.player}; the stream ` +
          `returns ${-derived.amount} to ${derived.player}.`,
      );
    }
  }
}

/** `<Card value="10" suit="c"/>` -> `Tc`. */
function cardOf(node: XmlElement): string {
  const value = (node.attrs.value ?? "").toUpperCase();
  const suit = (node.attrs.suit ?? "").toLowerCase();
  return `${value === "10" ? "T" : value}${suit}`;
}

/** `2013-09-23 14:27:55` -> ISO. MicroGaming stamps server time with no zone. */
function isoFromMicrogamingDate(value: string): string | null {
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

/** MicroGaming writes `NL`; trackers expect the GG wording. */
function canonicalLabel(limit: string): string {
  if (/^PL$/i.test(limit)) {
    return "Hold'em Pot Limit";
  }
  return /^(?:FL|L)$/i.test(limit) ? "Hold'em Limit" : "Hold'em No Limit";
}

/** `tablesize` is authoritative when present; this is the fallback. */
function fallbackMaxSeats(seats: DraftSeat[]): number {
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [2, 6, 9, 10].find((size) => size >= highest) ?? highest;
}
