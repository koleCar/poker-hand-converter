/**
 * Chico network parser.
 *
 * One network, several skins, and the skins really do differ. This parser is
 * written and tested against the four brand strings that appear in real bytes in
 * `fixtures/samples/chico/`:
 *
 * | skin | confirmed by | dialect
 * | --- | --- | ---
 * | `BetOnline Poker`  | 13 files | lower-case verbs, `raises X to Y`, `[a b c][d]`
 * | `PayNoRake`        | 1 file   | same as BetOnline; header time has no seconds
 * | `ActionPoker.com`  | 1 file   | Title-Case verbs, trailing periods, `in Chips`, `[a b c] [d]`
 * | `Gear Poker`       | 1 file   | Title-Case verbs, play money, unquoted table name
 *
 * `SportsBetting.ag Poker` and `Tiger Gaming` are named by the network and by
 * fpdb-3's own regex, but **no real hand bearing either string could be
 * obtained**. They are detected at a lower confidence and every hand converted
 * from one carries an `unverified-skin` warning, so nobody can mistake inference
 * for evidence. The grammar cross-checks below are strong enough that a skin
 * whose dialect actually differs would be refused rather than mangled.
 *
 * What a naive parser gets wrong here:
 *
 * - **The header lies about the variant.** Every hand in
 *   `cash__PLO-10max-USD-0.05-0.10-201209.txt` is headed `Hold'em Pot Limit` and
 *   every one of them deals four cards. The variant is therefore taken from the
 *   cards, not from the label.
 * - **There is no `collected ... from pot` line in the stream.** The only
 *   statement of who won is the SUMMARY block.
 * - **`Total pot | Rake` is printed once per pot component, in and out of the
 *   summary block**, and the rake figure repeated on each one is the *hand*
 *   total, not that pot's share. The pot figures are unusable as a payout total:
 *   the research note that "only the last one is the grand total" is wrong (in
 *   `winner.no.show` the last one is the main pot and the earlier one the side
 *   pot), and summing them double-counts the 2011 corpus, which prints the
 *   identical line twice in one summary. Only the rake is read from them, and
 *   it is what every other number in the hand is reconciled against.
 * - **`post dead` under-reports by a small blind**, silently. See the comment
 *   at the call site; it is the one inference in this parser, and the printed
 *   rake confirms it hand by hand.
 * - **The first raise of a street repeats itself**: `raises 120.00 to 120.00`
 *   where the blind was 60. The "by" field is a genuine site bug; only the "to"
 *   field is read and the "by" is recomputed from the betting state.
 * - **Ten is written `10`**, so `10d` has to be normalized to `Td` before any
 *   card code is emitted - the shared card extractor reads two characters and
 *   would silently drop the card otherwise.
 * - **Chat, joins and leaves are interleaved into the action stream** with no
 *   delimiter, and chat can contain anything.
 * - **Seat numbers start at 0** and are not guaranteed unique inside one hand.
 * - **Three skins print the summary shown-cards as the best five-card hand**,
 *   not as hole cards (`showed [10S 6D 6C 10C KC ]` against a board of
 *   `10S 6D 7S 6C 10C`). Cards that overlap the board, or that are not a
 *   variant-sized hand, are dropped rather than filed as somebody's hole cards.
 *
 * Tournament hands are supported; the network never prints a buy-in or a level
 * number, so those stay empty rather than being invented.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  PLAY_CHIPS,
  USD,
  parseAmount,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import {
  buildP6Hand,
  type P6Action,
  type P6Collect,
  type P6Draft,
  type P6Seat,
  type P6Street,
} from "./shared/p6-handbuilder";

const VERSION = "1.0.0";

/** Brand strings backed by real fixture bytes. */
const CONFIRMED_SKINS = ["BetOnline Poker", "PayNoRake", "ActionPoker.com", "Gear Poker"];
/** Brand strings asserted only by another parser's regex; see the file header. */
const INFERRED_SKINS = ["SportsBetting.ag Poker", "Tiger Gaming"];

const BRAND = [...CONFIRMED_SKINS, ...INFERRED_SKINS]
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const HEADER = new RegExp(
  String.raw`^(${BRAND}) Game #(\d+): (.+?) - (\d{4}[/-]\d{2}[/-]\d{2} .*)$`,
);
const CONFIRMED_HEADER = new RegExp(
  String.raw`^(?:${CONFIRMED_SKINS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
    "|",
  )}) Game #\d+:`,
  "m",
);
const ANY_HEADER = new RegExp(String.raw`^(?:${BRAND}) Game #\d+:`, "m");

