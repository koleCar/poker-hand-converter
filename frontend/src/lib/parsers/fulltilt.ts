/**
 * Full Tilt Poker parser.
 *
 * Full Tilt is dead - seized in 2011, relaunched, folded into PokerStars and
 * shut down in 2016 - so this parser exists for archives, and the format is
 * fixed forever. It is PokerStars-family in *shape* but not in wording, and
 * every one of those differences is a way to get a hand silently wrong:
 *
 * - `Uncalled bet **of** $20 returned to X`, where PokerStars parenthesises the
 *   amount. A PokerStars regex simply does not match, and the hand then balances
 *   to a pot that is too big;
 * - `, and is all in` - three words, no hyphen;
 * - `, and is capped` on CAP tables, which is *not* all-in and must not set the
 *   flag;
 * - action lines carry no colon (`ElkY calls $10`), so table chat - which does
 *   (`pupsaa: idi0t lucker`) - is the only thing that looks like an action;
 * - the button line comes *after* the blinds, not before;
 * - two header word orders exist, 2011 and 2014, with the stakes and the game
 *   type swapped;
 * - run-it-twice numbers its markers (`*** RIVER 2 ***`, `*** SHOW DOWN 2 ***`)
 *   and prints a whole `*** SUMMARY 2 ***` block per runout;
 * - `Total pot $40 | Rake $0.50` has no promotional columns at all.
 *
 * **Tournaments are refused on purpose.** No tournament sample exists in the
 * corpus or anywhere public, and the reference parser the research came from
 * never implemented one, so there is nothing to write a grammar against.
 * Inventing one would produce hands that look right and are not.
 *
 * Fixtures: `fixtures/samples/full-tilt/`.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  DEFAULT_TEXT_STYLE,
  ZERO_FEES,
  parseAmount,
  type Amount,
  type CurrencyUnit,
  type LimitType,
  type PhfFees,
  type PhfHand,
} from "../phf/types";
import {
  MONEY,
  StarsHandDraft,
  detectDecimals,
  hasUnsupportedCurrency,
  normalizeNewlines,
  stripBom,
  toLines,
  unitForStakes,
  variantFromLabel,
  type DraftGame,
} from "./shared/p3-draft";

export const FULLTILT_PARSER_VERSION = "1.0.0";

const HEADER_REGEX = /^Full Tilt Poker Game #(\d+):\s*(.*)$/;
const HEADER_PREFIX = /^Full Tilt Poker Game #\d+:/;

/**
 * `Table Goldring (heads up) - NL Hold'em - $5/$10 - 21:11:15 ET - 2014/01/05`
 *
 * The tail is anchored on the time so that the middle can be matched greedily:
 * one fixture repeats the whole timestamp in brackets for a second timezone,
 * and only an anchored tail keeps the first one.
 */
const PAYLOAD_REGEX =
  /^Table (.+?)(?: \(([^)]*)\))? - (.+) - (\d{1,2}):(\d{2}):(\d{2}) ([A-Za-z]+) - (\d{4})\/(\d{2})\/(\d{2})(?: \[.*\])?\s*$/;

/** `$0.25/$0.50`, optionally with the ante the header sometimes appends. */
const STAKES = String.raw`([$€£]?[\d,]+(?:\.\d+)?\/[$€£]?[\d,]+(?:\.\d+)?(?:\s+Ante\s+[$€£]?[\d,]+(?:\.\d+)?)?)`;

/** `*** RIVER 2 *** [..] [..] (Total Pot: $625, 2 Players, 2 All-In)` */
const MARKER_REGEX = /^\*\*\*\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*(\d+)?\s*\*\*\*(.*)$/i;
/** `*** SUMMARY ***` and the per-runout `*** SUMMARY 2 ***`. */
const SUMMARY_REGEX = /^\*\*\*\s*SUMMARY\s*(\d+)?\s*\*\*\*/i;
/** Standard-text prefixes, so a re-serialized runout marker reads back. */
const RUN_PREFIXES = ["FIRST", "SECOND", "THIRD", "FOURTH"];

