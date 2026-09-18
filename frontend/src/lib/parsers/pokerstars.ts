/**
 * PokerStars parser.
 *
 * PokerStars wrote the format every other room imitates, so this file is the
 * reference dialect: cash and tournament, Zoom, Home Games, play money, all
 * currencies, antes, run-it-twice, side pots, sit-outs and disconnects, and the
 * SUMMARY block. The shared semantics live in `shared/ps-gg-hand.ts`; the line
 * grammar below is PokerStars' own and is not shared with GG.
 *
 * Every non-obvious branch names the fixture that forced it. The fixtures are in
 * `fixtures/samples/pokerstars/`.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  DEFAULT_TEXT_STYLE,
  ZERO_FEES,
  parseAmount,
  parseBuyInToken,
  type Amount,
  type CurrencyUnit,
  type PhfFees,
  type PhfHand,
  type PhfTournament,
} from "../phf/types";
import {
  MONEY,
  StarsHandDraft,
  buyInUnitFor,
  detectDecimals,
  detectPadHour,
  hasUnsupportedCurrency,
  levelNumberOf,
  limitFromLabel,
  normalizeNewlines,
  parsePlayedAt,
  stripBom,
  toLines,
  unitForStakes,
  variantFromLabel,
  type DraftGame,
} from "./shared/ps-gg-hand";

export const POKERSTARS_PARSER_VERSION = "1.0.0";

/**
 * Every header shape PokerStars ships.
 *
 * `PokerStars Game #` is the pre-2013 spelling, `PokerStars Hand #` the current
 * one, and the middle word is the product: `Zoom`, `Home Game`,
 * `Home Game Zoom`. The id is followed by an optional `{Club #N}` tag on Home
 * Game hands.
 */
const HEADER_REGEX =
  /^PokerStars(?: ([A-Za-z ]+?))? (?:Hand|Game) #(\d+):\s*(?:\{([^}]*)\}\s*)?(.*)$/;

/** Cheap prefix test used by `detect` and `splitHands`; kept in sync by hand. */
const HEADER_PREFIX = /^PokerStars(?: [A-Za-z ]+?)? (?:Hand|Game) #\d+:/;

const TABLE_REGEX =
  /^Table '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$/;
const SEAT_REGEX = /^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$/;
const MARKER_REGEX =
  /^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i;
const RUN_PREFIXES = ["FIRST", "SECOND", "THIRD", "FOURTH"];

/**
 * Trailing clauses PokerStars appends to a wager.
 *
 * `and has reached the $40 cap` is a CAP-table line (fixture 08); it means the
 * player may not put any more in, which is not the same thing as all-in, so it
 * deliberately does not set `allIn`.
 */
const SUFFIX = String.raw`((?: and (?:is all-in|has reached the \S+ cap))*)`;

function allInFrom(suffix: string | undefined): boolean {
  return Boolean(suffix && /and is all-in/.test(suffix));
}

/**
 * Lines that carry neither pot nor card information.
 *
 * Dropping them is not information loss, but it has to be deliberate: an
 * unlisted shape has to raise `unknown-line` rather than be swallowed, which is
 * what `backend/test/pokerstarsParser.test.ts` asserts over the whole corpus.
 */
const CHATTER_REGEX = new RegExp(
  [
    String.raw`\bsaid, "`,
    String.raw`\bjoins the table at seat #\d+`,
    String.raw`\bleaves the table\b`,
    String.raw`\bis sitting out\b`,
    String.raw`\bsits out\b`,
    String.raw`\bhas returned\b`,
    String.raw`\bstands up\b`,
    String.raw`\bhas timed out\b`,
    String.raw`\bis (?:dis)?connected\b`,
    String.raw`\bwas removed from the table for failing to post\b`,
    String.raw`\bwill be allowed to play after the button\b`,
    String.raw`\bhas requested TIME\b`,
    String.raw`\bis feeling\b`,
    // Tournament bookkeeping. The chip movements they describe happen between
    // hands, not inside this one, so they must not touch the pot.
    String.raw`\bfinished the tournament in\b`,
    String.raw`\bwins the tournament and receives\b`,
    String.raw`\bre-buys and receives\b`,
    String.raw`\breceives? an add-on\b`,
    String.raw`\bhas been disconnected\b`,
    String.raw`\bLevel changed\b`,
  ].join("|"),
  "i",
);

