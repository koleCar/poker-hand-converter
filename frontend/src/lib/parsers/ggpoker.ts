/**
 * GGPoker parser.
 *
 * ## Why this file is not the `standard` parser
 *
 * GG's export *is* the text this project's standard format was modelled on:
 * both start `Poker Hand #`, both print a `Total pot ... | Rake ...` line, both
 * use `*** SHOWDOWN ***`. `parsers/standard.ts` therefore already handles a
 * plain GG cash hand correctly, and it claims `Poker Hand #` at 0.9. This parser
 * deliberately scores *below* that for the plain dialect (see `detect`), so the
 * reference corpus in `gg-hh/` keeps being read by the parser that was written
 * against it, and only outranks it for the things GG prints that the generic
 * reader gets wrong: Rush & Cash, GG's own tournament header (`Level7 (150/300)`
 * - an arabic numeral glued to the word, never a roman one, with a free-text
 * tournament name in front of it), and the non-Hold'em products, which are
 * refused rather than mangled.
 *
 * ## Skins
 *
 * The parser is named for GGPoker alone, on purpose.
 *
 * - **Natural8** is very probably byte-identical: no real file has been found,
 *   but a published converter for it does nothing except rewrite
 *   `Poker Hand #RC` to `PokerStars Hand #20`, which only works if the rest of
 *   the grammar already matches. Circumstantial, so it is not claimed.
 * - **ClubGG genuinely diverges.** The one real header recovered (from a
 *   PokerTracker bug report) uses a `ring_`-prefixed hand id, the wording
 *   `NLH No Limit` rather than `Hold'em No Limit`, and a 9-max table. That is
 *   not this grammar, `detect` scores it 0, and a ClubGG upload is honestly
 *   reported as an unrecognised site rather than run through a parser built on
 *   a single forum post.
 * - **BestPoker**: nothing found at all. Not claimed.
 *
 * ## What GG does that PokerStars does not
 *
 * - Players are anonymised to eight hex characters; only the observer is named,
 *   and is named literally `Hero`.
 * - Every seat gets a `Dealt to <name>` line with no cards for the villains.
 *   That is a different thing from "we know their hole cards", which is why
 *   `PhfPlayer.dealtCards` exists next to `holeCards` - the summary can still
 *   reveal the cards later, and the replayer needs to know which hands were
 *   face up from the start. Cash hands write a trailing space after the name
 *   and tournament hands do not; that is a serialization detail and is handled
 *   on the way out, not here.
 * - `EV Cashout`: a player buys out of the remaining equity.
 * - **All-in Insurance**, which is a *different* mechanic from EV Cashout with
 *   its own verbs - see the handler for both; conflating them would report one
 *   product's numbers under the other's name.
 * - The fee line has four widths, from six columns down to a bare `Total pot N`.
 * - Run-it-twice (and thrice) markers are `*** FIRST FLOP ***` ... and each
 *   runout gets its own `*** FIRST SHOWDOWN ***`; the SUMMARY `SECOND Board`
 *   lists only the cards that differ from the first.
 * - The SUMMARY note is `Hand was run two times`, not PokerStars' "twice".
 * - The straddle verb is bare: `X: straddle $4`, not `X: posts straddle $4`.
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

export const GGPOKER_PARSER_VERSION = "1.0.0";

/**
 * GG hand ids carry a two-letter product prefix.
 *
 * The prefix is a hint, not the truth - the game label in the header is what
 * decides the variant - but it is the one signal that is present even on a hand
 * whose label we do not recognise, and it is what makes a Rush & Cash or
 * tournament hand identifiable before anything else has been parsed.
 */
const PRODUCT_PREFIXES: Record<string, string> = {
  HD: "Hold'em cash",
  RC: "Rush & Cash",
  TM: "tournament",
  SD: "Short Deck",
  OM: "Omaha",
  PL: "Omaha",
  SG: "Spin & Gold",
  BR: "Battle Royale",
};