/**
 * Clauses Full Tilt appends to a wager.
 *
 * `and is capped` is a CAP-table clause: the player may not put any more in,
 * which is not the same thing as being all in, so it deliberately does not set
 * `allIn` (fixture 02).
 */
const SUFFIX = String.raw`((?:,? and is (?:all in|capped))*)`;

function allInFrom(suffix: string | undefined): boolean {
  return Boolean(suffix && /and is all in/.test(suffix));
}

/**
 * Lines that move no money and reveal no card.
 *
 * `adds $X` is a rebuy between hands: the chips are not in this pot and adding
 * them would break chip conservation. The rest are table state.
 */
const NOISE_REGEX = new RegExp(
  [
    String.raw`\bhas \d+ seconds left to act$`,
    String.raw`\bhas requested TIME$`,
    String.raw`\bhas been disconnected$`,
    String.raw`\bhas reconnected$`,
    String.raw`\bhas timed out$`,
    String.raw`\bstands up$`,
    String.raw`\bsits down$`,
    String.raw`\bis sitting out$`,
    String.raw`\bhas returned$`,
    String.raw`\bjoins the table\b`,
    String.raw`\bleaves the table\b`,
    String.raw`\badds ${MONEY}$`,
  ].join("|"),
);

/**
 * The limit, from either header generation.
 *
 * The shared `limitFromLabel` reads the PokerStars spelling (`Fixed Limit`) and
 * would call `FL Hold'em` no-limit, which changes how every bet in the hand is
 * interpreted downstream, so Full Tilt's two-letter codes are read here.
 */
function limitFromFullTiltLabel(label: string): LimitType {
  if (/\bFL\b|fixed\s*limit/i.test(label)) return "fl";
  if (/\bPL\b|pot\s*limit/i.test(label)) return "pl";
  if (/\bNL\b|no\s*limit/i.test(label)) return "nl";
  if (/\blimit\b/i.test(label)) return "fl";
  return "nl";
}

/** `(heads up)` -> 2, `(6 max, shallow)` -> 6, absent -> 9 (full ring). */
function maxSeatsFrom(seatDescription: string | undefined): number {
  if (!seatDescription) {
    return 9;
  }
  const max = seatDescription.match(/(\d+)\s*max/i);
  if (max) {
    return Number(max[1]);
  }
  return /heads up/i.test(seatDescription) ? 2 : 9;
}

interface Header {
  handId: string;
  tableName: string;
  maxSeats: number;
  game: DraftGame;
  playedAt: string | null;
  padHour: boolean;
}

function blindsFrom(stakesText: string, unit: CurrencyUnit): { sb: Amount; bb: Amount } {
  const match = stakesText.match(/^\s*(\S+)\/([^\s]+)/);
  if (!match) {
    return { sb: 0, bb: parseAmount(stakesText.trim(), unit) };
  }
  return { sb: parseAmount(match[1], unit), bb: parseAmount(match[2], unit) };
}

function parseHeader(line: string): Header | null {
  const match = line.match(HEADER_REGEX);
  if (!match) {
    return null;
  }
  const payload = match[2].match(PAYLOAD_REGEX);
  if (!payload) {
    return null;
  }
  const [, tableName, seatDescription, middle, hh, mm, ss, , year, month, day] = payload;

  // Two generations, distinguished by which half states the stakes. The test is
  // the stakes shape and not "does it contain a slash": `PL Omaha H/L` contains
  // one, and the reference parser's `Contains("/")` check gets that wrong.
  const oldOrder = middle.match(new RegExp(String.raw`^${STAKES}\s+-\s+(.+)$`));
  const newOrder = middle.match(new RegExp(String.raw`^(.+?)\s+-\s+${STAKES}$`));
  const stakesText = oldOrder ? oldOrder[1] : newOrder?.[2];
  const label = (oldOrder ? oldOrder[2] : newOrder?.[1])?.trim();
  if (!stakesText || !label) {
    return null;
  }

  const unit = unitForStakes(stakesText, CHIPS);
  if (!unit) {
    return null;
  }
  const blinds = blindsFrom(stakesText, unit);
  const date = new Date(`${year}-${month}-${day}T${hh.padStart(2, "0")}:${mm}:${ss}Z`);

  const limit = limitFromFullTiltLabel(label);
  return {
    handId: match[1],
    tableName,
    maxSeats: maxSeatsFrom(seatDescription),
    game: {
      variant: variantFromLabel(label),
      limit,
      format: "cash",
      label,
      unit,
      // A fixed-limit header states the small and big *bet*, not the blinds -
      // fixture 07 is a `$0.05/$0.10` table whose blinds are $0.02/$0.05 - so
      // the blinds are left to come from what was actually posted, which is what
      // `game.smallBlind`/`bigBlind` are defined to hold.
      smallBlind: limit === "fl" ? 0 : blinds.sb,
      bigBlind: limit === "fl" ? 0 : blinds.bb,
    },
    // The header says ET (or, in one anonymized fixture, CET). Converting it
    // would need a tz database this project does not ship, and mixing
    // conventions between parsers makes two hands from one session sort wrongly,
    // so the printed wall clock is kept as the instant - the same rule
    // `shared/ps-gg-hand.ts` uses for PokerStars and GG.
    playedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    padHour: hh.length === 2,
  };
}

