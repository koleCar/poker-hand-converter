/**
 * Board texture and the hero's hand on it: the vocabulary of §4.
 *
 * Everything here is a pure function of card codes, Hold'em only, and is
 * written to answer the questions a player asks out loud — "is it paired",
 * "can a flush be out there", "do I have top pair with a good kicker", "what am
 * I drawing to" — in the categories the study grid will use, so the words on a
 * decision and the words on a chart are the same words.
 *
 * Cards are the evaluator's integers (`rank * 4 + suit`, rank 0 = deuce,
 * 12 = ace). Straights are read off the evaluator's own table
 * (`STANDARD.straight`), so "is this a straight" has one answer in the codebase,
 * wheel included.
 */

import { cardIndex, evaluate, categoryOf, STANDARD } from "../equity/evaluator";
import type {
  BlockerClass,
  BoardTexture,
  Connectedness,
  DrawClass,
  HighCardClass,
  KickerClass,
  MadeHand,
  MadeHandClass,
} from "./types";

const ALL_RANKS = 0x1fff;

const rankOf = (card: number) => card >> 2;
const suitOf = (card: number) => card & 3;

/** Card codes to evaluator indices. Throws on junk: the caller has a bug. */
export function toIndices(codes: readonly string[]): number[] {
  return codes.map((code) => {
    const index = cardIndex(code);
    if (index < 0) {
      throw new Error(`not a card: ${code}`);
    }
    return index;
  });
}

function rankMask(cards: readonly number[]): number {
  let mask = 0;
  for (const card of cards) mask |= 1 << rankOf(card);
  return mask;
}

function suitCounts(cards: readonly number[]): number[] {
  const counts = [0, 0, 0, 0];
  for (const card of cards) counts[suitOf(card)] += 1;
  return counts;
}

function isStraight(mask: number): boolean {
  return STANDARD.straight[mask & ALL_RANKS] > 0;
}

/**
 * Unordered rank pairs `(a ≤ b)` that, added to the board, make a straight the
 * board alone does not have. Pairs of the same rank cannot complete a straight
 * that the single rank would not, so they are skipped. 0–(13·14/2).
 */
export function straightCombos(board: readonly number[]): number {
  const mask = rankMask(board);
  if (isStraight(mask)) {
    return 0;
  }
  let count = 0;
  for (let a = 0; a < 13; a += 1) {
    for (let b = a + 1; b < 13; b += 1) {
      if (isStraight(mask | (1 << a) | (1 << b))) {
        count += 1;
      }
    }
  }
  return count;
}

function highCardClass(rank: number): HighCardClass {
  if (rank === 12) return "ace";
  if (rank >= 8) return "broadway";
  if (rank >= 5) return "middle";
  return "low";
}

/** Cards not on the board, as indices. */
function unseen(known: readonly number[]): number[] {
  const out: number[] = [];
  const set = new Set(known);
  for (let card = 0; card < 52; card += 1) {
    if (!set.has(card)) out.push(card);
  }
  return out;
}

/** The thresholds `dynamism` is read off. Part of the analysis version. */
export const STATIC_BELOW = 0.25;
export const DYNAMIC_FROM = 0.45;
/**
 * An overcard that changes nothing else counts half. It moves equities (an
 * ace on `K-7-2` gives every `Ax` a pair) but less than a flush or straight
 * arriving, and counted in full it made every middling rainbow board — `9-7-2`,
 * five overcard ranks — read as dynamic.
 */
export const OVERCARD_WEIGHT = 0.5;

/**
 * §4's board texture. `board` is 3–5 card indices; null before the flop.
 *
 * **Volatility** is the share of unseen cards that would change the board's
 * character: a third (or fourth) card of a suit, a card that adds two or more
 * straight-making holdings at once, or an overcard to the top card. One new
 * straight holding is not counted — `A-K-2` plus a `Q` lets exactly `JT`
 * through, which nobody would call a scare card, and counting it made a
 * textbook static board read as dynamic. An overcard alone counts half (see
 * `OVERCARD_WEIGHT`). The hero's own cards are not removed:
 * texture is a property of the board, the same for both players.
 */