/**
 * Game labels only GG writes.
 *
 * `ShortDeck` as one word (PokerStars calls the same game `6+ Hold'em`) and the
 * `PLO` / `PLO-5` shorthands are enough on their own to place a hand, which
 * matters for the exports whose hand id carries no product prefix at all -
 * `Poker Hand #1171217378123557259: ShortDeck No Limit ($100)`.
 */
const GG_GAME_LABEL = /^Poker Hand #\S+:\s*(?:ShortDeck|PLO(?:-\d)?|NLO\d?)\b/m;

const HEADER_REGEX = /^(?:GG\s*)?Poker Hand #([A-Za-z0-9_-]+):\s*(.*)$/;
const HEADER_PREFIX = /^(?:GG\s*)?Poker Hand #[A-Za-z0-9_-]+:/;

const TABLE_REGEX =
  /^Table '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$/;
const SEAT_REGEX = /^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$/;
const MARKER_REGEX =
  /^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i;
const RUN_PREFIXES = ["FIRST", "SECOND", "THIRD", "FOURTH"];

/**
 * The fee line.
 *
 * GG emits it in four widths and only the first column is guaranteed:
 *
 *   `Total pot $3 | Rake $0.15 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0`
 *   `Total pot 1234 | Rake 0 | Jackpot 0 | Bingo 0`
 *   `Total pot $2,768 | Rake $60`
 *   `Total pot $37.5`
 *
 * Requiring all six columns - which is what the `gg-hh/` corpus alone suggests -
 * fails to recognise three quarters of the real exports. The promo columns are
 * read individually and default to zero, so the narrow forms parse correctly;
 * this pattern only has to be the *detection* signal, so it asks for the rake
 * column and nothing more.
 */
const GG_FEE_LINE = /^Total pot [^|\n]*\|\s*Rake /m;
const EV_CASHOUT = /: (?:Chooses to EV Cashout|Pays Cashout Risk)/;
/** GG's all-in insurance, which no other room in this project writes. */
const GG_INSURANCE = /: (?:get an all-in insurance|pay premium of all-in insurance)/;
/** Branding that appears in exports from the GG client and its skins. */
const GG_BRANDING = /\b(?:GGPoker|GGPOKER|Natural8|NATURAL8|BestPoker|ClubGG|Rush\s*&\s*Cash)\b/;
/** Rooms other agents own. Explicit foreign branding always wins over ours. */
const FOREIGN_BRANDING = /\b(?:PokerStars|888poker|Pacific Poker|PartyPoker|WPT Global|iPoker)\b/i;

const SUFFIX = String.raw`((?: and is all-in)*)`;

function allInFrom(suffix: string | undefined): boolean {
  return Boolean(suffix && /and is all-in/.test(suffix));
}

/**
 * Lines that carry neither pot nor card information.
 *
 * Kept short on purpose: GG's export is terse, and anything not listed here is
 * meant to raise `unknown-line` rather than be swallowed.
 */
const CHATTER_REGEX = new RegExp(
  [
    String.raw`\bsaid, "`,
    String.raw`\bjoins the table\b`,
    String.raw`\bleaves the table\b`,
    String.raw`\bis sitting out\b`,
    String.raw`\bsits out\b`,
    String.raw`\bhas returned\b`,
    String.raw`\bhas timed out\b`,
    String.raw`\bis (?:dis)?connected\b`,
    String.raw`\bwill be allowed to play after the button\b`,
    String.raw`\bdeclines straddle\b`,
    String.raw`\bfinished the tournament in\b`,
    String.raw`\breceived? a reward\b`,
    String.raw`\benters the table\b`,
  ].join("|"),
  "i",
);

/* ---------------------------------------------------------------- header -- */

interface Header {
  handId: string;
  product: string | null;
  payload: string;
  game: DraftGame;
  tournament: PhfTournament | null;
  playedAt: string | null;
}

function blindsFrom(stakesText: string, unit: CurrencyUnit): { sb: Amount; bb: Amount } {
  const match = stakesText.match(/^\s*(\S+?)\s*\/\s*(\S+)/);
  if (!match) {
    return { sb: 0, bb: parseAmount(stakesText.trim(), unit) };
  }
  return { sb: parseAmount(match[1], unit), bb: parseAmount(match[2], unit) };
}