/** `X wins the $2.50 bounty for eliminating Y` and its split variants. */
const BOUNTY_REGEX =
  /^(.+?) wins (?:the )?(\S+) (?:bounty|for splitting the elimination)\b.*$/;

/* --------------------------------------------------------------- header --- */

interface Header {
  handId: string;
  product: string;
  clubTag: string | null;
  payload: string;
  game: DraftGame;
  tournament: PhfTournament | null;
  playedAt: string | null;
  playMoney: boolean;
}

/** `$0.25/$0.50 - $10 Cap -  USD` -> the two blinds; the rest is decoration. */
function blindsFrom(stakesText: string, unit: CurrencyUnit): { sb: Amount; bb: Amount } {
  const match = stakesText.match(/^\s*(\S+)\/(\S+)/);
  if (!match) {
    return { sb: 0, bb: parseAmount(stakesText.trim(), unit) };
  }
  return { sb: parseAmount(match[1], unit), bb: parseAmount(match[2], unit) };
}

/**
 * `null` means a currency we cannot represent; the caller refuses the hand
 * rather than emitting one whose amounts are off by a factor of a hundred.
 */
function unitFor(stakesText: string): CurrencyUnit | null {
  return unitForStakes(stakesText, CHIPS);
}

interface TournamentHeader {
  tournament: PhfTournament;
  game: DraftGame;
}

function parseTournament(payload: string): TournamentHeader | null {
  // `Tournament #987654321, $10+$1 USD Hold'em No Limit - Level V (75/150) - <date>`
  // `Tournament #123, Freeroll  Hold'em No Limit - Match Round I, Level I (10/20) - <date>`
  const match = payload.match(
    /^Tournament #(\S+?), (.+?) - (?:Match Round ([IVXLCDM]+), )?Level ([^\s(]+)\s*\(([^)]*)\)\s+-\s+(.*)$/,
  );
  if (!match) {
    return null;
  }
  const [, id, buyInAndGame, , levelLabel, levelStakes] = match;

  // The buy-in token is everything up to the currency code or the game name.
  const split = buyInAndGame.match(
    /^(\S+(?:\+\S+)*)\s+(?:(USD|EUR|GBP|CAD|CNY|NOK|SEK|INR|RUB)\s+)?(.+)$/,
  );
  const buyInToken = split ? split[1] : "";
  const buyInUnit = buyInUnitFor(buyInToken, split?.[2]);
  const buyInParts = parseBuyInToken(buyInToken, buyInUnit);
  const label = (split ? split[3] : buyInAndGame).trim();

  const unit = unitFor(levelStakes);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(levelStakes, unit);
  const stakeParts = levelStakes.split("/");

  return {
    tournament: {
      id,
      // PokerStars does not print a tournament name in the header, only the id.
      name: null,
      // Knockout buy-ins are `$x+$y+$z`: prize pool, bounty, fee. All three are
      // kept; `totalBuyIn()` adds them back up.
      buyIn: buyInParts.buyIn,
      bounty: buyInParts.bounty,
      fee: buyInParts.fee,
      buyInUnit,
      levelLabel,
      levelNumber: levelNumberOf(levelLabel),
      levelSmallBlind: blinds.sb,
      levelBigBlind: blinds.bb,
      levelAnte: parseAmount(stakeParts[2], unit),
      bounties: [],
    },
    game: {
      variant: variantFromLabel(label),
      limit: limitFromLabel(label),
      format: "tournament",
      label,
      unit,
      smallBlind: blinds.sb,
      bigBlind: blinds.bb,
    },
  };
}