const DATE = /^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(.*))?$/;

const TABLE =
  /^Table (?:'([^']*)'|(.+?)) (?:(\d+)-Max,|\((?:Play|Real) Money\)) Seat #(\d+) is the button\s*$/i;
const SEAT = /^Seat (\d+): (.*?) \(([^()]*?) in [Cc]hips\)(?: - (.+?))?\s*$/;
const POT = /^Total [Pp]ot ([\d.,]+)(?: \| Rake ([\d.,]+))?\s*\.?$/;

/** US decimal, optional thousands grouping. Anything else refuses the hand. */
const SAFE_AMOUNT = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

/** Lines that are neither pot nor card information and are dropped on purpose. */
const NOISE =
  /(?: said ".*"$| joins the table at seat #\d+$| has left the table$)|^Joined table during game\.|^Tournament will start in a moment\.$|^Hand cancelled/;

export const chicoParser: SiteParser = {
  id: "chico",
  name: "Chico Network (BetOnline / PayNoRake / ActionPoker / Gear Poker)",
  version: VERSION,

  detect(text: string): number {
    // The brand name immediately before `Game #` is what separates this network
    // from both PokerStars (`PokerStars Hand #` / `PokerStars Game #`) and
    // WPN/ACR era C, whose header carries no brand name at all.
    if (CONFIRMED_HEADER.test(text)) {
      return 0.95;
    }
    if (ANY_HEADER.test(text)) {
      // A skin whose grammar we have never seen a byte of. Still far and away
      // the best candidate - nobody else emits these brand strings - but scored
      // below the dialects that are actually backed by fixtures.
      return 0.55;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .split(new RegExp(String.raw`(?=^(?:${BRAND}) Game #)`, "m"))
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      // Two fixtures open with lobby chatter (`Tournament will start in a
      // moment.`) before the first header; that leading chunk is dropped here.
      .filter((chunk) => ANY_HEADER.test(chunk.split(/\r?\n/)[0] ?? ""));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const text = raw.replace(/^﻿/, "").trim();
    const lines = text.split(/\r?\n/);
    const warnings: PhfWarning[] = [];

    const headerMatch = lines[0]?.match(HEADER);
    if (!headerMatch) {
      throw new ParseSkip("no-header", `Unreadable Chico header: "${lines[0] ?? ""}".`);
    }
    const skin = headerMatch[1];
    if (INFERRED_SKINS.includes(skin)) {
      warnings.push({
        code: "unverified-skin",
        message:
          `"${skin}" is named by the network but no real hand history bearing that brand ` +
          "was available when this parser was written; its dialect is inferred from the " +
          "four skins that were.",
      });
    }

    const tableMatch = lines[1]?.match(TABLE);
    if (!tableMatch) {
      throw new ParseSkip("no-header", `Unreadable Chico table line: "${lines[1] ?? ""}".`);
    }
    const playMoney = /\(Play Money\)/i.test(lines[1] ?? "");

    /* ------------------------------------------------------------- header -- */

    const spec = headerMatch[3].trim();
    const tournamentMatch = spec.match(/^Tournament #(\d+):\s*(.+?)\s+(\S+)\/(\S+)$/);
    const cashMatch = spec.match(/^(.+?)\s*\((\S+?)\/(\S+?)\)$/);

    const gameLabelRaw = tournamentMatch ? tournamentMatch[2] : (cashMatch?.[1] ?? spec);
    if (!/hold\s*'?em/i.test(gameLabelRaw)) {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is labelled "${gameLabelRaw}".`,
      );
    }

    // Tournament stacks and play-money stacks are chips; a real-money cash table
    // is dollars. The network is USD-only and prints no symbol on the body
    // amounts, so an unstated currency on a real-money table is flagged rather
    // than silently assumed.
    let unit: CurrencyUnit;
    if (tournamentMatch) {
      unit = CHIPS;
    } else if (playMoney) {
      unit = PLAY_CHIPS;
      // The standard text has no way to say "play money" - the amounts come back
      // out as plain chips - so the flag is carried as a warning instead. A
      // play-money hand mixed into a real-money win rate is a silent lie.
      warnings.push({
        code: "play-money-table",
        message: "The table is flagged as play money, so the amounts are not real currency.",
      });
    } else {
      unit = USD;
      if (!/[$€£]/.test(spec)) {
        warnings.push({
          code: "assumed-currency",
          message:
            "The header states no currency symbol; the amounts are read as USD, which is " +
            "the only currency this network has been seen to offer.",
        });
      }
    }

    const readAmount = (token: string, line: number): Amount => {
      const cleaned = token.trim().replace(/^[$€£]/, "");
      if (!SAFE_AMOUNT.test(cleaned)) {
        throw new ParseSkip(
          "unsupported-locale",
          `"${token}" on line ${line} is not a plain decimal amount, and guessing at its ` +
            "magnitude would be wrong by a factor of 100.",
        );
      }
      return parseAmount(cleaned, unit);
    };
    /**
     * Money that enters the pot, on a table whose unit is indivisible chips.
     *
     * One real tournament hand bets `2522.50` against a chip unit that cannot
     * express a half chip. Rounding it would put the hand a half chip out of
     * balance in a way nothing downstream could detect, so it is refused.
     */
    const readStake = (token: string, line: number): Amount => {
      const value = readAmount(token, line);
      if (unit.minorUnits === 1 && /\.\d*[1-9]/.test(token)) {
        throw new ParseSkip(
          "fractional-chips",
          `"${token}" on line ${line} is a fraction of a chip, which this hand's unit ` +
            "cannot represent.",
        );
      }
      return value;
    };

    const dateMatch = headerMatch[4].trim().match(DATE);
    const playedAt = dateMatch ? isoFrom(dateMatch) : null;
    if (!dateMatch) {
      warnings.push({
        code: "unreadable-timestamp",
        message: `Could not read a timestamp from "${headerMatch[4]}".`,
      });
    }

    /* ------------------------------------------------------------- stream -- */

    const seats: P6Seat[] = [];
    const seatByName = new Map<string, P6Seat>();
    const actions: P6Action[] = [];
    const acted = new Set<string>();
    const printedUncalled: Array<{ player: string; amount: Amount }> = [];
    const deadPosts: P6Action[] = [];
    /**
     * The `Total pot` figures, kept only as evidence that the hand finished.
     *
     * Their *values* are not used: see the file header. One real file simply
     * stops mid-hand, and the absence of any pot line is what says so.
     */
    const potComponents: Amount[] = [];
    const summaryShown = new Map<number, string[]>();
    const summaryWon = new Map<number, Amount>();
    const inlineShown = new Set<string>();
    let reportedRake: Amount | null = null;
    let street: P6Street = "preflop";
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let summaryBoard: string[] | null = null;
    let inSummary = false;

    const names: string[] = [];
    const nameOf = (line: string, separator: string): string | null =>
      names.find((name) => line.startsWith(`${name}${separator}`)) ?? null;

    const requireSeat = (name: string, line: number): P6Seat => {
      const seat = seatByName.get(name);
      if (!seat) {
        // `Unknown player` is a real sentinel this network emits when it could
        // not attribute an action. There is no seat to attach the chips to, the
        // position ring cannot be closed without one, and inventing a seat would
        // change everybody else's position - so the hand is refused.
        throw new ParseSkip(
          "unseated-actor",
          `"${name}" acts on line ${line} but is not seated in this hand.`,
        );
      }
      acted.add(name);
      return seat;
    };

    for (let i = 2; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const lineNo = i + 1;
      if (!line) {
        continue;
      }

      if (/^\*\*\* HOLE CARDS \*\*\*/.test(line)) {
        street = "preflop";
        continue;
      }
      if (/^\*\*\* SHOW\s?DOWN \*\*\*/.test(line)) {
        continue;
      }
      if (/^\*\*\* SUMMARY \*\*\*/.test(line)) {
        inSummary = true;
        continue;
      }

      const board = line.match(/^\*\*\* (FLOP|TURN|RIVER) \*\*\*\s*(.*)$/i);
      if (board) {
        // Turn and river repeat the known board in the first bracket; the new
        // card is in the last one. BetOnline runs the brackets together
        // (`[6c 7s Qc][10d]`), ActionPoker separates them - both parse the same.
        const groups = [...board[2].matchAll(/\[([^\]]*)\]/g)].map((match) => cardsIn(match[1]));
        const last = groups[groups.length - 1] ?? [];
        const kind = board[1].toUpperCase();
        if (kind === "FLOP") {
          flop = last;
          street = "flop";
        } else if (kind === "TURN") {
          turn = last[0] ?? null;
          street = "turn";
        } else {
          river = last[0] ?? null;
          street = "river";
        }
        continue;
      }

      // Pot lines appear both inside and outside the SUMMARY block, once per
      // pot component; the rake they each repeat is the hand's total rake.
      const pot = line.match(POT);
      if (pot) {
        potComponents.push(readStake(pot[1], lineNo));
        if (pot[2] !== undefined) {
          reportedRake = readStake(pot[2], lineNo);
        }
        continue;
      }

      const printedBoard = line.match(/^Board \[([^\]]*)\]\s*$/);
      if (printedBoard) {
        summaryBoard = cardsIn(printedBoard[1]);
        continue;
      }

      const seat = line.match(SEAT);
      if (seat && !inSummary) {
        const name = seat[2].trim();
        if (!name) {
          // One real tournament export lists `Seat 4:  (100.00 in chips)` and
          // then acts as `: posts small blind`. Nothing can be attributed.
          throw new ParseSkip(
            "unnamed-seat",
            `Seat ${seat[1]} on line ${lineNo} has no player name, so its actions cannot ` +
              "be attributed.",
          );
        }
        if (seatByName.has(name)) {
          throw new ParseSkip("duplicate-player", `"${name}" is seated twice.`);
        }
        if (seats.some((entry) => entry.seat === Number(seat[1]))) {
          // Confirmed real defect: `two.players.one.seat` lists two players at
          // seat 5. The seat is the join key for positions and for the summary.
          throw new ParseSkip(
            "duplicate-seat",
            `Seat ${seat[1]} is claimed by two different players in the same hand.`,
          );
        }
        const entry: P6Seat = {
          seat: Number(seat[1]),
          name,
          startingStack: readAmount(seat[3], lineNo),
          // Decided below from whether the seat actually did anything; the
          // `- Sitting out` tag is stale often enough that it cannot be trusted
          // on its own (one fixture has the hero tagged sitting out while
          // posting the big blind and playing the hand out).
          dealtIn: false,
          isHero: false,
          dealtCards: [],
        };
        seats.push(entry);
        seatByName.set(name, entry);
        names.push(name);
        names.sort((a, b) => b.length - a.length);
        continue;
      }

      if (inSummary) {
        // Some hands print an inline reveal *after* the summary marker.
        const lateShow = nameOf(line, " shows ");
        if (lateShow) {
          const cards = cardsIn(line.slice(lateShow.length + " shows ".length));
          if (!inlineShown.has(lateShow)) {
            inlineShown.add(lateShow);
            acted.add(lateShow);
            actions.push({ street, player: lateShow, kind: "show", cards, line: lineNo });
          }
          continue;
        }
        const summarySeat = line.match(/^Seat (\d+): (.*)$/);
        if (summarySeat) {
          const number = Number(summarySeat[1]);
          const shown = summarySeat[2].match(/showed \[([^\]]*)\]/i);
          if (shown) {
            summaryShown.set(number, cardsIn(shown[1]));
          }
          const won = summarySeat[2].match(/\b(?:collected|won) \(([\d.,]+)\)/i);
          if (won) {
            summaryWon.set(number, (summaryWon.get(number) ?? 0) + readStake(won[1], lineNo));
          }
          continue;
        }
        if (NOISE.test(line)) {
          continue;
        }
        warnings.push({ code: "unknown-summary-line", message: line, line: lineNo });
        continue;
      }

      const dealt = line.match(/^Dealt [Tt]o (.+?) \[([^\]]*)\]\s*$/);
      if (dealt) {
        const owner = requireSeat(dealt[1].trim(), lineNo);
        owner.isHero = true;
        owner.dealtCards = cardsIn(dealt[2]);
        continue;
      }

      const uncalled = line.match(/^Uncalled bet \(([\d.,]+)\) returned to (.+?)\s*$/);
      if (uncalled) {
        const owner = requireSeat(uncalled[2].trim(), lineNo);
        printedUncalled.push({ player: owner.name, amount: readStake(uncalled[1], lineNo) });
        continue;
      }

      if (NOISE.test(line)) {
        continue;
      }

      // Inline showdown reveals carry no brackets: `Player2 shows Jc Jd`.
      const showsName = nameOf(line, " shows ");
      if (showsName) {
        const cards = cardsIn(line.slice(showsName.length + " shows ".length));
        requireSeat(showsName, lineNo);
        inlineShown.add(showsName);
        actions.push({ street, player: showsName, kind: "show", cards, line: lineNo });
        continue;
      }

      const actor = nameOf(line, ": ");
      if (!actor) {
        // `Unknown player: raises 15.75 to 18.75 and is all in` is a real,
        // confirmed sentinel this network emits when it could not attribute an
        // action to a seat. Letting it fall through to `unknown-line` would drop
        // the chips silently, so a line that is unmistakably an action from
        // somebody who is not seated refuses the hand.
        if (/^.+?: (?:folds|checks|calls|bets|raises|posts?|ante)\b/i.test(line)) {
          throw new ParseSkip(
            "unseated-actor",
            `Line ${lineNo} is an action by somebody who is not in the seat list: "${line}".`,
          );
        }
        warnings.push({ code: "unknown-line", message: line, line: lineNo });
        continue;
      }
      requireSeat(actor, lineNo);
      // ActionPoker and Gear Poker Title-Case every verb and end every line with
      // a period; BetOnline and PayNoRake do neither. One set of patterns reads
      // both, which is what makes the four skins one parser.
      const rest = line
        .slice(actor.length + 2)
        .replace(/\.\s*$/, "")
        .trim();
      const allIn = / and is all[- ]?in$/i.test(rest);
      const verb = rest.replace(/ and is all[- ]?in$/i, "").trim();

      if (/^folds$/i.test(verb) || /^checks$/i.test(verb)) {
        actions.push({
          street,
          player: actor,
          kind: /^folds$/i.test(verb) ? "fold" : "check",
          line: lineNo,
        });
        continue;
      }

      const blind = verb.match(/^posts? (small|big) blind ([\d.,]+)$/i);
      if (blind) {
        actions.push({
          street: "preflop",
          player: actor,
          kind: blind[1].toLowerCase() === "small" ? "small-blind" : "big-blind",
          amount: readStake(blind[2], lineNo),
          allIn,
          line: lineNo,
        });
        continue;
      }

      // `post now` is a player catching up to the current bet mid-orbit;
      // `post dead` is the network's dead-blind form. Both are live money that
      // does not move the blind ring.
      const post = verb.match(/^posts? (now|dead) ([\d.,]+)$/i);
      if (post) {
        const entry: P6Action = {
          street: "preflop",
          player: actor,
          kind: "post",
          amount: readStake(post[2], lineNo),
          allIn,
          line: lineNo,
        };
        actions.push(entry);
        if (/^dead$/i.test(post[1])) {
          deadPosts.push(entry);
        }
        continue;
      }

      const ante = verb.match(/^ante processed ([\d.,]+)$/i);
      if (ante) {
        const amount = readStake(ante[1], lineNo);
        // A zero ante is printed for every seat at the table, sitting-out seats
        // included, so it is neither money nor evidence of being dealt in.
        if (amount > 0) {
          actions.push({
            street: "preflop",
            player: actor,
            kind: "ante",
            amount,
            allIn,
            line: lineNo,
          });
        } else {
          acted.delete(actor);
        }
        continue;
      }

      const callBet = verb.match(/^(calls|bets) ([\d.,]+)$/i);
      if (callBet) {
        actions.push({
          street,
          player: actor,
          kind: /^calls$/i.test(callBet[1]) ? "call" : "bet",
          amount: readStake(callBet[2], lineNo),
          allIn,
          line: lineNo,
        });
        continue;
      }

      const raiseTo = verb.match(/^raises ([\d.,]+) to ([\d.,]+)$/i);
      if (raiseTo) {
        actions.push({
          street,
          player: actor,
          kind: "raise",
          // Only the "to" number is trustworthy: the network prints the same
          // figure twice for the first raise of a street.
          amount: readStake(raiseTo[2], lineNo),
          toTotal: true,
          allIn,
          line: lineNo,
        });
        continue;
      }

      // The Title-Case skins write `Raises 1000.00 and is All In.` with no "to"
      // clause at all. Their `Calls 900.00 and is All In.` is provably an
      // increment - it takes the caller to exactly their stated stack - so the
      // raise is read the same way.
      const raiseBy = verb.match(/^raises ([\d.,]+)$/i);
      if (raiseBy) {
        actions.push({
          street,
          player: actor,
          kind: "raise",
          amount: readStake(raiseBy[1], lineNo),
          allIn,
          line: lineNo,
        });
        continue;
      }

      warnings.push({ code: "unknown-line", message: line, line: lineNo });
    }

    /* ------------------------------------------------------------- checks -- */

    if (seats.length === 0) {
      throw new ParseSkip("no-players", "The hand lists no seats.");
    }
    if (potComponents.length === 0) {
      throw new ParseSkip("truncated-hand", "The hand has no readable `Total pot` line.");
    }

    // `post dead X` under-reports what the player was charged. In both real
    // hands in the corpus that contain one, the pot comes out short by exactly
    // the small blind:
    //
    //   `post dead 0.50` at 0.25/0.50 -> derived rake 0.53 against a printed 0.78
    //   `post dead 0.00` at 0.25/0.50 -> derived rake 2.01 against a printed 2.26
    //
    // which is the ordinary "big blind live, small blind dead" entry fee with
    // only the live half written down. The dead half is added back here and the
    // inference is then checked per hand against the rake the site printed, so a
    // `post dead` that does not reconcile is refused rather than stored.
    if (deadPosts.length > 0) {
      const postedSmallBlind = actions.find((entry) => entry.kind === "small-blind")?.amount ?? 0;
      for (const entry of deadPosts) {
        entry.dead = postedSmallBlind;
      }
    }

    // The header is not evidence of the variant on this network: a whole file of
    // four-card hands is headed `Hold'em Pot Limit`. The deal and the inline
    // reveals are.
    const dealtCounts = [
      ...seats.map((entry) => entry.dealtCards.length),
      ...actions
        .filter((action) => action.kind === "show")
        .map((action) => action.cards?.length ?? 0),
    ].filter((count) => count > 0);
    if (dealtCounts.some((count) => count !== 2)) {
      throw new ParseSkip(
        "unsupported-variant",
        `The hand deals ${Math.max(...dealtCounts)} hole cards despite being labelled ` +
          `"${gameLabelRaw}"; round one is Hold'em only.`,
      );
    }

    // The street markers stop as soon as the betting does, so a hand that ends
    // all-in on the flop prints three marker cards and a five-card summary
    // board: the run-out happened, it just was not written down street by
    // street. The markers therefore have to be a *prefix* of the summary board,
    // and the summary is what fills in the rest. Anything that is not a prefix
    // is two different boards and there is no way to tell which was played.
    const markerBoard = [...(flop ?? []), ...(turn ? [turn] : []), ...(river ? [river] : [])];
    let resolved = markerBoard;
    if (summaryBoard) {
      const conflicting =
        markerBoard.length > summaryBoard.length ||
        markerBoard.some((card, index) => summaryBoard[index] !== card);
      if (conflicting) {
        throw new ParseSkip(
          "board-mismatch",
          `The street markers deal [${markerBoard.join(" ")}] but the summary reports ` +
            `[${summaryBoard.join(" ")}]; the two cannot both be the board.`,
        );
      }
      if (summaryBoard.length > markerBoard.length) {
        resolved = summaryBoard;
        flop = resolved.slice(0, 3);
        turn = resolved[3] ?? null;
        river = resolved[4] ?? null;
        warnings.push({
          code: "board-from-summary",
          message:
            `The street markers stop after ${markerBoard.length} cards; the rest of the ` +
            "board is taken from the summary, which is the only place it is written down.",
        });
      }
    }
    if (resolved.length > 0 && ![3, 4, 5].includes(resolved.length)) {
      throw new ParseSkip("board-size", `The board has ${resolved.length} cards.`);
    }

    /* ------------------------------------------------------- reveals, pots - */

    const onBoard = new Set(resolved);
    for (const action of actions) {
      if (action.kind !== "show") {
        continue;
      }
      if ((action.cards ?? []).some((card) => onBoard.has(card))) {
        throw new ParseSkip(
          "duplicate-card",
          `${action.player} shows a card that is already on the board.`,
        );
      }
    }
    for (const [number, cards] of summaryShown) {
      const seat = seats.find((entry) => entry.seat === number);
      if (!seat || inlineShown.has(seat.name)) {
        continue;
      }
      // Two skins print the winner's best five-card hand here instead of the
      // hole cards. Board overlap is the giveaway, and a hand that is not two
      // cards cannot be a Hold'em holding either way.
      if (cards.length !== 2 || cards.some((card) => onBoard.has(card))) {
        warnings.push({
          code: "unreadable-shown-cards",
          message:
            `Seat ${number} is shown as [${cards.join(" ")}], which is the made hand rather ` +
            "than hole cards, so no hole cards were recorded for the seat.",
        });
        continue;
      }
      actions.push({ street, player: seat.name, kind: "show", cards });
      acted.add(seat.name);
    }

    const collected: P6Collect[] = [];
    for (const [number, amount] of summaryWon) {
      const seat = seats.find((entry) => entry.seat === number);
      if (!seat) {
        throw new ParseSkip(
          "unseated-actor",
          `The summary credits seat ${number}, which is not in the seat list.`,
        );
      }
      if (amount > 0) {
        collected.push({ player: seat.name, amount, potName: "pot" });
        acted.add(seat.name);
      }
    }

    for (const seat of seats) {
      seat.dealtIn = acted.has(seat.name);
    }

    const stakes = tournamentMatch
      ? { small: readAmount(tournamentMatch[3], 1), big: readAmount(tournamentMatch[4], 1) }
      : cashMatch
        ? { small: readAmount(cashMatch[2], 1), big: readAmount(cashMatch[3], 1) }
        : { small: 0, big: 0 };

    const draft: P6Draft = {
      siteId: "chico",
      siteName: chicoParser.name,
      parserId: "chico",
      parserVersion: VERSION,
      handPrefix: "CHC-",
      handId: headerMatch[2],
      gameLabel: canonicalLabel(gameLabelRaw),
      unit,
      decimals: "fixed2",
      headerSmallBlind: stakes.small,
      headerBigBlind: stakes.big,
      tableName: (tableMatch[1] ?? tableMatch[2] ?? "").trim() || null,
      // Every real-money table in the corpus is 10-Max and the Title-Case skins
      // omit the capacity entirely while seating ten players from seat 0.
      maxSeats: tableMatch[3] ? Number(tableMatch[3]) : 10,
      buttonSeat: Number(tableMatch[4]),
      tournament: tournamentMatch
        ? {
            id: tournamentMatch[1],
            levelSmallBlind: stakes.small,
            levelBigBlind: stakes.big,
          }
        : null,
      playedAt,
      seats,
      actions,
      flop,
      turn,
      river,
      collected,
      collectedIncludesUncalled: false,
      printedUncalled,
      reportedGross: null,
      reportedPayout: null,
      // The `Total pot` figures are deliberately *not* used as a payout total.
      // They are unusable as one: a side-pot hand prints one line per pot
      // (0.42 and 0.29 for a 0.71 payout), while the 2011 cash corpus prints the
      // identical line twice inside one summary block. Summing them
      // double-counts the second case and taking the last one under-reports the
      // first. The rake, which every one of those lines repeats identically and
      // which is the hand total rather than that pot's share, carries the same
      // information without the ambiguity: if a payout line is missing, the
      // derived rake comes out too big by exactly the missing amount.
      reportedRake: reportedRake ?? 0,
      rawText: text,
      warnings,
    };

    return buildP6Hand(draft, ctx);
  },
};

