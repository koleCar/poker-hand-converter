/**
 * High-low split: which collect paid which half of the pot.
 *
 * Rooms disagree about whether they say. Full Tilt writes `wins the high pot`,
 * partypoker `wins Lo (...)`, Bovada puts `HI 30` / `LOW 30` in its summary -
 * but PokerStars, whose text is the format this project writes, prints neither:
 *
 *     Crazy Elior collected $2637.50 from main pot
 *     LewisFriend collected $2637.50 from main pot
 *
 * and that is the text Holdem Manager imports, so it is also the text a hand has
 * to come back from. The halves therefore cannot be a fact the text carries;
 * they have to be a fact the text *implies*. They are: at a showdown the cards
 * are on the table, and the high hand and the eight-or-better low among the
 * players who were paid say exactly who was paid for what. That is what this
 * module computes, once, for both PHF builders - `parseStandardHand` and
 * `StarsHandDraft.build` - so a hand parsed from a room and the same hand read
 * back from its standard text cannot disagree.
 *
 * A room's own labels are not thrown away: `checkStatedHalves` compares them to
 * the evaluation and warns on any difference, which is how a parser earns its
 * place on the hi/lo allowlist.
 *
 * **Only the players who were paid are evaluated**, per pot, never the whole
 * table. A side pot's high is not the best hand at the table - the all-in
 * player who holds it is not eligible - but it is always the best hand among
 * the side pot's own winners, and the same holds for the low. Comparing winners
 * with winners needs no reconstruction of who was eligible for what.
 */

import { evaluateOmaha, evaluateOmahaLow } from "../equity/omaha";
import {
  holeCardCount,
  resolveRunout,
  type Amount,
  type PhfAction,
  type PhfHand,
  type PhfWarning,
  type PotHalf,
} from "./types";

/**
 * Comparison key for a pot name: `main pot`, `Main`, `the main pot` agree, and
 * `side pot-1` / `side pot 1` do too. The same normalisation the replayer uses
 * to pair collects with the summary's pot list.
 */
export function hiLoPotKey(name: string | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\bpots?\b/g, "")
    .replace(/[\s-]+/g, " ")
    .trim();
}

/** The collects of one pot on one runout, in stream order. */
interface PotGroup {
  runoutIndex: number;
  key: string;
  collects: PhfAction[];
}

/** Groups a hand's collects by runout and pot, keeping stream order. */
export function hiLoPotGroups(hand: PhfHand): PotGroup[] {
  const groups = new Map<string, PotGroup>();
  for (const action of hand.actions) {
    if (action.type !== "collect") continue;
    const key = hiLoPotKey(action.potName);
    const id = `${action.runoutIndex}|${key}`;
    let group = groups.get(id);
    if (!group) {
      group = { runoutIndex: action.runoutIndex, key, collects: [] };
      groups.set(id, group);
    }
    group.collects.push(action);
  }
  return [...groups.values()];
}

/**
 * Sets `half` on every collect of a hi/lo hand, mirrors it onto
 * `results.winners`, and returns what it could not settle.
 *
 * Per pot (and per runout, after a run-it-twice):
 *
 *  - **Nobody contested it** - one player left in the hand - and nothing is
 *    split: every `half` stays absent.
 *  - **No paid player holds a qualifying low** - every collect is `hi`. The
 *    whole pot went high, which is what PokerStars' `No low hand qualified`
 *    line says in words.
 *  - Otherwise each paid player is placed by the hands: best high only ->
 *    `hi`; best low only -> `lo`; both, on two lines -> the first `hi` and the
 *    second `lo` (the order every room in the corpus prints, and the order the
 *    serializer writes); both, alone, on one line -> a scoop, left absent.
 *
 * Anything else - a paid player whose cards are unknown while the pot was
 * split, one the hands say won neither half, a merged line that mixes a high
 * share with a low one - is left absent and reported as
 * `hi-lo-split-unresolved`. Parsers whose fixtures produce that warning stay
 * off the hi/lo allowlist.
 *
 * Idempotent, and a no-op for a hand that is not hi/lo.
 */
