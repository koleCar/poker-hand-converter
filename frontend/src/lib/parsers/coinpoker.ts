/**
 * CoinPoker parser.
 *
 * CoinPoker is a PokerStars-family text grammar - `Seat N: name (x in chips)`,
 * `*** FLOP *** [..]`, `Uncalled bet (x) returned to y`, `*** SUMMARY ***` - so
 * the *semantics* come from `shared/ps-gg-hand.ts` (raise-to commitment
 * arithmetic, uncalled netting, SUMMARY prose, runout assembly, results) and
 * only the line grammar lives here. Route B from the spec, building the object
 * through `StarsHandDraft` rather than normalizing to standard text first: the
 * divergences below change *numbers*, not just strings, so a text intermediate
 * would have to invent a `raises X to Y` for CoinPoker's all-in raise form
 * before anything had verified the arithmetic.
 *
 * What is genuinely different, in the order it will bite a naive parser:
 *
 *  - `p: raises 4987 and is all-in` carries **one** amount and no `to`, and that
 *    amount is the chips *added*, not the total. Both forms occur in one hand.
 *  - Amounts carry **no currency symbol at all**. The currency is USDT, stated
 *    nowhere except the `₮` glyph in cash table names. See `CASH_UNIT`.
 *  - The stakes group has a trailing space, `(0.01/0.02 )`, and there is no
 *    ` - ` before the timestamp.
 *  - Seat lines carry a suffix *after* the closing paren: `(2.00 in chips)
 *    out of hand`.
 *  - Hands are separated by **one** blank line, not two.
 *  - `*** HAND CANCELLED ***` refunds every stake through SUMMARY-only
 *    `collected (n)` lines; it is refused rather than converted.
 *
 * Every non-obvious branch names the fixture that forced it. The fixtures are in
 * `fixtures/samples/coinpoker/`, all 16 real and byte-verified; the format notes
 * are in `docs/research/hh-formats/coinpoker.md`.
 */

import { extractCards } from "../cards";
import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  DEFAULT_TEXT_STYLE,
  ZERO_FEES,
  parseAmount,
  unitForCode,
  type CurrencyUnit,
  type PhfHand,
  type PhfPlayerResult,
  type PhfTournament,
} from "../phf/types";
import {
  StarsHandDraft,
  limitFromLabel,
  parsePlayedAt,
  parseSummarySeat,
  stripBom,
  toLines,
  variantFromLabel,
  type DraftGame,
} from "./shared/ps-gg-hand";

export const COINPOKER_PARSER_VERSION = "1.0.0";

/**
 * The unit every cash amount in a CoinPoker hand is denominated in.
 *
 * CoinPoker is crypto-denominated: the tables are priced in **USDT** and the
 * text prints no symbol anywhere, so the currency is only inferable from the
 * `₮` (U+20AE) glyph in the table name. Two decisions are baked in here and
 * both are deliberate:
 *
 * 1. **`minorUnits: 100` is exact, not a rounding.** Every decimal amount in
 *    the corpus - stakes, stacks, bets, pots, rake - has exactly two decimal
 *    places. USDT carries six decimals on chain, but the client settles tables
 *    in hundredths and never prints more. `assertRepresentable` refuses any
 *    hand that does print more rather than letting `parseAmount` round it,
 *    because a silently mis-scaled amount validates perfectly against itself.
 * 2. **The symbol is `$`, not `₮`.** The code records the real currency, which
 *    is the part that carries information. The symbol is presentation, and it
 *    has to be one `toStandardText` can write and `parseStandardText` can read
 *    back: `serialize.ts` resolves a unit from the glyph and knows only `$`,
 *    `€` and `£`, so emitting `₮0.02` would come back as *two chips* rather
 *    than two cents. USDT is dollar-pegged 1:1, so `$` is also the honest
 *    display. See the report note on `unitForSymbol`.
 */
const CASH_UNIT: CurrencyUnit = unitForCode("USDT", "$");

/** Cheap prefix test used by `detect` and `splitHands`; kept in sync by hand. */
const HEADER_PREFIX = /^CoinPoker Hand #\d+:/;
const HEADER_REGEX = /^CoinPoker Hand #(\d+): (.*)$/;

/** `YYYY/MM/DD HH:MM:SS GMT`, the only timestamp shape the corpus contains. */
const STAMP = String.raw`\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}`;

