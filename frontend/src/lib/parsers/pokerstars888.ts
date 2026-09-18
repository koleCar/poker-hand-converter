/**
 * 888poker parser (the file name is the one this parser was commissioned
 * under; the room is 888poker and its skins, not PokerStars).
 *
 * 888 writes the PartyGaming skeleton with its own vocabulary: a `#Game No :`
 * preamble, a `$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28`
 * stakes line, lowercase `** Dealing flop **` markers, bracketed amounts, and a
 * `** Summary **` block that is the only place a showdown is reported.
 *
 * What it does *not* write is anything about the pot: there is no pot total, no
 * rake line and no `Uncalled bet ... returned to`. All three are reconstructed
 * in `shared/p2-handbuilder.ts`; see the comment on `HandDraft.collectedIncludesUncalled`
 * for why 888 needs the opposite treatment from partypoker and iPoker.
 *
 * Skins seen in the wild and covered here: 888poker, Pacific Poker,
 * LuckyAcePoker.com and Cassava, which all print the same body under a
 * different banner.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import { parseAmount, type CurrencyUnit, type PhfHand, type PhfWarning } from "../phf/types";
import {
  BANNER_REGEX,
  P888_AMOUNT_REGEX,
  P888_STAKES_REGEX,
  bannerAndStakes,
  bracketAmount,
  isChatLine,
  isNoiseLine,
  isoFrom888Date,
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

/** Banners that mean 888 and nothing else. `Cassava` is 888's licence holder. */
const BRAND_REGEX = /\b(?:888poker|888\.com|Pacific Poker|LuckyAcePoker|Cassava)\b/i;

/** `** Dealing flop ** [ Jc, Kc, 3c ]`. 888 lower-cases the street name. */
const STREET_REGEX = /^\*{2}\s*Dealing\s+(down cards|flop|turn|river)\s*\*{2}\s*(?:\[([^\]]*)\])?/i;

const SEAT_REGEX = /^Seat\s+(\d+):\s+(.+?)\s*\(\s*([^)]*?)\s*\)\s*$/;
const TABLE_REGEX = /^Table\s+(.+?)(?:\s+(\d+)\s+Max)?\s*\((Real|Play) Money\)\s*$/i;
const BUTTON_REGEX = /^Seat\s+(\d+)\s+is the button\s*$/;

