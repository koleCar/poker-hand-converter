/**
 * partypoker parser.
 *
 * partypoker shares the PartyGaming skeleton with 888 but differs everywhere it
 * matters:
 *
 * - the stakes line is `$0.05/$0.10 USD NL Texas Hold'em - Monday, January 06,
 *   08:54:23 EST 2014`, and on pot-limit and older no-limit tables it degrades
 *   to `$100 USD PL Omaha`, where the single number is the maximum buy-in and
 *   the blinds appear nowhere in the header at all. The blinds therefore always
 *   come from what was posted;
 * - the date carries a timezone abbreviation and is converted to UTC, because
 *   PHF stores an instant, not a wall clock;
 * - there is no summary block. Showdowns, mucks and winnings are interleaved
 *   with the action;
 * - an uncalled bet is never returned. It stays in the pot and comes back to
 *   the bettor inside `wins`, often printed as a pot of its own: the `wins $1.87
 *   USD from the side pot 1` line in a two-player all-in *is* the uncalled bet,
 *   not a real side pot;
 * - table chat is interleaved with the action and is indistinguishable from an
 *   action line except that its speaker is a seated player.
 *
 * Everything from the pot reconstruction on is in `shared/p2-handbuilder.ts`.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import { parseAmount, type PhfHand, type PhfWarning } from "../phf/types";
import {
  BANNER_REGEX,
  PARTY_DATE_REGEX,
  bannerAndStakes,
  PARTY_GAME_REGEX,
  P888_STAKES_REGEX,
  bracketAmount,
  isChatLine,
  isNoiseLine,
  isoFromPartyDate,
  knownZone,
  splitBanneredHands,
  unitFor,
} from "./shared/p2-partygaming";
import {
  buildHand,
  type DraftAction,
  type DraftSeat,
  type DraftStreet,
  type HandDraft,
} from "./shared/p2-handbuilder";

const VERSION = "1.0.0";

const STREET_REGEX = /^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?/i;
const SEAT_REGEX = /^Seat\s+(\d+):\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$/;
const TABLE_REGEX = /^Table\s+(.+?)\s+\((Real|Play) Money\)\s*$/i;
const BUTTON_REGEX = /^Seat\s+(\d+)\s+is the button\s*$/;
const SEAT_COUNT_REGEX = /^Total number of players\s*:\s*(\d+)(?:\/(\d+))?/;

export const partypokerParser: SiteParser = {
  id: "partypoker",
  name: "partypoker",
  version: VERSION,

  detect(text: string): number {
    const head = bannerAndStakes(text);
    if (!head) {
      return 0;
    }
    // 888 prints the same banner, so a hand whose stakes line is 888's is not
    // ours at any confidence.
    if (P888_STAKES_REGEX.test(head.stakes) || !PARTY_DATE_REGEX.test(head.stakes)) {
      return 0;
    }
    return /\b(?:partypoker|party poker)\b/i.test(head.banner) ? 0.95 : 0.9;
  },

  splitHands(text: string): string[] {
    return splitBanneredHands(text);
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
    const warnings: PhfWarning[] = [];

    const bannerIndex = lines.findIndex((line) => BANNER_REGEX.test(line.trim()));
    const banner = lines[bannerIndex]?.trim().match(BANNER_REGEX);
    if (!banner) {
      throw new ParseSkip("no-header", "The chunk has no partypoker banner line.");
    }
    const handId = banner[2];

    const stakesLine = bannerAndStakes(raw)?.stakes ?? "";
    const date = stakesLine.match(PARTY_DATE_REGEX);
    const game = date?.[1].match(PARTY_GAME_REGEX);
    if (!date || !game) {
      throw new ParseSkip(
        "no-header",
        "The partypoker stakes line is missing or unreadable, so the game is unknown.",
      );
    }
    if (!/(?:texas\s+)?hold\s*'?em/i.test(game[7])) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${game[7].trim()}".`,
      );
    }
    if (!knownZone(date[7])) {
      warnings.push({
        code: "unknown-timezone",
        message: `Timezone "${date[7]}" is not in the offset table; the hand is timed as UTC.`,
      });
    }
    const playedAt = isoFromPartyDate(date[2], date[3], date[4], date[5], date[6], date[7], date[8]);
    const unit = unitFor(game[1] || game[3]);

    const seats: DraftSeat[] = [];
    const seatNames = new Set<string>();
    const actions: DraftAction[] = [];
    const collected: HandDraft["collected"] = [];
    const acted = new Set<string>();
    let tableName: string | null = null;
    let maxSeats = 0;
    let buttonSeat: number | null = null;
    let street: DraftStreet = "preflop";
    let bigBlind = 0;
    let heroName: string | null = null;

    const act = (player: string, action: Omit<DraftAction, "street" | "player">) => {
      acted.add(player);
      actions.push({ street, player, ...action });
    };

    for (let i = bannerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i].replace(/^\uFEFF/, "").trim();
      const lineNo = i + 1;
      if (!line || line === stakesLine) {
        continue;
      }

      const seatCount = line.match(SEAT_COUNT_REGEX);
      if (seatCount) {
        maxSeats = Number(seatCount[2] ?? seatCount[1]);
        continue;
      }
      if (isNoiseLine(line)) {
        continue;
      }

      const table = line.match(TABLE_REGEX);
      if (table) {
        tableName = table[1].trim();
        continue;
      }

      const button = line.match(BUTTON_REGEX);
      if (button) {
        buttonSeat = Number(button[1]);
        continue;
      }

      const seat = line.match(SEAT_REGEX);
      if (seat) {
        const name = seat[2];
        seats.push({
          seat: Number(seat[1]),
          name,
          startingStack: parseAmount(seat[3], unit),
          dealtIn: false,
          isHero: false,
          dealtCards: [],
        });
        seatNames.add(name);
        continue;
      }

      const marker = line.match(STREET_REGEX);
      if (marker) {
        const kind = marker[1].toLowerCase();
        if (kind !== "down cards") {
          street = kind as DraftStreet;
        }
        continue;
      }

      const dealt = line.match(/^Dealt to\s+(.+?)\s*\[([^\]]*)\]\s*$/);
      if (dealt) {
        const player = seats.find((entry) => entry.name === dealt[1]);
        if (player) {
          player.isHero = true;
          player.dealtCards = extractCards(dealt[2]);
          heroName = player.name;
        }
        continue;
      }

      const wins = line.match(
        /^(.+?)\s+wins\s+([$€£]?[\d,]+(?:\.\d+)?)(?:\s+[A-Z]{3})?(?:\s+from the (main pot|side pot)(?:\s+\d+)?)?(?:\s+with\s+.+)?\.?\s*$/,
      );
      if (wins && seatNames.has(wins[1])) {
        collected.push({
          player: wins[1],
          amount: parseAmount(wins[2], unit),
          potName: wins[3] ?? "pot",
        });
        continue;
      }

      const posted = line.match(
        /^(.+?)\s+posts\s+(small blind|big blind \+ dead|big blind|ante|dead blind)\s*\[([^\]]*)\]\.?\s*$/i,
      );
      if (posted && seatNames.has(posted[1])) {
        const kind = posted[2].toLowerCase();
        const amount = bracketAmount(posted[3], unit);
        if (kind === "small blind") {
          act(posted[1], { kind: "small-blind", amount });
        } else if (kind === "big blind") {
          bigBlind = Math.max(bigBlind, amount);
          act(posted[1], { kind: "big-blind", amount });
        } else if (kind === "ante") {
          act(posted[1], { kind: "ante", amount });
        } else {
          // `posts big blind + dead [$3]` is one big blind plus dead money that
          // nobody has to match. The split needs the blind, which by this point
          // the real big blind has already established.
          const live = Math.min(bigBlind || amount, amount);
          act(posted[1], { kind: "post", amount: live, dead: amount - live });
        }
        continue;
      }

      const simple = line.match(/^(.+?)\s+(folds|checks)\s*$/);
      if (simple && seatNames.has(simple[1])) {
        act(simple[1], { kind: simple[2] === "folds" ? "fold" : "check" });
        continue;
      }

      const wager = line.match(/^(.+?)\s+(calls|bets|raises)\s*\[([^\]]*)\]\s*$/);
      if (wager && seatNames.has(wager[1])) {
        act(wager[1], {
          kind: wager[2] === "calls" ? "call" : wager[2] === "bets" ? "bet" : "raise",
          amount: bracketAmount(wager[3], unit),
        });
        continue;
      }

      const allIn = line.match(/^(.+?)\s+is all-In\s*\[([^\]]*)\]\s*$/i);
      if (allIn && seatNames.has(allIn[1])) {
        act(allIn[1], { kind: "allin", amount: bracketAmount(allIn[2], unit), allIn: true });
        continue;
      }

      // `shows [ 8c, 8d ]three of a kind, Eights.` - no space before the
      // description, and `doesn't show` still reveals the cards, which is
      // partypoker's way of writing an auto-mucked losing hand.
      const revealed = line.match(/^(.+?)\s+(shows|doesn't show)\s*\[([^\]]*)\]\s*(.*?)\.?\s*$/);
      if (revealed && seatNames.has(revealed[1])) {
        actions.push({
          street,
          player: revealed[1],
          kind: revealed[2] === "shows" ? "show" : "muck",
          cards: extractCards(revealed[3]),
          description: revealed[4] || undefined,
        });
        continue;
      }

      const noShow = line.match(/^(.+?)\s+does not show cards\.?\s*$/i);
      if (noShow && seatNames.has(noShow[1])) {
        actions.push({ street, player: noShow[1], kind: "muck", cards: [] });
        continue;
      }

      if (isChatLine(line, seatNames)) {
        continue;
      }

      warnings.push({ code: "unknown-line", message: line, line: lineNo });
    }

    if (collected.length === 0) {
      throw new ParseSkip(
        "no-winner",
        "No `wins` line, so the hand text was cut off before it was settled.",
      );
    }

    for (const seat of seats) {
      seat.dealtIn = acted.has(seat.name) || seat.name === heroName;
    }
    for (const entry of collected) {
      const seat = seats.find((candidate) => candidate.name === entry.player);
      if (seat) {
        // The big blind of a walk never acts but is unquestionably dealt in.
        seat.dealtIn = true;
      }
    }

    const flop = boardOf(raw, "flop");
    const draft: HandDraft = {
      siteId: "partypoker",
      siteName: "partypoker",
      parserId: "partypoker",
      parserVersion: VERSION,
      handPrefix: "PTY-",
      handId,
      gameLabel: canonicalLabel(game[6]),
      unit,
      decimals: "fixed2",
      headerSmallBlind: game[4] ? parseAmount(game[2], unit) : 0,
      headerBigBlind: game[4] ? parseAmount(game[4], unit) : 0,
      tableName,
      maxSeats: maxSeats || fallbackMaxSeats(seats),
      buttonSeat,
      playedAt,
      seats,
      actions,
      flop,
      turn: boardOf(raw, "turn")?.[0] ?? null,
      river: boardOf(raw, "river")?.[0] ?? null,
      collected,
      // partypoker leaves the uncalled bet in the pot and hands it back as part
      // of `wins`.
      collectedIncludesUncalled: true,
      rawText: raw.replace(/^\uFEFF/, "").trim(),
      warnings,
    };

    if (flop && flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The flop line lists ${flop.length} cards, so the hand is corrupt.`,
      );
    }

    return buildHand(draft, ctx);
  },
};

function boardOf(raw: string, street: string): string[] | null {
  const match = raw.match(
    new RegExp(String.raw`^\*{2}\s*Dealing\s+${street}\s*\*{2}\s*\[([^\]]*)\]`, "im"),
  );
  if (!match) {
    return null;
  }
  const cards = extractCards(match[1]);
  return cards.length === 0 ? null : cards;
}

/** partypoker writes `NL`; trackers expect the GG wording. */
function canonicalLabel(limit: string): string {
  if (/^(?:PL|Pot Limit)$/i.test(limit)) {
    return "Hold'em Pot Limit";
  }
  if (/^(?:FL|Fixed Limit|Limit)$/i.test(limit)) {
    return "Hold'em Limit";
  }
  return "Hold'em No Limit";
}

function fallbackMaxSeats(seats: DraftSeat[]): number {
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [2, 4, 6, 9, 10].find((size) => size >= highest) ?? highest;
}