/**
 * Bare decimal with at most two places.
 *
 * Deliberately strict where the family's shared `MONEY` is permissive. A room
 * that prints no currency symbol gives a money regex nothing to anchor on, so
 * the guard against a mis-scaled amount has to be the digit grammar itself; a
 * third decimal place fails to match here and is then caught, loudly, by
 * `assertRepresentable`.
 */
const NUM = String.raw`(\d+(?:\.\d{1,2})?)`;

/** `Hold'em No Limit (0.01/0.02 ) 2025/06/19 18:53:04 GMT` - note the space. */
const CASH_REGEX = new RegExp(
  String.raw`^(.+?) \(${NUM}/${NUM} \) (${STAMP}) GMT$`,
);

/**
 * `Tournament #1287469, <name> <game> (50/100 ante 13 play) <stamp> GMT`.
 *
 * The name and the game label are captured as one group and split afterwards:
 * tournament names contain commas, `₮`, digits and free text
 * (`₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD`), so neither a comma
 * split nor a leftmost game-type match can find the boundary.
 */
const TOUR_REGEX = new RegExp(
  String.raw`^Tournament #(\d+), (.+) \((\d+)/(\d+)(?: ante (\d+))?(?: play)?\) (${STAMP}) GMT$`,
);

/**
 * The game label, matched from the right-hand end of `<name> <game>`.
 *
 * `.*?` is lazy so the split lands at the earliest position where the tail is a
 * complete game label, which is what keeps `... Mini Dojo PKO, 15 Seats GTD` on
 * the name side. Only `Hold'em No Limit` occurs in the corpus; the other
 * variants are listed so an Omaha hand is refused as `unsupported-variant`
 * rather than as an unparseable header.
 */