export const poker888Parser: SiteParser = {
  id: "888poker",
  name: "888poker",
  version: VERSION,

  detect(text: string): number {
    const head = bannerAndStakes(text);
    // The stakes line is the only unambiguous signal: partypoker prints the
    // same banner. Claiming a partypoker hand here would mangle it silently,
    // so there is no banner-only branch at any confidence.
    if (!head || !P888_STAKES_REGEX.test(head.stakes)) {
      return 0;
    }
    return BRAND_REGEX.test(head.banner) ? 0.95 : 0.9;
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
      throw new ParseSkip("no-header", "The chunk has no 888poker banner line.");
    }
    const handId = banner[2];

    const stakesLine = bannerAndStakes(raw)?.stakes ?? "";
    const stakes = stakesLine.match(P888_STAKES_REGEX);
    if (!stakes) {
      throw new ParseSkip(
        "no-header",
        "The 888poker stakes line is missing, so the stakes and the game are unknown.",
      );
    }
    const label = stakes[3].trim();
    if (!/hold\s*'?em/i.test(label)) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${label}".`,
      );
    }
    const small = stakes[1].trim().match(P888_AMOUNT_REGEX);
    const big = stakes[2].trim().match(P888_AMOUNT_REGEX);
    if (!small || !big) {
      // `25 $/50 $ Blinds ...` with `3 023,50 $` stacks: the European 888
      // client puts the symbol behind the number and uses a comma decimal
      // separator, which `parseAmount` would read as a thousands separator and
      // inflate every amount a hundredfold. Refusing is the only safe answer
      // until the locale is handled end to end.
      throw new ParseSkip(
        "unsupported-locale",
        `The stakes "${stakes[1]}/${stakes[2]}" are not in the English-locale 888 format.`,
      );
    }
    const unit = unitFor(small[1] || big[1]);
    const playedAt = isoFrom888Date(stakes[4], stakes[5], stakes[6], stakes[7], stakes[8], stakes[9]);

    const seats: DraftSeat[] = [];
    const seatNames = new Set<string>();
    const actions: DraftAction[] = [];
    const collected: HandDraft["collected"] = [];
    const acted = new Set<string>();
    let tableName: string | null = null;
    let maxSeats = 0;
    let buttonSeat: number | null = null;
    let street: DraftStreet = "preflop";
    let sawSummary = false;
    let heroName: string | null = null;

    const act = (player: string, action: Omit<DraftAction, "street" | "player">) => {
      acted.add(player);
      actions.push({ street, player, ...action });
    };

    for (let i = bannerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i].replace(/^\uFEFF/, "").trim();
      const lineNo = i + 1;
      if (!line) {
        continue;
      }
      if (P888_STAKES_REGEX.test(line) || isNoiseLine(line)) {
        continue;
      }

      const table = line.match(TABLE_REGEX);
      if (table) {
        tableName = table[1].trim();
        maxSeats = Number(table[2] ?? 0);
        continue;
      }

      const button = line.match(BUTTON_REGEX);
      if (button) {
        buttonSeat = Number(button[1]);
        continue;
      }

      const seat = line.match(SEAT_REGEX);
      if (seat && !sawSummary) {
        const name = seat[2];
        seats.push({
          seat: Number(seat[1]),
          name,
          startingStack: parseAmount(seat[3], unit),
          // Filled in after the whole hand is read: a seat counts as dealt in
          // once it posts or acts, and the big blind of a walk does neither.
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

      if (/^\*{2}\s*Summary\s*\*{2}$/i.test(line)) {
        sawSummary = true;
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

      const collect = line.match(/^(.+?)\s+collected\s*\[\s*([^\]]*?)\s*\]\s*$/);
      if (collect && seatNames.has(collect[1])) {
        collected.push({ player: collect[1], amount: bracketAmount(collect[2], unit) });
        continue;
      }

      const posted = line.match(/^(.+?)\s+posts\s+(small blind|big blind|dead blind|ante)\s*\[([^\]]*)\]\s*$/i);
      if (posted && seatNames.has(posted[1])) {
        pushPost(posted[1], posted[2].toLowerCase(), posted[3], unit, act);
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

      const shown = line.match(/^(.+?)\s+(shows|mucks)\s*\[([^\]]*)\]\s*$/);
      if (shown && seatNames.has(shown[1])) {
        // 888 prints both in the SUMMARY block, so both belong to the last
        // street the hand physically reached.
        actions.push({
          street,
          player: shown[1],
          kind: shown[2] === "shows" ? "show" : "muck",
          cards: extractCards(shown[3]),
        });
        continue;
      }

      const noShow = line.match(/^(.+?)\s+did not show (?:his|her|their) hand\s*$/i);
      if (noShow && seatNames.has(noShow[1])) {
        actions.push({ street, player: noShow[1], kind: "muck", cards: [] });
        continue;
      }

      // Omaha hi-lo prints the made hands as `(Hi: ...)` / `(Lo: ...)` under the
      // show line. Hold'em never reaches this, and Omaha is refused above.
      if (/^\((?:Hi|Lo):/i.test(line)) {
        continue;
      }

      if (isChatLine(line, seatNames)) {
        continue;
      }

      warnings.push({ code: "unknown-line", message: line, line: lineNo });
    }

    if (!sawSummary) {
      throw new ParseSkip(
        "truncated-hand",
        "The hand has no `** Summary **` block, so nothing says what was won.",
      );
    }
    if (collected.length === 0) {
      throw new ParseSkip("no-winner", "The summary block names no winner.");
    }

    for (const seat of seats) {
      seat.dealtIn = acted.has(seat.name) || seat.name === heroName;
    }
    // The big blind of a walk never acts, so a seat that took chips is dealt in
    // whatever else the body said about it.
    for (const entry of collected) {
      const seat = seats.find((candidate) => candidate.name === entry.player);
      if (seat) {
        seat.dealtIn = true;
      }
    }

    const draft: HandDraft = {
      siteId: "888poker",
      siteName: "888poker",
      parserId: "888poker",
      parserVersion: VERSION,
      handPrefix: "888-",
      handId,
      gameLabel: canonicalLabel(label),
      unit,
      decimals: "fixed2",
      headerSmallBlind: parseAmount(small[2], unit),
      headerBigBlind: parseAmount(big[2], unit),
      tableName,
      maxSeats: maxSeats || fallbackMaxSeats(seats),
      buttonSeat,
      playedAt,
      seats,
      actions,
      flop: boardOf(raw, "flop"),
      turn: boardOf(raw, "turn")?.[0] ?? null,
      river: boardOf(raw, "river")?.[0] ?? null,
      collected,
      // 888 deducts the winner's uncalled bet before printing `collected`.
      collectedIncludesUncalled: false,
      rawText: raw.replace(/^\uFEFF/, "").trim(),
      warnings,
    };

    if (draft.flop && draft.flop.length !== 3) {
      throw new ParseSkip(
        "board-size",
        `The flop line lists ${draft.flop.length} cards, so the hand is corrupt.`,
      );
    }

    return buildHand(draft, ctx);
  },
};

function pushPost(
  player: string,
  kind: string,
  bracket: string,
  unit: CurrencyUnit,
  act: (player: string, action: Omit<DraftAction, "street" | "player">) => void,
): void {
  if (kind === "dead blind") {
    // `posts dead blind [$1 + $2]` on a $1/$2 table: the dead small blind
    // first, then the live big blind the player is posting to re-enter.
    const parts = bracket.match(/[\d,]+(?:\.\d+)?/g) ?? [];
    const dead = parseAmount(parts[0], unit);
    const live = parseAmount(parts[1] ?? parts[0], unit);
    act(player, { kind: "post", amount: parts.length > 1 ? live : 0, dead: parts.length > 1 ? dead : live });
    return;
  }
  const amount = bracketAmount(bracket, unit);
  if (kind === "ante") {
    act(player, { kind: "ante", amount });
    return;
  }
  act(player, { kind: kind === "small blind" ? "small-blind" : "big-blind", amount });
}

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

/** 888 writes `No Limit Holdem`; trackers expect the GG order. */
function canonicalLabel(label: string): string {
  if (/pot\s*limit/i.test(label)) {
    return "Hold'em Pot Limit";
  }
  if (/fix(?:ed)?\s*limit/i.test(label)) {
    return "Hold'em Limit";
  }
  return "Hold'em No Limit";
}

/** 888 omits the seat count on some tables; round up to the next real size. */
function fallbackMaxSeats(seats: DraftSeat[]): number {
  const highest = Math.max(seats.length, ...seats.map((seat) => seat.seat));
  return [2, 4, 6, 9, 10].find((size) => size >= highest) ?? highest;
}
