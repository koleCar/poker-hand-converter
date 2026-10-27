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
 * - RIO adds promotional money to the pot (`STP added: €0.50`), which nobody
 *   contributed and the winner collects - a `PhfChipMovement`, not an action.
 *
 * It is deliberately a dispatcher only. Headers, refusal policy and provenance
 * live in the two site files, because that is where the rooms really differ,
 * and the hand semantics come from `StarsHandDraft`.
 *
 * Owned by parser agent 3; imported by `runitonce.ts` and `pokerbros.ts`.
 */

import { extractCards } from "../../cards";
import {
  ZERO_FEES,
  parseAmount,
  type Amount,
  type CurrencyUnit,
  type PhfChipMovement,
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
  /** Table name and size, so a caller can re-state the table with a fixed button. */
  tableName: string | null;
  maxSeats: number;
  /** The source printed a `*** SUMMARY ***` block. */
  sawSummary: boolean;
  /**
   * Seat that posted the small blind, for rooms whose stated button cannot be
   * trusted. Null when no small blind was posted.
   */
  smallBlindSeat: number | null;
  /**
   * Chips that entered the pot from outside the players.
   *
   * Kept out of `StarsHandDraft`, which only knows about actions, and attached
   * to the built hand by the site parser.
   */
  chipMovements: PhfChipMovement[];
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
): {
  total: Amount;
  pots: Array<{ name: string; amount: Amount }>;
  fees: PhfFees;
  /** What the `STP` column claims, for cross-checking the `STP added:` line. */
  houseChips: Amount;
} | null {
  const columns = line.split("|").map((column) => column.trim());
  const total = columns[0].match(new RegExp(String.raw`^Total pot ${MONEY}\s*$`));
  if (!total) {
    return null;
  }
  const pots: Array<{ name: string; amount: Amount }> = [];
  const fees: PhfFees = { ...ZERO_FEES };
  let houseChips = 0;
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
      houseChips += parseAmount(stp[1], unit);
      continue;
    }
    // Any other column is left alone: it would show up as a pot that does not
    // add up rather than as silently lost money, which is the outcome we want.
  }
  return {
    total: parseAmount(total[1], unit),
    // RIO prints a `Main pot` column whenever it prints an `STP` one, side pot
    // or not. A single-pot hand has no breakdown to report - `results.pots` is
    // documented as empty then - so a lone `Main` is dropped rather than
    // re-emitted as a side-pot structure the table never had.
    pots: pots.some((pot) => pot.name.startsWith("Side")) ? pots : [],
    fees,
    houseChips,
  };
}

/**
 * Promotional money the room itself puts into the pot.
 *
 * RIO's "Splash The Pot" adds house chips (`STP added: €0.50`) that no seat
 * contributed and that the winner then collects. It is a `PhfChipMovement` and
 * deliberately not a `PhfAction`: an action needs a seated player, and charging
 * the splash to one of them would corrupt that player's net and everything
 * computed from it. The validator counts house chips into the pot, so chip
 * conservation holds as `contributions + house === totalPot`.
 */
function houseChipMovement(amount: Amount, line: string): PhfChipMovement {
  return {
    kind: "splash-the-pot",
    fromSeat: null,
    fromPlayer: null,
    toPot: true,
    amount,
    raw: line.trim(),
    // RIO prints it under `*** HOLE CARDS ***`, where GG prints its cash drop
    // above the blinds. The anchor is what lets the text round-trip.
    anchor: "after-hole-cards",
  };
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
  const result: DialectResult = {
    seats: [],
    buttonSeat: null,
    tableName: null,
    maxSeats: 0,
    sawSummary: false,
    smallBlindSeat: null,
    chipMovements: [],
  };
  const seatOf = new Map<string, number>();
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
        // The room states its promotional chips twice, once where it adds them
        // and once in this column. They are the only thing in the pot nobody
        // contributed, so a disagreement between the two is worth surfacing
        // rather than silently trusting whichever came first.
        const added = result.chipMovements.reduce((sum, movement) => sum + movement.amount, 0);
        if (pot.houseChips !== added) {
          draft.warn(
            "house-chips-mismatch",
            `The SUMMARY reports ${pot.houseChips} of promotional chips but ${added} were added.`,
            lineNo,
          );
        }
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
      result.tableName = table[1] || null;
      result.maxSeats = Number(table[2]) || 0;
      draft.setTable(result.tableName, result.maxSeats, result.buttonSeat);
      continue;
    }

    const seat = line.match(SEAT_REGEX);
    if (seat) {
      const tail = seat[4] ?? "";
      const seatNumber = Number(seat[1]);
      result.seats.push(seatNumber);
      seatOf.set(seat[2], seatNumber);
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
      result.chipMovements.push(houseChipMovement(money(stp[1]), line));
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
      const player = uncalled[2].trim();
      const stated = money(uncalled[1]);
      const committed = draft.committed(player);
      const house = result.chipMovements
        .filter((movement) => movement.toPot)
        .reduce((sum, movement) => sum + movement.amount, 0);
      // RIO folds the splash into the figure it prints here: fixture 01 returns
      // `€0.71` to a player who bet `€0.21` into a pot the house had added
      // `€0.50` to, and then hands him `€0.71` again as the collect. Returning
      // the printed number would pay the splash out twice and hand back chips
      // the player never put in. The return is therefore capped at what he
      // actually committed on the street - but only when the excess is exactly
      // the promotional money, so any other overage still fails loudly.
      const amount = stated - committed === house && house > 0 ? committed : stated;
      if (amount !== stated) {
        draft.warn(
          "uncalled-includes-promo",
          `The return of ${stated} to ${player} includes ${house} of promotional chips; ` +
            `${amount} was actually committed and the rest stays in the pot.`,
          lineNo,
        );
      }
      draft.uncalled(player, amount, { line: lineNo, rawLine: line });
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
      if (blind[2].toLowerCase() === "small" && result.smallBlindSeat === null) {
        result.smallBlindSeat = seatOf.get(blind[1]) ?? null;
      }
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