const TOUR_NAME_AND_LABEL =
  /^(.*?)\s*((?:\d[\s-]*Card\s+)?(?:Hold'?em|Omaha(?:\s+Hi\/Lo)?|Short\s*Deck|Stud(?:\s+Hi\/Lo)?|Razz|Badugi|(?:Triple\s+)?Draw)(?:\s+(?:No|Pot|Fixed)\s+Limit|\s+Limit)?)$/;

const TABLE_REGEX = /^Table '(.*)' (\d+)-max Seat #(\d+) is the button$/;

/** The suffix after the closing paren is the trap; `in chips\)$` loses ~7%. */
const SEAT_REGEX = new RegExp(
  String.raw`^Seat (\d+): (.+?) \(${NUM} in chips\)(?: (is sitting out|out of hand))?$`,
);

const MARKER_REGEX = /^\*\*\*\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i;

/**
 * Lines that carry neither pot nor card information.
 *
 * Kept to exactly what the corpus contains. An unlisted shape has to raise
 * `unknown-line` rather than be swallowed, which is what
 * `backend/test/coinpokerParser.test.ts` asserts over the whole corpus - so a
 * new CoinPoker line shape fails the build rather than the user.
 */
const CHATTER_REGEX =
  /\bhas timed out$|\bis disconnected$|\bhas reconnected$|\bactivated time-bank \(\d+ seconds?\)$|: didn't post (?:small|big) blind$/;

/** `Seat 3: donkme123 (straddle) showed [3h Ts]` - a fourth position token. */
const STRADDLE_TAG = /^(Seat \d+: .*?)( \(straddle\))(.*)$/;

/* --------------------------------------------------------------- header --- */

interface Header {
  handId: string;
  payload: string;
  game: DraftGame;
  tournament: PhfTournament | null;
  playedAt: string | null;
}

function parseHeader(line: string): Header | null {
  const match = line.match(HEADER_REGEX);
  if (!match) {
    return null;
  }
  const [, handId, payload] = match;
  const playedAt = parsePlayedAt(payload);

  const tour = payload.match(TOUR_REGEX);
  if (tour) {
    const [, id, nameAndLabel, sb, bb, ante] = tour;
    const split = nameAndLabel.match(TOUR_NAME_AND_LABEL);
    if (!split) {
      // Refusing beats guessing: without a game label we cannot tell whether
      // this is Hold'em, and the name would absorb the variant.
      return null;
    }
    const label = split[2];
    return {
      handId,
      payload,
      game: {
        variant: variantFromLabel(label),
        limit: limitFromLabel(label),
        format: "tournament",
        label,
        // Tournament stacks are chips: bare integers, one minor unit each.
        unit: CHIPS,
        smallBlind: parseAmount(sb, CHIPS),
        bigBlind: parseAmount(bb, CHIPS),
      },
      tournament: {
        id,
        name: split[1] || null,
        // CoinPoker's header states no buy-in at all, only the tournament name.
        // `₮0.10 Mega Sat to ₮1 Mini Dojo PKO` names two amounts and neither is
        // unambiguously the entry fee, so nothing is parsed out of it; the
        // caller flags the gap instead. See `parseOneHand`.
        buyIn: 0,
        bounty: 0,
        fee: 0,
        buyInUnit: CASH_UNIT,
        // No level number is printed either, only the blinds in force.
        levelLabel: null,
        levelNumber: null,
        levelSmallBlind: parseAmount(sb, CHIPS),
        levelBigBlind: parseAmount(bb, CHIPS),
        levelAnte: parseAmount(ante, CHIPS),
        bounties: [],
      },
      playedAt,
    };
  }

  const cash = payload.match(CASH_REGEX);
  if (!cash) {
    return null;
  }
  const label = cash[1].trim();
  return {
    handId,
    payload,
    game: {
      variant: variantFromLabel(label),
      limit: limitFromLabel(label),
      format: "cash",
      label,
      unit: CASH_UNIT,
      smallBlind: parseAmount(cash[2], CASH_UNIT),
      bigBlind: parseAmount(cash[3], CASH_UNIT),
    },
    tournament: null,
    playedAt,
  };
}

/* ------------------------------------------------------------ precision --- */

/**
 * Refuses a hand whose amounts cannot be held exactly in the unit's minor units.
 *
 * This is the one guard the whole file exists to protect. CoinPoker prints bare
 * decimals with no symbol, so a permissive money regex matches *anything*
 * numeric: a hand denominated in thousandths would match every line, balance
 * against its own pot, pass the validator, and arrive in Holdem Manager wrong by
 * a factor of ten with nothing to show for it. Everything the corpus contains is
 * two-decimal cash or integer chips; anything else is refused and kept for a
 * parser that can represent it.
 *
 * The header line is excluded because the tournament *name* legitimately
 * contains amounts (`₮0.10 Mega Sat to ₮1 ...`) that are not hand money.
 */
function assertRepresentable(lines: string[], unit: CurrencyUnit): void {
  // Anchored on the space or `(` that always precedes an amount in this format,
  // so a screen name that happens to contain a decimal is not mistaken for one.
  const tooPrecise =
    unit.minorUnits === 1 ? /(?:^|[\s(])\d+\.\d/ : /(?:^|[\s(])\d+\.\d{3,}/;
  for (let i = 1; i < lines.length; i += 1) {
    const match = lines[i].match(tooPrecise);
    if (match) {
      throw new ParseSkip(
        "unsupported-precision",
        `"${match[0]}" needs more precision than ${unit.code} gives (1/${unit.minorUnits}); ` +
          "the hand is kept rather than rounded.",
      );
    }
  }
}

/* --------------------------------------------------------------- parser --- */

/**
 * Re-classifies a SUMMARY seat line that carries CoinPoker's `(straddle)` tag.
 *
 * The shared summary reader knows the three PokerStars position words and stops
 * at anything else, so `Seat 3: donkme123 (straddle) showed [3h Ts]` reads as an
 * unclassified line. The tag is lifted out, the remainder is handed back to the
 * shared reader, and the tag itself is kept on `positionLabels` so the
 * regenerated line still names the straddler.
 */
function applyStraddleTag(result: PhfPlayerResult, unit: CurrencyUnit): void {
  const match = result.raw?.match(STRADDLE_TAG);
  if (!match) {
    return;
  }
  const parsed = parseSummarySeat(`${match[1]}${match[3]}`, result.player, unit);
  result.positionLabels = ["(straddle)"];
  result.outcome = parsed.outcome ?? result.outcome;
  result.handDescription = parsed.handDescription ?? result.handDescription;
  result.mucked = parsed.mucked ?? result.mucked;
  result.foldedStreet = parsed.foldedStreet ?? null;
  result.didntBet = parsed.didntBet ?? false;
  if ((parsed.shownCards?.length ?? 0) > 0) {
    result.shownCards = parsed.shownCards ?? result.shownCards;
  }
}

function parseOneHand(raw: string, ctx: SiteParserContext): PhfHand {
  const text = stripBom(raw).trim();
  const lines = toLines(text);

  const header = parseHeader(lines[0] ?? "");
  if (!header) {
    throw new ParseSkip("normalized-unparseable", "The hand has no CoinPoker header line.");
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
  // `*** HAND CANCELLED ***` voids the deal: `All bets returned (1310)` is
  // followed by an empty `Board [ ]` and a per-seat refund written with the
  // *winner's* verb, `collected (n)`, with no matching action line anywhere in
  // the stream. There is no hand to convert and the refunds are not winnings,
  // so it is refused rather than reported as a seven-way split pot
  // (fixture 15).
  if (lines.some((line) => /^\*\*\*\s*HAND CANCELLED\s*\*\*\*/i.test(line.trim()))) {
    throw new ParseSkip("hand-cancelled", "CoinPoker cancelled the hand and refunded every stake.");
  }

  const unit = header.game.unit;
  assertRepresentable(lines, unit);

  const draft = new StarsHandDraft({
    siteId: "coinpoker",
    siteName: "CoinPoker",
    parserId: "coinpoker",
    parserVersion: COINPOKER_PARSER_VERSION,
    handId: header.handId,
    // CoinPoker ids are bare integers, so they are namespaced to keep them from
    // colliding with another room's numeric ids in `stored_hands.hand_key`.
    handKey: `CP${header.handId}`,
    rawText: text,
    originalFilename: ctx.sourceFilename,
    game: header.game,
    tournament: header.tournament,
    playedAt: header.playedAt,
    textStyle: {
      ...DEFAULT_TEXT_STYLE,
      // Not detected: CoinPoker prints exactly two decimals on every cash
      // amount, including round ones (`2.00 in chips`, `Rake 0.00`).
      decimals: "fixed2",
      padHour: true,
    },
    // CoinPoker omits the `Uncalled bet` line when the last aggressor was
    // all-in and nobody called (fixture 13: `raises 4887 and is all-in`, both
    // opponents fold, no return printed). It is *not* an export bug: the
    // reported pot includes the overbet and the winner collects all of it, so
    // the hand balances and the net per player is right. Repairing it would
    // invent a return the room never made.
    repairMissingUncalled: false,
  });

  if (header.tournament && !/freeroll/i.test(header.tournament.name ?? "")) {
    // The buy-in is genuinely absent from the format. Flagged rather than
    // guessed from the name, because `tournament.buyIn` is the denominator ROI
    // is computed against and a plausible-looking wrong number is worse there
    // than a zero that says so.
    draft.warn(
      "buy-in-not-stated",
      `CoinPoker's header states no buy-in for "${header.tournament.name}"; ` +
        "tournament.buyIn is 0.",
    );
  }

  const money = (value: string | undefined) => parseAmount(value, unit);
  let inSummary = false;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const lineNo = i + 1;
    if (!line) {
      continue;
    }

    if (/^\*\*\*\s*SUMMARY\s*\*\*\*/i.test(line)) {
      inSummary = true;
      continue;
    }

    if (inSummary) {
      // Two fields only - no Jackpot/Bingo/Fortune/Tax columns, and no
      // Main/Side breakdown even on the hand that pays a side pot (fixture 14).
      const pot = line.match(new RegExp(String.raw`^Total pot ${NUM} \| Rake ${NUM}$`));
      if (pot) {
        draft.summaryPot(money(pot[1]), [], { ...ZERO_FEES, rake: money(pot[2]) });
        continue;
      }
      // `Board [ Jd 6c 5h 5c ]` is space padded inside the brackets while the
      // street markers of the same hand are not; `Board [ ]` appears on hands
      // that never saw a flop. `extractCards` is whitespace agnostic.
      const board = line.match(/^Board \[([^\]]*)\]$/);
      if (board) {
        draft.summaryBoard(0, extractCards(board[1]));
        continue;
      }
      // CoinPoker-only, and a good corroborating detection signal.
      if (new RegExp(String.raw`^Game ended: ${STAMP} GMT$`).test(line)) {
        continue;
      }
      const seat = line.match(/^Seat (\d+):/);
      if (seat) {
        draft.summarySeat(Number(seat[1]), line);
        continue;
      }
      draft.warn("unknown-summary-line", line, lineNo);
      continue;
    }

    const table = line.match(TABLE_REGEX);
    if (table) {
      draft.setTable(table[1] || null, Number(table[2]) || 0, Number(table[3]));
      continue;
    }

    const seat = line.match(SEAT_REGEX);
    if (seat) {
      // Both suffixes mean the same thing for our purposes: the seat is
      // occupied but was not dealt into this hand. `assignPositions` reads the
      // ring off the action stream, so a seat that never acts drops out of it
      // on its own (fixture 10 has one of each).
      draft.seat(Number(seat[1]), seat[2], money(seat[3]), Boolean(seat[4]));
      continue;
    }

    const marker = line.match(MARKER_REGEX);
    if (marker) {
      const kind = marker[1].replace(/\s+/g, "").toUpperCase();
      if (kind === "SHOWDOWN") {
        draft.marker("showdown", 0, "", []);
        continue;
      }
      // `*** TURN *** [Jd 6c 5h] [5c]` restates the board, so the last bracket
      // group is the card actually dealt.
      const groups = [...marker[2].matchAll(/\[([^\]]*)\]/g)].map((m) => extractCards(m[1]));
      draft.marker(
        kind.toLowerCase() as "flop" | "turn" | "river",
        0,
        "",
        groups[groups.length - 1] ?? [],
      );
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS\s*\*\*\*$/i.test(line)) {
      draft.holeCardsMarker();
      continue;
    }

    // CoinPoker never anonymises and has no `Hero` literal, so this line is the
    // only thing that identifies the observer.
    const dealt = line.match(/^Dealt to (.+?) \[([^\]]*)\]$/);
    if (dealt) {
      draft.dealt(dealt[1], extractCards(dealt[2]));
      continue;
    }

    const uncalled = line.match(
      new RegExp(String.raw`^Uncalled bet \(${NUM}\) returned to (.+)$`),
    );
    if (uncalled) {
      draft.uncalled(uncalled[2], money(uncalled[1]), { line: lineNo, rawLine: line });
      continue;
    }

    // `... from pot` and `... from side-pot 1`. The hyphen is why a corpus grep
    // for "side pot" reports that CoinPoker has none; fixture 14 pays one.
    const collected = line.match(new RegExp(String.raw`^(.+?) collected ${NUM} from (.+)$`));
    if (collected) {
      draft.collect(collected[1], money(collected[2]), collected[3], {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const ante = line.match(new RegExp(String.raw`^(.+?): posts the ante ${NUM}( and is all-in)?$`));
    if (ante) {
      draft.post(ante[1], "ante", money(ante[2]), {
        allIn: Boolean(ante[3]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    // A dead blind from a player who is buying back in: it goes straight to the
    // pot and does not count toward the current bet, so the same player's later
    // `calls 0.06` is a full call rather than a completion (fixture 10).
    const deadBlind = line.match(
      new RegExp(String.raw`^(.+?): posts (?:small|big) blind \(dead\) ${NUM}$`),
    );
    if (deadBlind) {
      draft.post(deadBlind[1], "missed-blind", money(deadBlind[2]), {
        verb: "posts small blind (dead)",
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    // A second `posts big blind` in one hand is a returning player posting to be
    // dealt in (fixtures 06 and 11); it is live, and they check behind it.
    // `assignPositions` takes the *first* posting of each blind, so the ring is
    // unaffected.
    const blind = line.match(
      new RegExp(String.raw`^(.+?): posts (small|big) blind ${NUM}( and is all-in)?$`),
    );
    if (blind) {
      draft.post(
        blind[1],
        blind[2] === "small" ? "small-blind" : "big-blind",
        money(blind[3]),
        { allIn: Boolean(blind[4]), line: lineNo, rawLine: line },
      );
      continue;
    }

    const straddle = line.match(new RegExp(String.raw`^(.+?): posts straddle ${NUM}$`));
    if (straddle) {
      draft.post(straddle[1], "straddle", money(straddle[2]), {
        verb: "posts straddle",
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

    const wager = line.match(
      new RegExp(String.raw`^(.+?): (calls|bets) ${NUM}( and is all-in)?$`),
    );
    if (wager) {
      draft.wager(wager[1], wager[2] === "calls" ? "call" : "bet", money(wager[3]), {
        allIn: Boolean(wager[4]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    // The single most damaging divergence in the format. CoinPoker writes
    // `raises 0.16 to 0.18` *and* `raises 0.46 and is all-in` - one amount, no
    // `to` - in the same hand, and the bare number is the chips **added**, not
    // the total and not the amount over the current bet. Fixture 05 proves it:
    // waqqas has 0.64, is in for 0.18 preflop, and `raises 0.46 and is all-in`
    // on the flop, which is exactly the 0.46 left. A `raises N to M` regex
    // drops the action outright; reading N as a "to" would report a 0.46 flop
    // commitment where the player put in 0.46 *on top of nothing* - the same
    // number by luck here, and wrong the moment the raiser had already bet.
    const raiseTo = line.match(
      new RegExp(String.raw`^(.+?): raises ${NUM} to ${NUM}( and is all-in)?$`),
    );
    if (raiseTo) {
      draft.raiseTo(raiseTo[1], money(raiseTo[3]), {
        allIn: Boolean(raiseTo[4]),
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const raiseAllIn = line.match(new RegExp(String.raw`^(.+?): raises ${NUM} and is all-in$`));
    if (raiseAllIn) {
      const player = raiseAllIn[1];
      draft.raiseTo(player, draft.committed(player) + money(raiseAllIn[2]), {
        allIn: true,
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const shows = line.match(/^(.+?): shows \[([^\]]*)\](?: \((.+)\))?$/);
    if (shows) {
      // The description wording is CoinPoker's own - `three of kind, Aces`
      // (no "a"), `a full house, Aces over Fours` (not "full of"), `Ace high`.
      // It is kept verbatim rather than normalized to the PokerStars phrasing,
      // which is what `PhfAction.description` is for.
      draft.show(shows[1], extractCards(shows[2]), shows[3], { line: lineNo, rawLine: line });
      continue;
    }

    const muck = line.match(/^(.+?): (mucks hand|doesn't show hand)$/);
    if (muck) {
      draft.muck(muck[1], muck[2], { line: lineNo, rawLine: line });
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

  const hand = draft.build();

  for (const result of hand.results.players) {
    applyStraddleTag(result, unit);
    // `raw` exists so a room's own SUMMARY prose can be reproduced byte for
    // byte. CoinPoker's cannot be: it writes amounts with **no currency symbol**
    // (`and won (0.20)`), so replaying it verbatim would put an unsymbolled
    // number in the middle of a document whose every other amount reads `$0.20`,
    // and trackers do parse these lines. The structured fields carry everything
    // the prose does - including the `(straddle)` tag and CoinPoker's own hand
    // descriptions - so the serializer generates the line instead. It is dropped
    // only when the outcome classified, because an unclassified seat would
    // generate nothing and lose its line altogether.
    if (result.outcome !== "unknown") {
      result.raw = null;
    }
  }

  // A hand whose actors are not in its own seat block is internally
  // inconsistent; emitting it would attribute the action to nobody.
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

export const coinpokerParser: SiteParser = {
  id: "coinpoker",
  name: "CoinPoker",
  version: COINPOKER_PARSER_VERSION,

  detect(text: string): number {
    // The header is exclusive to the room and verified across ~4.2M lines of
    // real log. Everything *below* the header reads as PokerStars, which is why
    // nothing here scores on body features: `(0.01/0.02 )` and `Game ended:`
    // corroborate the header but would happily claim a truncated PokerStars
    // paste on their own.
    if (HEADER_PREFIX.test(stripBom(text)) || /(?:^|[\r\n])CoinPoker Hand #\d+:/.test(text)) {
      return 0.95;
    }
    // Branding with no header is a truncated paste; claim it weakly so a
    // dedicated parser could still outrank us.
    if (/\bCoinPoker\b/.test(text)) {
      return 0.3;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    // One blank line separates hands, not two, so the split has to key on the
    // header: a splitter tuned to PokerStars' `\n\n\n` reads a whole CoinPoker
    // file as a single hand.
    return stripBom(text)
      .split(/(?=^CoinPoker Hand #\d+:)/m)
      .map((chunk) => stripBom(chunk).trim())
      .filter((chunk) => HEADER_PREFIX.test(chunk));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    return parseOneHand(raw, ctx);
  },
};

/**
 * Whether a chunk is a CoinPoker hand *by its own text*.
 *
 * Exported for the test suite, which decides site membership this way rather
 * than from the directory a fixture sits in - that is what catches a
 * mislabelled upstream sample instead of converting it with the wrong grammar.
 */
export function looksLikeCoinPoker(text: string): boolean {
  return HEADER_PREFIX.test(stripBom(text).trim());
}