export function assignHiLoHalves(hand: PhfHand): PhfWarning[] {
  if (!hand.game.hiLo) {
    return [];
  }
  const warnings: PhfWarning[] = [];
  const unresolved = (message: string) =>
    warnings.push({ code: "hi-lo-split-unresolved", message });

  for (const action of hand.actions) {
    delete action.half;
  }

  const folded = new Set(
    hand.actions.filter((action) => action.type === "fold").map((action) => action.player),
  );
  const acted = new Set(hand.actions.map((action) => action.player));
  const contenders = hand.players.filter(
    (player) => acted.has(player.name) && !folded.has(player.name),
  );

  if (contenders.length >= 2) {
    const dealt = holeCardCount(hand.game.variant);
    const cardsOf = (name: string): string[] | null => {
      const player = hand.players.find((entry) => entry.name === name);
      if (!player) return null;
      const cards = player.holeCards;
      return dealt !== null && cards.length === dealt ? cards : null;
    };

    for (const group of hiLoPotGroups(hand)) {
      const label = group.key || "pot";
      const board = resolveRunout(hand.board, group.runoutIndex);
      const collectors = [...new Set(group.collects.map((action) => action.player))];
      const known = collectors.map((name) => ({ name, cards: cardsOf(name) }));

      if (board.length < 5 || known.some((entry) => entry.cards === null)) {
        // A hand or the board is not known. With one player paid that is a
        // scoop or a pot that went high, and the room did not say which; the
        // money is right either way, and absent already means "not known to
        // be split". With several, the split itself is lost.
        if (collectors.length > 1) {
          unresolved(
            `The ${label} was paid to ${collectors.join(", ")}, but ` +
              (board.length < 5
                ? "the board was not dealt out"
                : "not every one of them showed a full hand") +
              ", so which half each was paid cannot be told.",
          );
        }
        continue;
      }

      const hi = new Map<string, number>();
      const lo = new Map<string, number | null>();
      for (const entry of known) {
        hi.set(entry.name, evaluateOmaha(entry.cards!, board));
        lo.set(entry.name, evaluateOmahaLow(entry.cards!, board));
      }
      const bestHi = Math.max(...hi.values());
      const lows = [...lo.values()].filter((value): value is number => value !== null);

      if (lows.length === 0) {
        for (const action of group.collects) action.half = "hi";
        continue;
      }

      const bestLo = Math.min(...lows);
      for (const name of collectors) {
        const lines = group.collects.filter((action) => action.player === name);
        const wonHi = hi.get(name) === bestHi;
        const wonLo = lo.get(name) === bestLo;
        if (wonHi && !wonLo) {
          for (const action of lines) action.half = "hi";
        } else if (wonLo && !wonHi) {
          for (const action of lines) action.half = "lo";
        } else if (wonHi && wonLo && lines.length === 2) {
          lines[0].half = "hi";
          lines[1].half = "lo";
        } else if (wonHi && wonLo && lines.length === 1 && collectors.length === 1) {
          // A scoop on one line: both halves, so neither label.
        } else {
          unresolved(
            wonHi || wonLo
              ? `${name} won both halves of the ${label} against other winners, on ` +
                  `${lines.length} line(s), so the high and low shares cannot be separated.`
              : `${name} was paid from the ${label}, but holds neither its best high ` +
                  "nor its best low.",
          );
        }
      }
    }
  }

  // Winners are one per collect, but paired by player, amount and runout
  // rather than by position, the same way the replayer pairs them.
  const collects = hand.actions.filter((action) => action.type === "collect");
  const claimed = new Set<number>();
  hand.results.winners = hand.results.winners.map((winner) => {
    const rest = { ...winner };
    delete rest.half;
    const index = collects.findIndex(
      (action, i) =>
        !claimed.has(i) &&
        action.player === winner.player &&
        action.amount === winner.amount &&
        action.runoutIndex === winner.runoutIndex,
    );
    if (index < 0) return rest;
    claimed.add(index);
    const half = collects[index].half;
    return half ? { ...rest, half } : rest;
  });
  return warnings;
}

/**
 * Shown hands the main pot's payout contradicts: a player who showed a better
 * high than everyone the main pot paid, or a qualifying low better than any
 * low it paid, and got nothing for it.
 *
 * `assignHiLoHalves` only compares winners with winners, which is what makes
 * it safe for side pots - but it also means a payout that skipped a better hand
 * would be labelled without complaint. The main pot is the one pot every
 * player still in the hand is eligible for, so there the comparison can widen
 * to everyone who *showed*. A muck is excluded even when the room printed the
 * cards: mucking concedes the pot, however good the hand.
 *
 * Only `pot` / `main pot` groups are checked; a pot named anything else may
 * have excluded an all-in player, and nothing here reconstructs eligibility.
 */
export function hiLoPayoutContradictions(hand: PhfHand): string[] {
  if (!hand.game.hiLo) {
    return [];
  }
  const dealt = holeCardCount(hand.game.variant);
  const shown = new Set(
    hand.actions.filter((action) => action.type === "show").map((action) => action.player),
  );
  const showers = hand.players.filter(
    (player) => shown.has(player.name) && dealt !== null && player.holeCards.length === dealt,
  );
  const problems: string[] = [];
  for (const group of hiLoPotGroups(hand)) {
    if (group.key !== "" && group.key !== "main") continue;
    const board = resolveRunout(hand.board, group.runoutIndex);
    if (board.length < 5 || showers.length === 0) continue;
    const paid = new Set(group.collects.map((action) => action.player));
    const known = hand.players.filter(
      (player) => paid.has(player.name) && dealt !== null && player.holeCards.length === dealt,
    );
    if (known.length !== paid.size) continue;

    const paidHi = Math.max(...known.map((player) => evaluateOmaha(player.holeCards, board)));
    const paidLows = known
      .map((player) => evaluateOmahaLow(player.holeCards, board))
      .filter((value): value is number => value !== null);
    const paidLo = paidLows.length > 0 ? Math.min(...paidLows) : null;
    for (const player of showers) {
      if (paid.has(player.name)) continue;
      if (evaluateOmaha(player.holeCards, board) > paidHi) {
        problems.push(
          `${player.name} showed a better high hand than anyone the ${group.key || "pot"} ` +
            "paid, and was paid nothing.",
        );
      }
      const low = evaluateOmahaLow(player.holeCards, board);
      if (low !== null && (paidLo === null || low < paidLo)) {
        problems.push(
          `${player.name} showed a qualifying low better than any the ${group.key || "pot"} ` +
            "paid, and was paid nothing.",
        );
      }
    }
  }
  return problems;
}

