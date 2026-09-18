/**
 * The PokerStars line grammar, as spoken by the rooms that cloned it.
 *
 * Run It Once Poker and PokerBros' PokerStars-family export both descend from
 * the grammar `parsers/pokerstars.ts` reads. They differ from PokerStars, and
 * from each other, only in details this dispatcher absorbs:
 *
 * - the table line is `Table ID '30263259' 6-Max ...` on RIO (the literal word
 *   "ID", a numeric table id, a capitalized `Max`) and `Table 'Myanmar...'
 *   6-max ...` on PokerBros;
 * - RIO writes `*** SHOWDOWN ***` as one word where PokerStars and PokerBros
 *   write `*** SHOW DOWN ***`;
 * - RIO's showdown reveal has **no colon** (`Ricky N shows [..] for ..`) while
 *   every other action line in the same file has one;
 * - RIO tags the observer's seat line with a trailing `[hero]`;
 * - RIO adds promotional money to the pot (`STP added: €0.50`), which is
 *   refused here - see `houseMoney` below.
 *
 * It is deliberately a dispatcher only. Headers, refusal policy and provenance
 * live in the two site files, because that is where the rooms really differ,
 * and the hand semantics come from `StarsHandDraft`.
 *
 * Owned by parser agent 3; imported by `runitonce.ts` and `pokerbros.ts`.
 */

import { extractCards } from "../../cards";
import { ParseSkip } from "../../phf/detect";
import {
  ZERO_FEES,
  parseAmount,
  type Amount,
  type CurrencyUnit,
  type PhfFees,
} from "../../phf/types";
import { MONEY, type StarsHandDraft } from "./p3-draft";

/** `Table ID '30263259' 6-Max Seat #1 is the button` / `Table 'x' 6-max ...`. */
const TABLE_REGEX =
  /^Table(?: ID)? '(.*)' (\d+)-max(?: \(([^)]*)\))?(?: Seat #(\d+) is the button)?\s*$/i;
/** The trailing group holds `[hero]`, `is sitting out`, and nothing else seen. */
const SEAT_REGEX = /^Seat (\d+): (.+?) \(([^)]+) in chips\)(.*)$/;
const MARKER_REGEX =
  /^\*\*\*\s*(FIRST|SECOND|THIRD)?\s*(FLOP|TURN|RIVER|SHOW\s?DOWN)\s*\*\*\*(.*)$/i;
const RUN_PREFIXES = ["FIRST", "SECOND", "THIRD", "FOURTH"];

/** Both rooms append `and is all-in`, hyphenated, PokerStars-style. */
const SUFFIX = String.raw`((?: and is all-in)*)`;

function allInFrom(suffix: string | undefined): boolean {
  return Boolean(suffix && /and is all-in/.test(suffix));
}

/**
 * Lines that carry neither pot nor card information.
 *
 * Kept short on purpose: none of these shapes appears in the four RIO or two
 * PokerBros fixtures, they are listed because they are part of the grammar both
 * rooms inherited, and anything *not* listed still raises `unknown-line` rather
 * than being swallowed.
 */
const CHATTER_REGEX =
  /\bsaid, "|\bjoins the table\b|\bleaves the table\b|\bis sitting out\b|\bsits out\b|\bhas timed out\b|\bis (?:dis)?connected\b|\bhas returned\b/i;

export interface DialectResult {
  /** Seats the hand listed, for the "is the button even occupied?" check. */
  seats: number[];
  buttonSeat: number | null;
  /** The source printed a `*** SUMMARY ***` block. */
  sawSummary: boolean;
}

function runoutIndexForLabel(label: string): number {
  if (!label) {
    return 0;
  }
  const index = RUN_PREFIXES.indexOf(label.toUpperCase());
  return index < 0 ? 0 : index;
}

/**
 * The SUMMARY pot line, which both rooms write as pipe-separated columns:
 * `Total pot €0.75 | Main pot €0.25 | STP €0.50 | Rake €0.04`.
 *
 * PokerStars terminates each side pot with a period instead, so this is not the
 * PokerStars parser's version of the same line.
 */