function parseSummaryFees(line: string, unit: CurrencyUnit): PhfFees {
  // `Total pot $40 | Rake $0.50` - Full Tilt prints no promotional columns, so
  // the rest of `PhfFees` stays zero rather than being invented.
  return {
    ...ZERO_FEES,
    rake: parseAmount(line.match(new RegExp(String.raw`Rake ${MONEY}`))?.[1], unit),
  };
}

/**
 * Rewrites a SUMMARY seat line into the standard wording.
 *
 * Full Tilt says `folded before the Flop` where the family says `folded before
 * Flop`, and `didn't bet (folded)` where the family writes the same fact as a
 * preflop fold with a `(didn't bet)` marker. The shared summary reader is the
 * one that turns this prose into `PhfPlayerResult.outcome`, and an unrecognised
 * wording silently loses the fold street for every seat in the corpus.
 *
 * The rewritten line is what ends up on `PhfPlayerResult.raw`, which is what the
 * serializer re-emits - correctly, because the text we emit is the standard
 * dialect and not Full Tilt's. Full Tilt's own wording is never lost: the whole
 * hand is kept verbatim on `meta.rawText`.
 */
function normalizeSummarySeat(line: string): string {
  return line
    .replace(/\bfolded before the Flop\b/i, "folded before Flop")
    .replace(/\bdidn't bet \(folded\)/i, "folded before Flop (didn't bet)");
}