/** `null` for a currency we cannot represent; the caller refuses the hand. */
function unitFor(stakesText: string): CurrencyUnit | null {
  return unitForStakes(stakesText, CHIPS);
}

/**
 * GG tournament headers.
 *
 * Three things differ from PokerStars, and all three break a PokerStars regex:
 *
 *   `Tournament #8205074, Daily Special $55 Hold'em No Limit - Level7 (150/300)`
 *   `Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)`
 *   `Tournament #9364957, WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10 (1,000/2,000)`
 *
 * 1. the tournament *name* sits between the id and the game label, where
 *    PokerStars prints no name at all;
 * 2. the level is an arabic numeral glued to the word - `Level14(300/600)`,
 *    sometimes `Level7 (150/300)` - where PokerStars writes `Level VII (...)`;
 * 3. the name is free text. It can contain a colon, a comma, brackets, commas
 *    inside numbers, a second money amount (`$25M GTD`), and even the words
 *    "No Limit Hold'em" - the WSOP header above contains the phrase twice.
 *
 * Point 3 is why the buy-in cannot be used to split name from label. The **game
 * label is a closed vocabulary and always sits last**, so it is matched from the
 * end and everything before it is the name; the buy-in is then the first money
 * token inside that name. Splitting on the first money token instead - which is
 * what the single forum-quoted sample suggested - reads the WSOP hand's name as
 * `WSOP #77:` and its label as `No Limit Hold'em Main Event [Flight W], $25M GTD
 * Hold'em No Limit`.
 */
const GAME_LABEL_TAIL = new RegExp(
  String.raw`\s((?:6\+\s*)?(?:Hold'?em|Omaha(?:\s*Hi/Lo)?|PLO(?:-\d)?|NLO\d?|Short\s?Deck|Stud|Razz|Badugi|Draw)` +
    String.raw`(?:\s*\([^)]*\))?(?:\s+(?:No Limit|Pot Limit|Fixed Limit|Limit))?(?:\s*\([^)]*\))?)\s*$`,
  "i",
);
/** A buy-in amount: `$55`, `$1,050`, `$4.50+$4.50+$1`, `2000+110`, `Freeroll`. */
const BUY_IN_TOKEN =
  /(?:^|\s)((?:[$€£]\s?[\d.,]+)(?:\+[$€£]?\s?[\d.,]+)*|\d[\d.,]*(?:\+\d[\d.,]*)+|Freeroll)(?=\s|$)/i;