function parseHeader(line: string): Header | null {
  const match = line.match(HEADER_REGEX);
  if (!match) {
    return null;
  }
  const [, product, handId, clubTag, payload] = match;
  const playedAt = parsePlayedAt(payload);

  const tournament = parseTournament(payload);
  if (tournament) {
    return {
      handId,
      product: product ?? "",
      clubTag: clubTag ?? null,
      payload,
      game: tournament.game,
      tournament: tournament.tournament,
      playedAt,
      playMoney: false,
    };
  }

  // `Hold'em No Limit ($0.25/$0.50 - $10 Cap -  USD) - 2012/09/11 8:39:12 ET`
  const cash = payload.match(/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/);
  if (!cash) {
    return null;
  }
  const label = cash[1].trim();
  const stakesText = cash[2];
  const unit = unitFor(stakesText);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(stakesText, unit);
  return {
    handId,
    product: product ?? "",
    clubTag: clubTag ?? null,
    payload,
    game: {
      variant: variantFromLabel(label),
      limit: limitFromLabel(label),
      format: "cash",
      label,
      unit,
      smallBlind: blinds.sb,
      bigBlind: blinds.bb,
    },
    tournament: null,
    playedAt,
    playMoney: unit === CHIPS,
  };
}

/* ---------------------------------------------------------------- parser --- */

function parseSummaryFees(line: string, unit: CurrencyUnit): PhfFees {
  // PokerStars prints `| Rake $x` and nothing else; the GG promo columns are
  // absent, so they stay zero rather than being invented.
  return {
    ...ZERO_FEES,
    rake: parseAmount(line.match(new RegExp(String.raw`Rake ${MONEY}`))?.[1], unit),
  };
}

function runoutIndexForLabel(label: string): number {
  if (!label) {
    return 0;
  }
  const index = RUN_PREFIXES.indexOf(label.toUpperCase());
  return index < 0 ? 0 : index;
}