function parsePotLine(
  line: string,
  unit: CurrencyUnit,
): { total: Amount; pots: Array<{ name: string; amount: Amount }>; fees: PhfFees } | null {
  const columns = line.split("|").map((column) => column.trim());
  const total = columns[0].match(new RegExp(String.raw`^Total pot ${MONEY}\s*$`));
  if (!total) {
    return null;
  }
  const pots: Array<{ name: string; amount: Amount }> = [];
  const fees: PhfFees = { ...ZERO_FEES };
  for (const column of columns.slice(1)) {
    const pot = column.match(new RegExp(String.raw`^(Main|Side) pot(?:-(\d+))? ${MONEY}$`));
    if (pot) {
      pots.push({ name: `${pot[1]}${pot[2] ? `-${pot[2]}` : ""}`, amount: parseAmount(pot[3], unit) });
      continue;
    }
    const rake = column.match(new RegExp(String.raw`^Rake ${MONEY}$`));
    if (rake) {
      fees.rake = parseAmount(rake[1], unit);
      continue;
    }
    const stp = column.match(new RegExp(String.raw`^STP ${MONEY}$`));
    if (stp) {
      houseMoney(parseAmount(stp[1], unit), line);
    }
    // Any other column is left alone: it would show up as a pot that does not
    // add up rather than as silently lost money, which is the outcome we want.
  }
  return { total: parseAmount(total[1], unit), pots, fees };
}

/**
 * Promotional money the room itself puts into the pot.
 *
 * RIO's "Splash The Pot" adds house money (`STP added: €0.50`) that no seat
 * contributed and that the winner then collects. PHF has no way to express a
 * contribution that belongs to nobody: every `PhfAction` needs a seated player,
 * and attributing the splash to one of them would corrupt that player's net
 * result and every statistic derived from it. Dropping it instead breaks chip
 * conservation, because the reported pot includes it.
 *
 * So the hand is refused, with its raw text kept for the day PHF grows a house
 * contributor. See the report in `docs/PHF-SPEC.md` §9 for the failure record.
 */
function houseMoney(amount: Amount, line: string): never {
  throw new ParseSkip(
    "splash-the-pot",
    `The room added ${amount} minor units to the pot itself ("${line.trim()}"); ` +
      "PHF cannot attribute a contribution to anyone but a seated player.",
  );
}

const UNCALLED_LINE = /^Uncalled bet \(.*\) returned to /;

/**
 * Moves an uncalled return printed *after* the showdown marker back in front of
 * it, keeping each line's own source number.
 *
 * RIO writes the return below `*** SHOWDOWN ***` where PokerStars writes it
 * above. Both mean the same thing - the last bet came back because nobody
 * matched it - but a return tagged with the showdown street is a return against
 * a street on which the player committed nothing, which is exactly the shape
 * `uncalled-exceeds-commitment` exists to reject. Re-ordering the two lines is
 * the whole fix; no amount changes, and `meta.rawText` still holds the original.
 */
function hoistUncalledBeforeShowdown(lines: string[]): Array<{ text: string; lineNo: number }> {
  const out = lines.map((text, index) => ({ text, lineNo: index + 1 }));
  for (let i = 0; i < out.length; i += 1) {
    if (!UNCALLED_LINE.test(out[i].text.trim())) {
      continue;
    }
    // The nearest marker above it has to be the showdown one; anything else
    // means the return is already on a betting street and belongs where it is.
    let marker = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      const above = out[j].text.trim();
      if (above.startsWith("***")) {
        if (/SHOW\s?DOWN/i.test(above)) {
          marker = j;
        }
        break;
      }
    }
    if (marker < 0) {
      continue;
    }
    const [moved] = out.splice(i, 1);
    out.splice(marker, 0, moved);
  }
  return out;
}

/**
 * Reads every line below the header into `draft`.
 *
 * `lines` is the whole hand including its header line, which the caller has
 * already parsed; iteration starts at index 1 so that line numbers in warnings
 * match the source.
 */