export function boardTexture(board: readonly number[]): BoardTexture | null {
  if (board.length < 3) {
    return null;
  }
  const ranks = board.map(rankOf);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const maxOfRank = Math.max(...counts.values());
  const suits = suitCounts(board);
  const maxSuit = Math.max(...suits);
  const combos = straightCombos(board);
  const mask = rankMask(board);
  const highRank = Math.max(...ranks);
  const connectedness: Connectedness =
    combos === 0 && !isStraight(mask) ? "disconnected" : combos <= 2 && !isStraight(mask) ? "semi-connected" : "connected";

  let volatility: number | null = null;
  if (board.length < 5) {
    const rest = unseen(board);
    let changes = 0;
    for (const card of rest) {
      const next = [...board, card];
      const nextSuits = suitCounts(next);
      const suitStep = nextSuits[suitOf(card)] >= 3 && nextSuits[suitOf(card)] > suits[suitOf(card)];
      const straightStep = straightCombos(next) - combos >= 2 && !isStraight(mask);
      if (suitStep || straightStep) {
        changes += 1;
      } else if (rankOf(card) > highRank) {
        changes += OVERCARD_WEIGHT;
      }
    }
    volatility = changes / rest.length;
  }

  return {
    cards: board.length,
    paired: maxOfRank >= 2,
    trips: maxOfRank >= 3,
    suits: maxSuit >= 3 ? "monotone" : maxSuit === 2 ? "two-tone" : "rainbow",
    flushPossible: maxSuit >= 3,
    straightPossible: combos > 0 || isStraight(mask),
    connectedness,
    straightCombos: combos,
    highRank,
    highCard: highCardClass(highRank),
    volatility: volatility === null ? null : Math.round(volatility * 1000) / 1000,
    dynamism:
      volatility === null ? null : volatility >= DYNAMIC_FROM ? "dynamic" : volatility < STATIC_BELOW ? "static" : "medium",
  };
}

/* ------------------------------------------------------------- made hand - */

/**
 * The kicker of a one-card pair, among the ranks still available: not the
 * paired rank and not a rank already on the board (those cannot out-kick
 * anyone). The best one left is `top`; the next two are `good`.
 */
function kickerClass(kicker: number, pairRank: number, boardRanks: Set<number>): KickerClass {
  let better = 0;
  for (let rank = 12; rank > kicker; rank -= 1) {
    if (rank !== pairRank && !boardRanks.has(rank)) {
      better += 1;
    }
  }
  return better === 0 ? "top" : better <= 2 ? "good" : "weak";
}

/**
 * What the hero holds, in the words a player uses.
 *
 * The evaluator's category says *what the seven cards make*; this says *what
 * the hero has*, which differs whenever the board does the work. A paired
 * board and an unpaired hand is "two pair" to the evaluator and nothing to the
 * hero; three of a kind is a set with a pocket pair and trips with one card.
 * Hence the questions about which hole cards play.
 */
export function madeHand(hole: readonly number[], board: readonly number[]): MadeHand | null {
  if (hole.length !== 2 || board.length < 3) {
    return null;
  }
  const value = evaluate([...hole, ...board]);
  const category = categoryOf(value);
  const boardRanks = new Set(board.map(rankOf));
  const sortedBoard = [...boardRanks].sort((a, b) => b - a);
  const [h1, h2] = [rankOf(hole[0]), rankOf(hole[1])].sort((a, b) => b - a);
  const pocket = h1 === h2;

  // On the river a hand can be entirely the board's; the hero then "plays the
  // board" and holds nothing of their own.
  const playsBoard = board.length === 5 && evaluate(board) === value;

  let made: MadeHandClass;
  let kicker: KickerClass | null = null;

  if (playsBoard) {
    made = "board";
  } else if (category === "straight-flush" || category === "quads" || category === "full-house" || category === "flush" || category === "straight") {
    made = category;
  } else if (category === "trips") {
    if (pocket && boardRanks.has(h1)) {
      made = "set";
    } else if (boardRanks.has(h1) || boardRanks.has(h2)) {
      made = "trips";
    } else {
      // Trips on the board; the hero's cards are kickers.
      made = h1 === 12 ? "ace-high" : "high-card";
    }
  } else if (category === "two-pair" || category === "pair") {
    const paired = [h1, h2].filter((rank) => boardRanks.has(rank));
    if (!pocket && paired.length === 2) {
      made = "two-pair";
    } else if (pocket) {
      if (h1 > sortedBoard[0]) made = "overpair";
      else if (h1 < sortedBoard[sortedBoard.length - 1]) made = "underpair";
      else made = "pocket-pair-below-top";
    } else if (paired.length === 1) {
      const pairRank = paired[0];
      const at = sortedBoard.indexOf(pairRank);
      const other = pairRank === h1 ? h2 : h1;
      // Pairing a rank the board already has twice is trips (handled above);
      // here the board's own pair, if any, is a different rank.
      made = at === 0 ? "top-pair" : at === 1 ? "second-pair" : "weak-pair";
      kicker = kickerClass(other, pairRank, boardRanks);
    } else {
      // The only pair (or both) is on the board.
      made = h1 === 12 ? "ace-high" : "high-card";
    }
  } else {
    made = h1 === 12 ? "ace-high" : "high-card";
  }

  return { class: made, kicker, nuts: false };
}

/* ----------------------------------------------------------------- draws - */

/**
 * Draws the hero's own cards take part in. Flop and turn only — a river has no
 * card to come, and a draw nobody can complete is not a fact worth stating.
 *
 * A straight draw counts its *outs ranks*: two ranks that complete it is
 * eight outs (open-ended, or a double gutter, which plays the same), one is a
 * gutshot. A draw is only the hero's if the board plus that card does not make
 * the same straight on its own.
 */