/** `Hold'em`, `Hold'em No Limit`, `Hold'em Pot Limit` -> the standard label. */
function canonicalLabel(label: string): string {
  if (/pot\s*limit/i.test(label)) {
    return "Hold'em Pot Limit";
  }
  if (/fixed\s*limit/i.test(label)) {
    return "Hold'em Limit";
  }
  // A bare `Hold'em` with no limit clause is what the Title-Case skins write;
  // both of those samples are no-limit tables.
  return "Hold'em No Limit";
}

/**
 * Card codes, normalized.
 *
 * This network writes ten as `10` and two skins upper-case the suit, so `10S`
 * and `10d` both have to become `Ts` / `Td`. The shared card extractor reads
 * exactly two characters and would drop a `10x` code without a word.
 */
function cardsIn(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(10|[2-9tjqkaTJQKA])([shdcSHDC])$/);
      if (!match) {
        return token;
      }
      const rank = match[1].toUpperCase();
      return `${rank === "10" ? "T" : rank}${match[2].toLowerCase()}`;
    });
}

/**
 * Header timestamp to ISO.
 *
 * Four distinct shapes appear across sixteen files: with and without seconds,
 * slash and dash separated, with a full timezone name, an abbreviation, or
 * nothing at all. Following the house convention the printed clock is read as
 * the instant and the zone token is left in `meta.rawText` rather than applied.
 */
function isoFrom(match: RegExpMatchArray): string | null {
  const stamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  );
  return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
}