function parseTournament(payload: string): { tournament: PhfTournament; game: DraftGame } | null {
  const match = payload.match(
    /^Tournament\s*(?:\(([^]*?)\))?\s*#(\S+?),\s*(.+?)\s+-\s+Level\s*([IVXLCDM]+|\d+)\s*\(([^)]*)\)\s+-\s+(.*)$/,
  );
  if (!match) {
    return null;
  }
  const [, parenName, id, body, levelLabel, levelStakes] = match;

  // Game label from the end, name from what is left, buy-in from inside it.
  const tail = body.match(GAME_LABEL_TAIL);
  const label = (tail ? tail[1] : body).trim();
  const namePart = (tail ? body.slice(0, body.length - tail[0].length) : "").trim();
  const buyInToken = namePart.match(BUY_IN_TOKEN)?.[1] ?? "";
  // A name that is nothing but the buy-in is not a name.
  const name = parenName ?? (namePart && namePart !== buyInToken ? namePart : null);

  // A symbol-less buy-in is play money, not dollars; see `buyInUnitFor`.
  const buyInUnit = buyInUnitFor(buyInToken, undefined);
  const buyInParts = parseBuyInToken(buyInToken, buyInUnit);
  const unit = unitFor(levelStakes);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(levelStakes, unit);
  const stakeParts = levelStakes.split("/");

  return {
    tournament: {
      id,
      name,
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
  const [, handId, payload] = match;
  const product = PRODUCT_PREFIXES[handId.slice(0, 2).toUpperCase()] ?? null;
  const playedAt = parsePlayedAt(payload);

  const tournament = parseTournament(payload);
  if (tournament) {
    return { handId, product, payload, ...tournament, playedAt };
  }

  const cash = payload.match(/^(.*?)\s*\(([^)]*)\)\s+-\s+(.*)$/);
  if (!cash) {
    return null;
  }
  const label = cash[1].trim();
  const unit = unitFor(cash[2]);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(cash[2], unit);
  return {
    handId,
    product,
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
  };
}

/* ---------------------------------------------------------------- parser -- */

function parseSummaryFees(line: string, unit: CurrencyUnit): PhfFees {
  const pick = (name: string) =>
    parseAmount(line.match(new RegExp(String.raw`${name} ${MONEY}`))?.[1], unit);
  return {
    ...ZERO_FEES,
    rake: pick("Rake"),
    jackpot: pick("Jackpot"),
    bingo: pick("Bingo"),
    fortune: pick("Fortune"),
    tax: pick("Tax"),
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
    throw new ParseSkip("normalized-unparseable", "The hand has no GG header line.");
  }

  if (header.game.variant !== "holdem") {
    throw new ParseSkip(
      "unsupported-variant",
      `${header.game.label} is not supported yet; the hand is kept for a future parser.`,
    );
  }
  if (ctx.options.cashOnly && header.tournament) {
    throw new ParseSkip(
      "tournament-in-cash-mode",
      "Tournament hand skipped because the converter is in cash-only mode.",
    );
  }

  const unit = header.game.unit;
  const draft = new StarsHandDraft({
    siteId: "ggpoker",
    siteName: "GGPoker",
    parserId: "ggpoker",
    parserVersion: GGPOKER_PARSER_VERSION,
    handId: header.handId,
    // GG ids already carry a product prefix and are unique across the network,
    // and rows stored before this parser existed used the id verbatim, so the
    // key stays equal to the id and a re-upload still dedupes.
    handKey: header.handId,
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
  });

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
        // `Total pot $170 Main pot $60. Side pot-1 $60. Side pot-2 $2.` - the
        // index goes after the word "pot", which is easy to get wrong.
        for (const entry of line
          .split("|")[0]
          .matchAll(new RegExp(String.raw`(Main|Side) pot(-\d+)? ${MONEY}\.`, "g"))) {
          pots.push({ name: `${entry[1]}${entry[2] ?? ""}`, amount: money(entry[3]) });
        }
        draft.summaryPot(money(pot[1]), pots, parseSummaryFees(line, unit));
        continue;
      }
      if (/^Hand was run (?:two|three|four) times$/i.test(line)) {
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
      // Rush & Cash is GG's fast-fold pool. It is identified from the product
      // code in the hand id or from the table name, never from the pretty
      // table names (`NLHPurple70`), which say nothing about the pool - and
      // `game.label` drops the distinction entirely on the way through
      // canonicalisation, which is why `PhfTable.fastFold` exists.
      const fastFold =
        header.product === "Rush & Cash" || /^RushAndCash/i.test(table[1] ?? "")
          ? "Rush & Cash"
          : null;
      draft.setTable(
        table[1] || null,
        Number(table[2]) || 0,
        table[4] ? Number(table[4]) : null,
        fastFold,
      );
      continue;
    }

    const seat = line.match(SEAT_REGEX);
    if (seat) {
      draft.seat(Number(seat[1]), seat[2], money(seat[3]), /\bsitting out\b/i.test(seat[4] ?? ""));
      continue;
    }

    const marker = line.match(MARKER_REGEX);
    if (marker) {
      const kind = marker[2].replace(/\s+/g, "").toUpperCase();
      const groups = [...marker[3].matchAll(/\[([^\]]*)\]/g)].map((m) => extractCards(m[1]));
      draft.marker(
        kind === "SHOWDOWN" ? "showdown" : (kind.toLowerCase() as "flop" | "turn" | "river"),
        runoutIndexForLabel(marker[1] ?? ""),
        marker[1] ?? "",
        groups[groups.length - 1] ?? [],
      );
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i.test(line)) {
      draft.holeCardsMarker();
      continue;
    }
    // A bomb-pot table announces itself, but the ante lines that follow read
    // exactly like any other ante, so the fact is carried on `game.bombPot`
    // (derived from "everyone anted and nobody posted a blind") rather than by
    // changing the action type - which would also change the text back out.
    if (/^\*\*\*\s*BOMB POT\s*\*\*\*/i.test(line)) {
      continue;
    }

    // `Dealt to <name> ` with a trailing space and no cards is GG's way of
    // saying "this seat was dealt in but we are not showing you its cards".
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

    const missed = line.match(new RegExp(String.raw`^(.+?): posts missed blind ${MONEY}$`));
    if (missed) {
      draft.post(missed[1], "missed-blind", money(missed[2]), { line: lineNo, rawLine: line });
      continue;
    }

    // GG's straddle verb has no `posts`: `27925b27: straddle $0.04`, and
    // `9e7f64d4: straddle $15.35 and is all-in` for an over-straddle that gets
    // the whole stack in. A parser expecting PokerStars' `posts straddle` reads
    // neither, and the money silently leaves the pot.
    const straddleLine = line.match(new RegExp(String.raw`^(.+?): straddle ${MONEY}${SUFFIX}$`));
    if (straddleLine) {
      draft.post(straddleLine[1], "straddle", money(straddleLine[2]), {
        allIn: allInFrom(straddleLine[3]),
        verb: "straddle",
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const post = line.match(
      new RegExp(String.raw`^(.+?): posts (straddle )?${MONEY}${SUFFIX}$`),
    );
    if (post) {
      const amount = money(post[3]);
      // An unnamed bare `posts` before the deal that is bigger than the big
      // blind is a straddle; anything smaller is dead money owed for a blind.
      const straddle =
        Boolean(post[2]) ||
        (draft.currentStreet() === "preflop" && amount > header.game.bigBlind);
      draft.post(post[1], straddle ? "straddle" : "missed-blind", amount, {
        allIn: allInFrom(post[4]),
        verb: post[2] ? "posts straddle" : undefined,
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const simple = line.match(/^(.+?): (folds|checks)$/);
    if (simple) {
      draft.simple(simple[1], simple[2] === "folds" ? "fold" : "check", {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const wager = line.match(new RegExp(String.raw`^(.+?): (calls|bets) ${MONEY}${SUFFIX}$`));
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

    // EV Cashout. The premium is settled with GG, not out of the pot, so both
    // events carry no money and only the SUMMARY records the risk paid.
    const cashoutChoose = line.match(/^(.+?): Chooses to EV Cashout$/);
    if (cashoutChoose) {
      draft.cashout(cashoutChoose[1], "cashout-choose", 0, { line: lineNo, rawLine: line });
      continue;
    }
    const cashoutPay = line.match(
      new RegExp(String.raw`^(.+?): Pays Cashout Risk \(${MONEY}\)$`),
    );
    if (cashoutPay) {
      draft.cashout(cashoutPay[1], "cashout-pay", money(cashoutPay[2]), {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    // All-in Insurance is a *separate* product from EV Cashout, not another
    // spelling of it: the player keeps their equity and pays a premium to hedge
    // it, rather than selling the equity outright. GG writes it as a pair -
    //
    //   `23aca38f: get an all-in insurance (premium ($0/$4/$0) for ($0/$10.8/$0) - (Mandatory/Main/Sub))`
    //   `23aca38f: pay premium of all-in insurance ($4)`
    //
    // - and like the cashout it settles with GG rather than out of the pot, so
    // it must not move any pot arithmetic. It is deliberately *not* mapped onto
    // `cashout-choose`/`cashout-pay`: those mean something else, and reporting
    // an insurance premium as cashout risk would put one product's money under
    // the other product's name in every downstream statistic. `ActionType` has
    // no member for it and gaining one is a `phf/2` change, so the events are
    // recorded verbatim as warnings - visible and attributable - and the hand
    // itself, whose pot is unaffected, still converts.
    const insurance = line.match(
      /^(.+?): (get an all-in insurance|pay premium of all-in insurance)\b(.*)$/,
    );
    if (insurance) {
      if (!draft.isSeated(insurance[1])) {
        draft.warn("unknown-line", line, lineNo);
        continue;
      }
      draft.warn("all-in-insurance", line, lineNo);
      continue;
    }

    // A house-funded chip drop: `Cash Drop to Pot : total $0.2`, printed
    // between the seat block and the blinds. The money enters the pot from
    // outside the player set, so it can be neither a contribution (that would
    // corrupt a seat's `net`) nor a negative fee (the replayer would pay out
    // more than the pot holds). `PhfChipMovement` is the home for exactly this:
    // chip conservation counts house-into-pot money, and the replayer seeds the
    // pot with it.
    const cashDrop = line.match(new RegExp(String.raw`^Cash Drop to Pot\s*:\s*total ${MONEY}$`, "i"));
    if (cashDrop) {
      draft.chipMovement({
        kind: "cash-drop",
        fromSeat: null,
        toPot: true,
        amount: money(cashDrop[1]),
        raw: line,
        anchor: "before-postings",
      });
      continue;
    }

    if (CHATTER_REGEX.test(line)) {
      continue;
    }

    draft.warn("unknown-line", line, lineNo);
  }

  if (draft.playerCount() === 0) {
    throw new ParseSkip("normalized-unparseable", "The hand has no seat lines.");
  }
  // GG names the observer seat literally "Hero"; the `Dealt to` line is the
  // fallback for exports that anonymise even the observer.
  if (draft.isSeated("Hero")) {
    draft.setHero("Hero");
  }

  const hand = draft.build();

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

/* ------------------------------------------------------------- the parser - */

export const ggpokerParser: SiteParser = {
  id: "ggpoker",
  name: "GGPoker",
  version: GGPOKER_PARSER_VERSION,

  detect(text: string): number {
    const head = stripBom(text);
    if (!HEADER_PREFIX.test(head) && !/(?:^|[\r\n])(?:GG\s*)?Poker Hand #/.test(head)) {
      return 0;
    }
    // Another room's branding in the same file always wins; a mixed upload is
    // better handled per chunk than claimed wholesale.
    if (FOREIGN_BRANDING.test(head)) {
      return 0;
    }

    // Why we outrank the generic reader at all, now that it parses GG's
    // tournament header correctly too: it has no *variant policy*. On the GG
    // corpus it emits 133 ShortDeck and Omaha hands that validate cleanly and
    // would be stored as if they were supported, where this parser refuses
    // them. Round one is Hold'em only and a wrong hand is worse than a refused
    // one, so GG text still has to reach the parser that says no.
    const ggTournament = /-\s*Level\s*(?:[IVXLCDM]+|\d+)\s*\(/.test(head);
    const ggProduct = /(?:^|[\r\n])(?:GG\s*)?Poker Hand #(?:RC|TM|SD|OM|PL|SG|BR)/i.test(head);
    if (
      GG_BRANDING.test(head) ||
      ggProduct ||
      GG_GAME_LABEL.test(head) ||
      GG_INSURANCE.test(head) ||
      ggTournament
    ) {
      return 0.95;
    }

    // The plain cash dialect. `standard` claims `Poker Hand #` at 0.9 and was
    // written against exactly this corpus (`gg-hh/`), so we stay underneath it
    // on purpose; this parser is still reachable with an explicit `siteId`.
    if (GG_FEE_LINE.test(head) || EV_CASHOUT.test(head)) {
      return 0.86;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return normalizeNewlines(stripBom(text))
      .split(/(?=^(?:GG\s*)?Poker Hand #)/m)
      .map((chunk) => stripBom(chunk).trim())
      .filter((chunk) => HEADER_PREFIX.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    return parseOneHand(raw, ctx);
  },
};