function parseOneHand(raw: string, ctx: SiteParserContext): PhfHand {
  const text = stripBom(raw).trim();
  const lines = toLines(text);
  if (hasUnsupportedCurrency(lines[0] ?? "")) {
    throw new ParseSkip(
      "unsupported-currency",
      `PHF has no unit for the currency in "${lines[0]}".`,
    );
  }
  if (lines.some((line) => /^Hand #\d+ has been cance?l?led\s*$/i.test(line.trim()))) {
    // The deal was voided and the blinds returned; there is nothing to convert.
    throw new ParseSkip("hand-cancelled", "Full Tilt cancelled the hand.");
  }

  const header = parseHeader(lines[0] ?? "");
  if (!header) {
    const first = lines[0] ?? "";
    // A tournament header names the tournament where a cash header names the
    // table. Full Tilt's tournament grammar was never recovered - not one real
    // sample exists - so it is refused by name instead of being guessed at.
    if (/\bTournament\b|\bSit & Go\b|\bMatch #/i.test(first)) {
      throw new ParseSkip(
        "tournament-unsupported",
        "Full Tilt's tournament hand format is unconfirmed - no real sample exists - " +
          "so the hand is kept rather than parsed with an invented grammar.",
      );
    }
    throw new ParseSkip(
      "normalized-unparseable",
      "The chunk has no readable Full Tilt Poker header line.",
    );
  }
  if (header.game.variant !== "holdem") {
    throw new ParseSkip(
      "unsupported-variant",
      `${header.game.label} is not supported yet; the hand is kept for a future parser.`,
    );
  }
  if (header.game.unit.kind === "chips") {
    // Play money and tournament chips print bare numbers. Neither is confirmed
    // for Full Tilt, and reading a chip amount as dollars is a hundredfold error.
    throw new ParseSkip(
      "unsupported-currency",
      "The hand states no currency, so it is chips - play money or a tournament - " +
        "neither of which is confirmed for Full Tilt.",
    );
  }

  const unit = header.game.unit;
  const money = (value: string | undefined) => parseAmount(value, unit);
  const draft = new StarsHandDraft({
    siteId: "fulltilt",
    siteName: "Full Tilt Poker",
    parserId: "fulltilt",
    parserVersion: FULLTILT_PARSER_VERSION,
    handId: header.handId,
    // Full Tilt ids are bare integers, so they are namespaced to keep them from
    // colliding with another room's numeric ids in `stored_hands.hand_key`.
    handKey: `FT${header.handId}`,
    rawText: text,
    originalFilename: ctx.sourceFilename,
    game: header.game,
    tournament: null,
    playedAt: header.playedAt,
    textStyle: {
      ...DEFAULT_TEXT_STYLE,
      decimals: detectDecimals(text),
      padHour: header.padHour,
    },
  });

  const seatNames = new Map<number, string>();
  const collectors = new Set<string>();
  let buttonSeat: number | null = null;
  let summaryBlock = -1;
  let totalPot = 0;
  let fees: PhfFees = { ...ZERO_FEES };
  let sawSummary = false;
  let collapsedSummaries = false;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const lineNo = i + 1;
    if (!line) {
      continue;
    }

    const summaryMarker = line.match(SUMMARY_REGEX);
    if (summaryMarker) {
      summaryBlock = summaryMarker[1] ? Number(summaryMarker[1]) : 0;
      sawSummary = true;
      continue;
    }

    if (summaryBlock >= 0) {
      const pot = line.match(new RegExp(String.raw`^Total pot ${MONEY}`));
      if (pot) {
        totalPot = money(pot[1]);
        fees = parseSummaryFees(line, unit);
        continue;
      }
      // `Pot 1 $311` heads a per-runout summary block. It restates what the
      // `wins pot 1` line already said, and it is not a side pot - both runouts
      // are the same pot, split - so recording it under `results.pots` would
      // describe a table that never existed.
      if (new RegExp(String.raw`^Pot \d+ ${MONEY}$`).test(line)) {
        continue;
      }
      const board = line.match(/^Board:?\s*\[([^\]]*)\]/i);
      if (board) {
        draft.summaryBoard(Math.max(summaryBlock - 1, 0), extractCards(board[1]));
        continue;
      }
      const seat = line.match(/^Seat (\d+): (.*)$/);
      if (seat) {
        const name = seatNames.get(Number(seat[1])) ?? "";
        if (/\bis sitting out$/i.test(seat[2])) {
          draft.markSittingOut(name);
        }
        // A run-it-twice hand describes each seat once per runout, and the two
        // descriptions contradict each other for anyone who won one pot and lost
        // the other. PHF carries one result per seat, so the first block's prose
        // is kept for the seats it cannot be wrong about, and a collector's
        // outcome is left to come from its collect lines, which are authoritative
        // across both runouts.
        if (summaryBlock <= 1 && !(summaryBlock === 1 && collectors.has(name))) {
          draft.summarySeat(Number(seat[1]), normalizeSummarySeat(line));
        }
        if (summaryBlock > 1) {
          collapsedSummaries = true;
        }
        continue;
      }
      if (NOISE_REGEX.test(line)) {
        continue;
      }
      draft.warn("unknown-summary-line", line, lineNo);
      continue;
    }

    const seat = line.match(new RegExp(String.raw`^Seat (\d+): (.+?) \(${MONEY}\)(.*)$`));
    if (seat) {
      seatNames.set(Number(seat[1]), seat[2]);
      draft.seat(
        Number(seat[1]),
        seat[2],
        money(seat[3]),
        /\bis sitting out\b/i.test(seat[4] ?? ""),
      );
      continue;
    }

    const button = line.match(/^The button is in seat #(\d+)\s*$/i);
    if (button) {
      // Full Tilt states the button *after* the blinds, so the table is set once
      // the whole hand has been read.
      buttonSeat = Number(button[1]);
      continue;
    }

    const marker = line.match(MARKER_REGEX);
    if (marker) {
      const kind = marker[1].replace(/\s+/g, "").toUpperCase();
      const runoutIndex = marker[2] ? Number(marker[2]) - 1 : 0;
      // Full Tilt numbers its runout markers (`*** RIVER 2 ***`) where the
      // standard text words them (`*** SECOND RIVER ***`). The label is stored in
      // the standard vocabulary so the hand can be re-serialized and read back.
      const label = marker[2] ? (RUN_PREFIXES[runoutIndex] ?? "") : "";
      const groups = [...marker[3].matchAll(/\[([^\]]*)\]/g)].map((m) => extractCards(m[1]));
      draft.marker(
        kind === "SHOWDOWN" ? "showdown" : (kind.toLowerCase() as "flop" | "turn" | "river"),
        runoutIndex,
        label,
        groups[groups.length - 1] ?? [],
      );
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i.test(line)) {
      draft.holeCardsMarker();
      continue;
    }

    const dealt = line.match(/^Dealt to (.+?) \[([^\]]*)\]\s*$/);
    if (dealt) {
      draft.dealt(dealt[1], extractCards(dealt[2]));
      continue;
    }

    const blind = line.match(
      new RegExp(String.raw`^(.+?) posts (?:a (dead) )?(?:the )?(small|big) blind of ${MONEY}$`),
    );
    if (blind) {
      // A dead blind is not live money: it goes to the pot without counting
      // toward the bet the table has to match.
      draft.post(
        blind[1],
        blind[2]
          ? "missed-blind"
          : blind[3].toLowerCase() === "small"
            ? "small-blind"
            : "big-blind",
        money(blind[4]),
        { line: lineNo, rawLine: line, verb: blind[2] ? "posts dead blind" : undefined },
      );
      continue;
    }

    const ante = line.match(new RegExp(String.raw`^(.+?) antes ${MONEY}$`));
    if (ante) {
      draft.post(ante[1], "ante", money(ante[2]), { line: lineNo, rawLine: line });
      continue;
    }

    const deadPost = line.match(new RegExp(String.raw`^(.+?) posts ${MONEY}$`));
    if (deadPost && draft.isSeated(deadPost[1])) {
      // A player re-entering the table owes dead money; Full Tilt has no
      // straddle, so a bare `posts` is never live.
      draft.post(deadPost[1], "missed-blind", money(deadPost[2]), {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const uncalled = line.match(
      new RegExp(String.raw`^(?:Uncalled bet|Ante) of ${MONEY} returned to (.+)$`),
    );
    if (uncalled) {
      draft.uncalled(uncalled[2].trim(), money(uncalled[1]), { line: lineNo, rawLine: line });
      continue;
    }

    // `X wins the pot ($39.50)`, `X wins pot 2 ($311) with ...`, and the hi/lo
    // `X wins the high pot ($61.55)`. The trailing `with <description>` repeats
    // what the SUMMARY block states per seat, so it is not stored twice.
    const wins = line.match(
      new RegExp(String.raw`^(.+?) wins (?:the (high |low )?pot|pot (\d+)) \(${MONEY}\)(?: with .+)?$`),
    );
    if (wins && draft.isSeated(wins[1])) {
      const potName = wins[3] ? `pot ${wins[3]}` : `${wins[2] ?? ""}pot`;
      collectors.add(wins[1]);
      draft.collect(wins[1], money(wins[4]), potName, { line: lineNo, rawLine: line });
      continue;
    }

    const simple = line.match(/^(.+?) (folds|checks)$/);
    if (simple && draft.isSeated(simple[1])) {
      draft.simple(simple[1], simple[2] === "folds" ? "fold" : "check", {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const wager = line.match(new RegExp(String.raw`^(.+?) (bets|calls) ${MONEY}${SUFFIX}$`));
    if (wager && draft.isSeated(wager[1])) {
      draft.wager(wager[1], wager[2] === "calls" ? "call" : "bet", money(wager[3]), {
        allIn: allInFrom(wager[4]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const raise = line.match(new RegExp(String.raw`^(.+?) raises to ${MONEY}${SUFFIX}$`));
    if (raise && draft.isSeated(raise[1])) {
      draft.raiseTo(raise[1], money(raise[2]), {
        allIn: allInFrom(raise[3]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const mucks = line.match(/^(.+?) mucks$/);
    if (mucks && draft.isSeated(mucks[1])) {
      // The standard text spells a muck `mucks hand`; keeping Full Tilt's own
      // wording here would emit a line our own reader could not read back.
      draft.muck(mucks[1], "mucks hand", { line: lineNo, rawLine: line });
      continue;
    }

    // `X shows [Jd Qd]` at the point of an all-in, and `X shows two pair,
    // Queens and Threes` at each numbered showdown - the second shape reveals no
    // cards, only the ranking, and both are genuine showdown reveals.
    const shows = line.match(/^(.+?) shows(?: \[([^\]]*)\])?(?: (.+))?$/);
    if (shows && draft.isSeated(shows[1]) && (shows[2] !== undefined || shows[3] !== undefined)) {
      draft.show(shows[1], shows[2] ? extractCards(shows[2]) : [], shows[3], {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    if (/^Players agree to Run It Twice$/i.test(line)) {
      draft.noteRunItTwice();
      continue;
    }

    if (NOISE_REGEX.test(line)) {
      const sittingOut = line.match(/^(.+?) is sitting out$/i);
      if (sittingOut) {
        draft.markSittingOut(sittingOut[1]);
      }
      continue;
    }

    // Table chat. Action lines carry no colon on this site, so a line whose
    // prefix up to the first colon is a seated player is chat and nothing else
    // (`pupsaa: idi0t lucker`, fixture 14).
    const chat = line.match(/^(.+?): /);
    if (chat && draft.isSeated(chat[1])) {
      continue;
    }

    draft.warn("unknown-line", line, lineNo);
  }

  if (draft.playerCount() === 0) {
    // Fixture 13 is a header and a SUMMARY block with no seat listing at all.
    // The seats it names have no stacks, so no hand can be reconstructed.
    throw new ParseSkip(
      "no-seat-block",
      "The hand has no seat listing, so there is nothing to attribute the action to.",
    );
  }

  draft.setTable(header.tableName, header.maxSeats, buttonSeat);
  if (sawSummary) {
    draft.summaryPot(totalPot, [], fees);
  }
  if (collapsedSummaries) {
    draft.warn(
      "run-it-twice-summary",
      "The hand printed one SUMMARY block per runout; the per-seat prose of the first " +
        "was kept and the winners' outcomes come from their collect lines.",
    );
  }

  const hand = draft.build();

  // A collect belongs to the runout its pot number names, but the draft tags
  // every action with the runout of the last marker it saw - and Full Tilt
  // prints both `wins pot 1` and `wins pot 2` after `*** SHOW DOWN 2 ***`.
  for (const action of hand.actions) {
    const numbered = /^pot (\d+)$/.exec(action.potName ?? "");
    if (action.type === "collect" && numbered) {
      action.runoutIndex = Math.max(Number(numbered[1]) - 1, 0);
    }
  }
  hand.results.winners = hand.actions
    .filter((action) => action.type === "collect")
    .map((action) => ({
      player: action.player,
      seat: action.seat,
      amount: action.amount,
      runoutIndex: action.runoutIndex,
    }));

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

export const fulltiltParser: SiteParser = {
  id: "fulltilt",
  name: "Full Tilt Poker",
  version: FULLTILT_PARSER_VERSION,

  detect(text: string): number {
    // No other room writes this header, and it opens every hand in the corpus.
    if (/^Full Tilt Poker Game #\d+:/m.test(stripBom(text))) {
      return 0.95;
    }
    if (/\bFull Tilt Poker\b/.test(text)) {
      return 0.3;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    // Hands are separated by two blank lines, but every hand also repeats the
    // header, so splitting on the header handles both that file and a file
    // someone has concatenated by hand.
    return normalizeNewlines(stripBom(text))
      .split(/(?=^Full Tilt Poker Game #\d+:)/m)
      .map((chunk) => stripBom(chunk).trim())
      .filter((chunk) => HEADER_PREFIX.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    return parseOneHand(raw, ctx);
  },
};