export function parseStarsFamilyBody(
  lines: string[],
  draft: StarsHandDraft,
  unit: CurrencyUnit,
): DialectResult {
  const money = (value: string | undefined) => parseAmount(value, unit);
  const result: DialectResult = { seats: [], buttonSeat: null, sawSummary: false };
  const ordered = hoistUncalledBeforeShowdown(lines);
  let inSummary = false;

  for (let i = 1; i < ordered.length; i += 1) {
    const rawLine = ordered[i].text;
    const line = rawLine.trim();
    const lineNo = ordered[i].lineNo;
    if (!line) {
      continue;
    }

    if (/^\*\*\*\s*SUMMARY\s*\*\*\*/i.test(line)) {
      inSummary = true;
      result.sawSummary = true;
      continue;
    }

    if (inSummary) {
      const pot = parsePotLine(line, unit);
      if (pot) {
        draft.summaryPot(pot.total, pot.pots, pot.fees);
        continue;
      }
      const board = line.match(/^(FIRST |SECOND |THIRD )?Board\s*\[([^\]]*)\]/i);
      if (board) {
        draft.summaryBoard(runoutIndexForLabel((board[1] ?? "").trim()), extractCards(board[2]));
        continue;
      }
      const seat = line.match(/^Seat (\d+):/);
      if (seat) {
        // RIO lists the seats in neither seat nor action order; the draft keys
        // them by seat number, so the order carries no meaning for us.
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
      result.buttonSeat = table[4] ? Number(table[4]) : null;
      draft.setTable(table[1] || null, Number(table[2]) || 0, result.buttonSeat);
      continue;
    }

    const seat = line.match(SEAT_REGEX);
    if (seat) {
      const tail = seat[4] ?? "";
      const seatNumber = Number(seat[1]);
      result.seats.push(seatNumber);
      draft.seat(seatNumber, seat[2], money(seat[3]), /\bis sitting out\b/i.test(tail));
      // RIO tags the observer's own seat, which is the only reliable hero
      // marker in a file where every seat gets a face-up `Dealt to` line.
      if (/\[hero\]/i.test(tail)) {
        draft.setHero(seat[2]);
      }
      continue;
    }

    const marker = line.match(MARKER_REGEX);
    if (marker) {
      const index = runoutIndexForLabel(marker[1] ?? "");
      const kind = marker[2].replace(/\s+/g, "").toUpperCase();
      // `*** TURN *** [Js Tc 7d] [9h]` restates the board, so the last bracket
      // group is the card that was actually dealt.
      const groups = [...marker[3].matchAll(/\[([^\]]*)\]/g)].map((m) => extractCards(m[1]));
      draft.marker(
        kind === "SHOWDOWN" ? "showdown" : (kind.toLowerCase() as "flop" | "turn" | "river"),
        index,
        marker[1] ?? "",
        groups[groups.length - 1] ?? [],
      );
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS\s*\*\*\*/i.test(line)) {
      draft.holeCardsMarker();
      continue;
    }

    // `STP added: €0.50`, right under the hole-cards marker.
    const stp = line.match(new RegExp(String.raw`^STP added:\s*${MONEY}\s*$`));
    if (stp) {
      houseMoney(money(stp[1]), line);
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

    // `Ricky N collected €26.82 from side pot 1`.
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

    const dead = line.match(new RegExp(String.raw`^(.+?): posts ${MONEY}${SUFFIX}$`));
    if (dead) {
      // Neither room has a straddle, so a bare `posts` is dead money.
      draft.post(dead[1], "missed-blind", money(dead[2]), {
        allIn: allInFrom(dead[3]),
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

    // PokerBros writes `1087383: shows [8h 9h]`; RIO drops the colon and adds
    // its own prose: `Ricky N shows [Ac Jd 5h 4d] for Two Pairs [Ad Ac Kd 5h 5c]`.
    const shows = line.match(/^(.+?):? shows \[([^\]]*)\](?:\s*(?:for |\()(.+?)\)?)?$/);
    if (shows && draft.isSeated(shows[1].trim())) {
      draft.show(shows[1].trim(), extractCards(shows[2]), shows[3], {
        line: lineNo,
        rawLine: line,
      });
      continue;
    }

    const muck = line.match(/^(.+?): (mucks hand|doesn't show hand)$/i);
    if (muck) {
      draft.muck(muck[1], muck[2], { line: lineNo, rawLine: line });
      continue;
    }

    if (CHATTER_REGEX.test(line)) {
      const sittingOut = line.match(/^(.+?)[: ]+(?:is sitting out|sits out)\s*$/i);
      if (sittingOut) {
        draft.markSittingOut(sittingOut[1]);
      }
      continue;
    }

    draft.warn("unknown-line", line, lineNo);
  }

  return result;
}