export function draws(hole: readonly number[], board: readonly number[]): DrawClass[] {
  if (hole.length !== 2 || board.length < 3 || board.length > 4) {
    return [];
  }
  const out: DrawClass[] = [];
  const all = [...hole, ...board];
  const value = evaluate(all);
  const category = categoryOf(value);
  const madeFlush = category === "flush" || category === "straight-flush";
  const madeStraight = category === "straight" || madeFlush;

  // Flush draws: four of a suit with at least one of them the hero's.
  const counts = suitCounts(all);
  const boardCounts = suitCounts(board);
  for (let suit = 0; suit < 4; suit += 1) {
    const mine = hole.filter((card) => suitOf(card) === suit);
    if (mine.length === 0 || madeFlush) continue;
    if (counts[suit] === 4) {
      // The nut draw: the hero holds the best card of the suit not on the board.
      let best = 12;
      while (best >= 0 && board.some((card) => suitOf(card) === suit && rankOf(card) === best)) best -= 1;
      out.push(mine.some((card) => rankOf(card) === best) ? "nut-flush-draw" : "flush-draw");
    } else if (counts[suit] === 3 && board.length === 3 && boardCounts[suit] < 3) {
      out.push("backdoor-flush");
    }
  }

  if (!madeStraight) {
    const mine = rankMask(all);
    const theirs = rankMask(board);
    let outsRanks = 0;
    for (let rank = 0; rank < 13; rank += 1) {
      const bit = 1 << rank;
      if (isStraight(mine | bit) && !isStraight(theirs | bit)) {
        outsRanks += 1;
      }
    }
    if (outsRanks >= 2) out.push("oesd");
    else if (outsRanks === 1) out.push("gutshot");
    else if (board.length === 3) {
      // Backdoor: two running cards make a straight that uses a hole card.
      let backdoor = false;
      for (let a = 0; a < 13 && !backdoor; a += 1) {
        for (let b = a + 1; b < 13; b += 1) {
          const extra = (1 << a) | (1 << b);
          if (isStraight(mine | extra) && !isStraight(theirs | extra)) {
            backdoor = true;
            break;
          }
        }
      }
      if (backdoor) out.push("backdoor-straight");
    }
  }

  const top = Math.max(...board.map(rankOf));
  if (category === "high-card" && hole.every((card) => rankOf(card) > top)) {
    out.push("overcards");
  }
  return out;
}

/* -------------------------------------------------------------- blockers - */

/**
 * Simple blocker facts (§4): which of the hands the opponent most often has
 * here the hero's cards remove.
 *
 * - `nut-flush` / `second-nut-flush`: a flush is possible and the hero holds
 *   the ace (or the king, with the ace on the board or in hand) of that suit.
 * - `nut-straight`: a straight is possible and the hero holds a rank the best
 *   one needs.
 * - `top-pair`: the hero holds a card of the board's top rank, so the
 *   opponent has fewer top pairs.
 * - `set`: the hero holds a card of a board rank, so fewer sets are possible.
 *   Reported only when `top-pair` is not, to keep the list short.
 */
export function blockers(hole: readonly number[], board: readonly number[]): BlockerClass[] {
  if (hole.length !== 2 || board.length < 3) {
    return [];
  }
  const out: BlockerClass[] = [];
  const suits = suitCounts(board);
  for (let suit = 0; suit < 4; suit += 1) {
    if (suits[suit] < 3) continue;
    const onBoard = new Set(board.filter((card) => suitOf(card) === suit).map(rankOf));
    const available: number[] = [];
    for (let rank = 12; rank >= 0 && available.length < 2; rank -= 1) {
      if (!onBoard.has(rank)) available.push(rank);
    }
    const mine = new Set(hole.filter((card) => suitOf(card) === suit).map(rankOf));
    if (available[0] !== undefined && mine.has(available[0])) out.push("nut-flush");
    else if (available[1] !== undefined && mine.has(available[1])) out.push("second-nut-flush");
  }

  // The best straight a two-card holding can make here, and the ranks it needs.
  const mask = rankMask(board);
  let needed: number[] | null = null;
  for (let top = 12; top >= 3 && needed === null; top -= 1) {
    const run = top === 3 ? [12, 0, 1, 2, 3] : [top - 4, top - 3, top - 2, top - 1, top];
    const missing = run.filter((rank) => !(mask & (1 << rank)));
    if (missing.length === 2 || missing.length === 1) {
      needed = missing;
    }
  }
  if (needed && !isStraight(mask) && hole.some((card) => needed!.includes(rankOf(card)))) {
    out.push("nut-straight");
  }

  const top = Math.max(...board.map(rankOf));
  const boardRanks = new Set(board.map(rankOf));
  if (hole.some((card) => rankOf(card) === top)) out.push("top-pair");
  else if (hole.some((card) => boardRanks.has(rankOf(card)))) out.push("set");
  return out;
}