/** PokerStars' line for a hi/lo pot that went entirely high. */
export const NO_LOW_LINE = /^No low hand qualified\s*$/i;

/**
 * The check behind a room's `No low hand qualified`: the hands must agree that
 * nothing was paid low. Called by parsers that saw the line.
 */
export function checkNoLowStated(hand: PhfHand): PhfWarning[] {
  return hand.actions.some((action) => action.half === "lo")
    ? [
        {
          code: "hi-lo-half-mismatch",
          message: "The text says no low hand qualified, but a low half was paid.",
        },
      ]
    : [];
}

/** What a room printed about one award, for `checkStatedHalves`. */
export interface StatedAward {
  player: string;
  amount: Amount;
  /** The half the room named, or undefined when it did not say. */
  half?: PotHalf;
}

/**
 * Compares the halves a room printed with the ones `assignHiLoHalves` worked
 * out, and warns on every difference.
 *
 * `stated` is in the order the hand's collects were emitted. An award the room
 * did not label is not checked; one it labelled must match exactly - a room
 * that says `wins the high pot` while the cards say the whole pot was a scoop
 * is a disagreement worth a warning, not a rounding difference.
 */
export function checkStatedHalves(hand: PhfHand, stated: StatedAward[]): PhfWarning[] {
  const collects = hand.actions.filter((action) => action.type === "collect");
  const warnings: PhfWarning[] = [];
  const claimed = new Set<number>();
  for (const award of stated) {
    const index = collects.findIndex(
      (action, i) =>
        !claimed.has(i) && action.player === award.player && action.amount === award.amount,
    );
    if (index < 0) continue;
    claimed.add(index);
    if (award.half && collects[index].half !== award.half) {
      warnings.push({
        code: "hi-lo-half-mismatch",
        message:
          `The room paid ${award.player} the ${award.half === "hi" ? "high" : "low"} half, ` +
          `but the hands say ${
            collects[index].half === "hi"
              ? "the high half"
              : collects[index].half === "lo"
                ? "the low half"
                : "an unsplit pot"
          }.`,
      });
    }
  }
  return warnings;
}

/**
 * The same check for a room that states each seat's high and low winnings as
 * totals rather than per collect - Bovada's summary `HI 2370` / `LOW 30`,
 * summed over every pot the seat was paid from.
 *
 * A seat whose awards include an unlabelled one (a single-line scoop) is not
 * checked when the room says it was paid low: both halves sit in one figure
 * there and cannot be compared half by half.
 */
export function checkStatedTotals(
  hand: PhfHand,
  stated: Map<string, { hi: Amount; lo: Amount }>,
): PhfWarning[] {
  const warnings: PhfWarning[] = [];
  for (const [player, room] of stated) {
    const collects = hand.actions.filter(
      (action) => action.type === "collect" && action.player === player,
    );
    const unlabelled = collects.some((action) => !action.half);
    if (unlabelled && room.lo > 0) continue;
    const sum = (keep: (action: PhfAction) => boolean) =>
      collects.filter(keep).reduce((total, action) => total + action.amount, 0);
    const hi = sum((action) => action.half !== "lo");
    const lo = sum((action) => action.half === "lo");
    if (hi !== room.hi || lo !== room.lo) {
      warnings.push({
        code: "hi-lo-half-mismatch",
        message:
          `The room paid ${player} ${room.hi} high and ${room.lo} low, but the hands ` +
          `say ${hi} high and ${lo} low.`,
      });
    }
  }
  return warnings;
}

/**
 * Orders draft awards the way PokerStars prints them: within each pot, every
 * high share before any low share; otherwise the room's own order.
 *
 * `assignHiLoHalves` reads a player's two lines in one pot as high-then-low,
 * so a builder that writes standard text from a room which prints the low
 * first (or interleaves pots) has to put them in this order first.
 */
export function orderHiLoAwards<T extends { half?: PotHalf; potName?: string }>(
  awards: T[],
): T[] {
  const rank = (award: T) => (award.half === "lo" ? 1 : 0);
  const potOrder = new Map<string, number>();
  for (const award of awards) {
    const key = hiLoPotKey(award.potName);
    if (!potOrder.has(key)) potOrder.set(key, potOrder.size);
  }
  return awards
    .map((award, index) => ({ award, index }))
    .sort(
      (a, b) =>
        potOrder.get(hiLoPotKey(a.award.potName))! - potOrder.get(hiLoPotKey(b.award.potName))! ||
        rank(a.award) - rank(b.award) ||
        a.index - b.index,
    )
    .map((entry) => entry.award);
}