function parseOneHand(raw: string, ctx: SiteParserContext): PhfHand {
  const text = stripBom(raw).trim();
  const lines = toLines(text);
  // A currency PHF has no unit for would be read at the wrong scale, so it is
  // refused at the header rather than mis-converted.
  if (hasUnsupportedCurrency(lines[0] ?? "")) {
    throw new ParseSkip(
      "unsupported-currency",
      `PHF has no unit for the currency in "${lines[0]}".`,
    );
  }
  const header = parseHeader(lines[0] ?? "");
  if (!header) {
    throw new ParseSkip("normalized-unparseable", "The hand has no PokerStars header line.");
  }

  if (header.game.variant !== "holdem") {
    throw new ParseSkip(
      "unsupported-variant",
      `${header.game.label} is not supported yet; the hand is kept for a future parser.`,
    );
  }
  // PokerStars' experimental Hold'em spin-offs read as ordinary Hold'em in the
  // header but change the deal: Fusion hands out extra hole cards on the flop
  // and the turn, Split Hold'em runs two boards for every hand, Unfold deals a
  // phantom runout for the folders. Converting them as Hold'em would produce a
  // plausible hand with the wrong cards in it, so they are refused.
  if (/\b(?:Fusion|Split Hold'?em|Unfold|Power Up|Tempest)\b/i.test(header.game.label)) {
    throw new ParseSkip(
      "unsupported-variant",
      `${header.game.label} deals differently from Hold'em and is not supported yet.`,
    );
  }
  if (ctx.options.cashOnly && header.tournament) {
    throw new ParseSkip(
      "tournament-in-cash-mode",
      "Tournament hand skipped because the converter is in cash-only mode.",
    );
  }
  // `Hand cancelled` means the deal was voided; the blinds are returned and
  // there is nothing to convert (fixture 12).
  if (lines.some((line) => /^Hand cancelled\s*$/i.test(line.trim()))) {
    throw new ParseSkip("hand-cancelled", "PokerStars cancelled the hand.");
  }

  const unit = header.game.unit;
  const draft = new StarsHandDraft({
    siteId: "pokerstars",
    siteName: "PokerStars",
    parserId: "pokerstars",
    parserVersion: POKERSTARS_PARSER_VERSION,
    handId: header.handId,
    // PokerStars ids are bare integers, so they are namespaced to keep them from
    // colliding with another room's numeric ids in `stored_hands.hand_key`.
    handKey: `PS${header.handId}`,
    rawText: text,
    originalFilename: ctx.sourceFilename,
    game: header.game,
    tournament: header.tournament,
    playedAt: header.playedAt,
    textStyle: {
      ...DEFAULT_TEXT_STYLE,
      decimals: detectDecimals(text),
      padHour: detectPadHour(header.payload),
    },
    // Some 2011-era exports drop the `Uncalled bet (x) returned to y` line
    // (fixtures 07 and 08). The return is recoverable exactly; see the draft.
    repairMissingUncalled: true,
  });

  if (header.clubTag) {
    draft.warn("home-game", `Home Game hand from ${header.clubTag}.`);
  }
  // `Hold'em Pot Limit Pre-Flop, No Limit Post-Flop` (fixture 36) is one game
  // with two betting caps. `PhfGame.limit` is a single value, so it records the
  // preflop cap and the hand is flagged - a consumer computing bet-sizing stats
  // needs to know the label said more than the field can.
  if (/pre-?flop/i.test(header.game.label) && /post-?flop/i.test(header.game.label)) {
    draft.warn(
      "mixed-betting-structure",
      `"${header.game.label}" caps preflop and postflop differently; ` +
        `game.limit records the preflop cap only.`,
    );
  }

  const money = (value: string | undefined) => parseAmount(value, unit);
  let inSummary = false;

  for (let i = 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    const lineNo = i + 1;
    if (!line) {
      continue;
    }

    if (/^\*\*\*\s*SUMMARY\s*\*\*\*/i.test(line)) {
      inSummary = true;
      continue;
    }

    if (inSummary) {
      const pot = line.match(new RegExp(String.raw`^Total pot ${MONEY}`));
      if (pot) {
        const pots: Array<{ name: string; amount: Amount }> = [];
        // `Total pot $39.78 Main pot $30.37. Side pot $7.91. | Rake $1.50`
        // Three or more all-ins number the side pots *after* the word "pot":
        // `Side pot-1 $60. Side pot-2 $2.`, which is where a naive
        // `Side(-\d+)? pot` regex quietly drops every extra pot.
        for (const entry of line
          .split("|")[0]
          .matchAll(new RegExp(String.raw`(Main|Side) pot(-\d+)? ${MONEY}\.`, "g"))) {
          pots.push({ name: `${entry[1]}${entry[2] ?? ""}`, amount: money(entry[3]) });
        }
        draft.summaryPot(money(pot[1]), pots, parseSummaryFees(line, unit));
        continue;
      }
      // PokerStars writes "twice"; GG writes "two times". Both are accepted here
      // because a file can be edited by hand before it reaches us.
      if (/^Hand was run (?:twice|two times|three times|four times)$/i.test(line)) {
        draft.noteRunItTwice();
        continue;
      }
      const board = line.match(/^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]/i);
      if (board) {
        draft.summaryBoard(runoutIndexForLabel((board[1] ?? "").trim()), extractCards(board[2]));
        continue;
      }
      const seat = line.match(/^Seat (\d+):/);
      if (seat) {
        draft.summarySeat(Number(seat[1]), line);
        continue;
      }
      if (CHATTER_REGEX.test(line)) {
        continue;
      }
      draft.warn("unknown-summary-line", line, lineNo);
      continue;
    }

    const table = line.match(TABLE_REGEX);
    if (table) {
      draft.setTable(
        table[1] || null,
        Number(table[2]) || 0,
        table[4] ? Number(table[4]) : null,
      );
      continue;
    }

    const seat = line.match(SEAT_REGEX);
    if (seat) {
      draft.seat(
        Number(seat[1]),
        seat[2],
        money(seat[3]),
        /\bis sitting out\b/i.test(seat[4] ?? ""),
      );
      continue;
    }

    const marker = line.match(MARKER_REGEX);
    if (marker) {
      const index = runoutIndexForLabel(marker[1] ?? "");
      const kind = marker[2].replace(/\s+/g, "").toUpperCase();
      // `*** TURN *** [Th Kh Ac] [9d]` restates the board, so the last bracket
      // group is the card that was actually dealt.
      const groups = [...marker[3].matchAll(/\[([^\]]*)\]/g)].map((m) => extractCards(m[1]));
      const cards = groups[groups.length - 1] ?? [];
      draft.marker(
        kind === "SHOWDOWN" ? "showdown" : (kind.toLowerCase() as "flop" | "turn" | "river"),
        index,
        marker[1] ?? "",
        cards,
      );
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i.test(line)) {
      draft.holeCardsMarker();
      continue;
    }

    const dealt = rawLine.match(/^Dealt to (.+?)(?: \[([^\]]*)\])?\s*$/);
    if (dealt) {
      draft.dealt(dealt[1].trim(), dealt[2] ? extractCards(dealt[2]) : []);
      continue;
    }

    const uncalled = line.match(
      new RegExp(String.raw`^Uncalled bet \(${MONEY}\) returned to (.+)$`),
    );
    if (uncalled) {
      draft.uncalled(uncalled[2].trim(), money(uncalled[1]), { line: lineNo, rawLine: line });
      continue;
    }

    const collected = line.match(
      new RegExp(String.raw`^(.+?) collected ${MONEY} from (?:the )?(.+?)$`),
    );
    if (collected) {
      draft.collect(collected[1].trim(), money(collected[2]), collected[3], {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const ante = line.match(new RegExp(String.raw`^(.+?): posts the ante ${MONEY}${SUFFIX}$`));
    if (ante) {
      draft.post(ante[1], "ante", money(ante[2]), {
        allIn: allInFrom(ante[3]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const blind = line.match(
      new RegExp(String.raw`^(.+?): posts (small|big) blind ${MONEY}${SUFFIX}$`),
    );
    if (blind) {
      draft.post(
        blind[1],
        blind[2].toLowerCase() === "small" ? "small-blind" : "big-blind",
        money(blind[3]),
        { allIn: allInFrom(blind[4]), line: lineNo, rawLine: line },
      );
      continue;
    }

    // A player returning to the table owes both blinds at once. The big blind
    // is live and the small blind is dead, but PokerStars states only the
    // total, so it is recorded as one dead post and the big blind that follows
    // in the betting is derived from the header stakes.
    const bothBlinds = line.match(
      new RegExp(String.raw`^(.+?): posts small (?:&|and) big blinds? ${MONEY}${SUFFIX}$`),
    );
    if (bothBlinds) {
      const total = money(bothBlinds[2]);
      const big = Math.min(total, header.game.bigBlind || total);
      draft.post(bothBlinds[1], "big-blind", big, {
        allIn: allInFrom(bothBlinds[3]),
        verb: "posts small & big blinds",
        line: lineNo,
        rawLine: line,
      });
      if (total > big) {
        draft.post(bothBlinds[1], "missed-blind", total - big, {
          line: lineNo,
          rawLine: line,
        });
      }
      continue;
    }

    const dead = line.match(new RegExp(String.raw`^(.+?): posts ${MONEY}${SUFFIX}$`));
    if (dead) {
      // PokerStars has no straddle, so a bare `posts` is always dead money.
      draft.post(dead[1], "missed-blind", money(dead[2]), {
        allIn: allInFrom(dead[3]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    // `Player6: folds [Ks]` - PokerStars lets a player expose a hole card on
    // the way out (fixture 41). The card never reaches the SUMMARY block, so a
    // parser that only handles a bare `folds` loses the only reveal in the hand.
    const simple = line.match(/^(.+?): (folds|checks)(?: \[([^\]]*)\])?$/);
    if (simple) {
      const exposed = simple[3] ? extractCards(simple[3]) : undefined;
      if (exposed && exposed.length > 0) {
        // The reveal is kept on the action, the player and the seat result, but
        // it cannot be re-emitted: standard text is the GG dialect, and GG has
        // no `folds [Ks]` form. Writing it back as a `Dealt to` line would be
        // worse than losing it - that claims the card was face up from the
        // deal. Flagged so the hand carries the fact rather than hiding it.
        draft.warn(
          "reveal-not-serializable",
          `${simple[1]} exposed ${exposed.join(" ")} while folding; ` +
            "standard text has no line shape for that and will not reproduce it.",
          lineNo,
        );
      }
      draft.simple(simple[1], simple[2] === "folds" ? "fold" : "check", {
        cards: exposed,
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const wager = line.match(
      new RegExp(String.raw`^(.+?): (calls|bets) ${MONEY}${SUFFIX}$`),
    );
    if (wager) {
      draft.wager(wager[1], wager[2] === "calls" ? "call" : "bet", money(wager[3]), {
        allIn: allInFrom(wager[4]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const raise = line.match(
      new RegExp(String.raw`^(.+?): raises ${MONEY} to ${MONEY}${SUFFIX}$`),
    );
    if (raise) {
      draft.raiseTo(raise[1], money(raise[3]), {
        allIn: allInFrom(raise[4]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const shows = line.match(/^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?$/);
    if (shows) {
      draft.show(shows[1], extractCards(shows[2]), shows[3], { line: lineNo, rawLine: line });
      continue;
    }

    const muck = line.match(/^(.+?): (mucks hand|doesn't show hand)$/i);
    if (muck) {
      draft.muck(muck[1], muck[2], { line: lineNo, rawLine: line });
      continue;
    }

    // Progressive-knockout awards. The money moves outside the pot, so it is
    // recorded on the player rather than as an action.
    const bounty = line.match(BOUNTY_REGEX);
    if (bounty && draft.isSeated(bounty[1])) {
      draft.setBounty(bounty[1], parseAmount(bounty[2], header.tournament?.buyInUnit ?? unit));
      continue;
    }

    if (CHATTER_REGEX.test(line)) {
      // The sit-out flag is worth keeping even though the line itself carries no
      // money. The name is taken by stripping the phrase off the end rather than
      // by splitting on the first colon, because a name can contain one -
      // `Kuca :P: is sitting out` in fixture 19.
      const sittingOut = line.match(/^(.+?)[: ]+(?:is sitting out|sits out)\s*$/i);
      if (sittingOut) {
        draft.markSittingOut(sittingOut[1]);
      }
      continue;
    }

    draft.warn("unknown-line", line, lineNo);
  }

  if (draft.playerCount() === 0) {
    throw new ParseSkip("normalized-unparseable", "The hand has no seat lines.");
  }

  const hand = draft.build();

  // A hand whose actors are not in its own seat block is internally
  // inconsistent - fixture 18 lists `neverJa(1)ger` in the seats and
  // `neverJager` everywhere else. Emitting it would silently attribute the
  // action to nobody, so it is refused instead.
  const seated = draft.seatedNames();
  const stranger = hand.actions.find((action) => !seated.has(action.player));
  if (stranger) {
    throw new ParseSkip(
      "unseated-actor",
      `"${stranger.player}" acts but is not in the seat block.`,
    );
  }

  return hand;
}

/* --------------------------------------------------------------- the parser */

export const pokerstarsParser: SiteParser = {
  id: "pokerstars",
  name: "PokerStars",
  version: POKERSTARS_PARSER_VERSION,

  detect(text: string): number {
    // The header is unique to the room: no other site writes "PokerStars".
    if (HEADER_PREFIX.test(stripBom(text)) || /(?:^|[\r\n])PokerStars.{0,40}#\d+:/.test(text)) {
      return 0.95;
    }
    // Branding without a header is a truncated paste or a tournament summary;
    // claim it weakly so a dedicated parser could still outrank us.
    if (/\bPokerStars\b/.test(text)) {
      return 0.3;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    // Line endings are normalized first: PokerStars exports exist with bare `\r`
    // separators, which no `\n`-based split would ever break apart.
    return normalizeNewlines(stripBom(text))
      .split(/(?=^PokerStars(?: [A-Za-z ]+?)? (?:Hand|Game) #\d+:)/m)
      .map((chunk) => stripBom(chunk).trim())
      .filter((chunk) => HEADER_PREFIX.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    return parseOneHand(raw, ctx);
  },
};
