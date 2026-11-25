/**
 * The Trainer's Details (#424): what the short *why* above them does not
 * already say, as keys the dictionary words (`trainer.details`):
 *
 * - the size: whether another bet size earns more than the one played, or a
 *   check (a call) more than every bet (raise), or a bet more than the check;
 * - a bluff's blockers on the river: which cards are good to hold (they
 *   remove hands that call) and which are bad (they remove the missed draws
 *   that fold), and which of the hero's cards are which.
 *
 * Built only from the graded decision (its options' EVs, the board and the
 * hole cards); pure.
 */

import type { DecisionAnalysis, OptionAnalysis } from "../analysis/types";

/** Below this many big blinds two options are worth the same. */
const SAME_BB = 0.005;

const isAggressive = (option: Pick<OptionAnalysis, "action">) => option.action === "bet" || option.action === "raise";

/**
 * Option indices into `decision.options`; `bb` is an EV difference, ≥ 0.
 * `raise`: the sizes are raises (facing a bet), not bets; `sizes`: how many
 * bet (raise) sizes the solve has here.
 */
export type SizingNote = { raise: boolean; sizes: number } & (
  /** You bet (raised) and another size earns `bb` more: `better` over `chosen`. */
  | { kind: "size-better"; better: number; chosen: number; bb: number }
  /** You bet (raised) the best of two or more sizes: `chosen` over the `next` best size (`bb` 0: the same). */
  | { kind: "size-best"; chosen: number; next: number; bb: number }
  /** The check (call) earns `bb` more than the best bet (raise), `best`. */
  | { kind: "passive-better"; passive: number; best: number; bb: number }
  /** You checked (called) and a bet (raise) earns `bb` more: `best`, the best size. */
  | { kind: "aggressive-better"; best: number; chosen: number; bb: number }
  /** You checked (called) and that was right: the best bet (raise), `best`, earns `bb` less (0: the same). */
  | { kind: "passive-right"; chosen: number; best: number; bb: number }
);

/** The highest-EV option of `indices`, or null for none. */
function bestOf(options: readonly OptionAnalysis[], indices: number[]): number | null {
  let best: number | null = null;
  for (const index of indices) if (best === null || options[index].ev > options[best].ev + 1e-9) best = index;
  return best;
}

/**
 * The size, said against the solved options: postflop solver grades only
 * (a chart's preflop raise has one size), and only where a bet or a raise
 * was an option.
 */
export function sizingNotes(decision: DecisionAnalysis): SizingNote[] {
  if (decision.source !== "solver" || decision.street === "preflop" || decision.chosen === null) return [];
  const options = decision.options;
  const chosen = decision.chosen;
  if (!options[chosen]) return [];
  const sizes = options.flatMap((option, index) => (isAggressive(option) ? [index] : []));
  const passives = options.flatMap((option, index) => (option.action === "check" || option.action === "call" ? [index] : []));
  const bestSize = bestOf(options, sizes);
  const bestPassive = bestOf(options, passives);
  if (bestSize === null) return [];
  const out: SizingNote[] = [];
  const common = { raise: options[bestSize].action === "raise", sizes: sizes.length };

  if (isAggressive(options[chosen])) {
    const gain = options[bestSize].ev - options[chosen].ev;
    if (bestSize !== chosen && gain > SAME_BB) {
      out.push({ ...common, kind: "size-better", better: bestSize, chosen, bb: gain });
    } else {
      const next = bestOf(
        options,
        sizes.filter((index) => index !== chosen),
      );
      if (next !== null) {
        const over = options[chosen].ev - options[next].ev;
        out.push({ ...common, kind: "size-best", chosen, next, bb: over > SAME_BB ? over : 0 });
      }
    }
    if (bestPassive !== null) {
      const over = options[bestPassive].ev - options[bestSize].ev;
      if (over > SAME_BB) out.push({ ...common, kind: "passive-better", passive: bestPassive, best: bestSize, bb: over });
    }
  } else if (options[chosen].action === "check" || options[chosen].action === "call") {
    const gain = options[bestSize].ev - options[chosen].ev;
    out.push(
      gain > SAME_BB
        ? { ...common, kind: "aggressive-better", best: bestSize, chosen, bb: gain }
        : { ...common, kind: "passive-right", chosen, best: bestSize, bb: -gain > SAME_BB ? -gain : 0 },
    );
  }
  return out;
}

/* ------------------------------------------------------------ blockers - */

export type BlockerGroup =
  /** The best cards of a suit with three or more on the board: they remove the (nut) flushes. */
  | { kind: "flush"; cards: string[] }
  /** The ranks the best straight needs. */
  | { kind: "straight"; ranks: string[] }
  /** The board's top rank: it removes top pair. */
  | { kind: "top-pair"; ranks: string[] }
  /** A suit with two on the turn that the river missed: it removes the missed flush draws. */
  | { kind: "missed-flush"; suit: string }
  /** The ranks of the open-ended straight draws the river missed. */
  | { kind: "missed-straight"; ranks: string[] };

export interface BluffBlockers {
  /** Cards that remove hands that call a bluff. */
  good: BlockerGroup[];
  /** Cards that remove hands that fold to it. */
  bad: BlockerGroup[];
  /** The hero's hole cards (`Ks`) that are good blockers, and bad ones. */
  mine: { good: string[]; bad: string[] };
}

const RANKS = "23456789TJQKA";

function parse(code: string): { rank: number; suit: string } | null {
  const rank = RANKS.indexOf(code[0]?.toUpperCase() ?? "");
  const suit = code[1]?.toLowerCase();
  return rank < 0 || !suit ? null : { rank, suit };
}

function maskOf(ranks: readonly number[]): number {
  let mask = 0;
  for (const rank of ranks) mask |= 1 << rank;
  return mask;
}

/** Five ranks in a row in `mask`, the wheel (A-2-3-4-5) included. */
function hasStraight(mask: number): boolean {
  // Bit 0 is the ace below the deuce, bit r + 1 rank r.
  const bits = (mask << 1) | ((mask >> 12) & 1);
  for (let start = 0; start <= 9; start += 1) {
    const run = 0b11111 << start;
    if ((bits & run) === run) return true;
  }
  return false;
}

/** Straight-draw outs: ranks that, added, make a straight the cards do not have yet. */
function outRanks(mask: number): number {
  let count = 0;
  for (let rank = 0; rank < 13; rank += 1) if (hasStraight(mask | (1 << rank)) && !hasStraight(mask)) count += 1;
  return count;
}

/**
 * The river's bluff blockers, for a hand that bets as a bluff: no bet to
 * face, and the solve reads it as air. Null anywhere else, or on a board
 * with nothing to block.
 */
export function bluffBlockers(decision: DecisionAnalysis): BluffBlockers | null {
  const f = decision.facts;
  const river = decision.source === "solver" ? f.river : null;
  if (decision.street !== "river" || !river || river.role !== "air" || f.toCallBb > 0) return null;
  const board = f.board.map(parse);
  const hole = f.holeCards.map(parse);
  if (board.length !== 5 || hole.length !== 2 || board.some((c) => !c) || hole.some((c) => !c)) return null;
  const cards = board as Array<{ rank: number; suit: string }>;
  const mine = hole as Array<{ rank: number; suit: string }>;
  const boardMask = maskOf(cards.map((c) => c.rank));
  const good: BlockerGroup[] = [];
  const bad: BlockerGroup[] = [];

  // Flushes: the two best cards of a suit with three or more on the board.
  const suits = [...new Set(cards.map((c) => c.suit))];
  for (const suit of suits) {
    const on = cards.filter((c) => c.suit === suit);
    if (on.length < 3) continue;
    const best: string[] = [];
    for (let rank = 12; rank >= 0 && best.length < 2; rank -= 1) {
      if (!on.some((c) => c.rank === rank)) best.push(`${RANKS[rank]}${suit}`);
    }
    good.push({ kind: "flush", cards: best });
  }

  // The best straight: the ranks it needs from the hand (one or two).
  const straightRanks: number[] = [];
  if (!hasStraight(boardMask)) {
    for (let top = 12; top >= 3 && straightRanks.length === 0; top -= 1) {
      const run = top === 3 ? [12, 0, 1, 2, 3] : [top - 4, top - 3, top - 2, top - 1, top];
      const missing = run.filter((rank) => !(boardMask & (1 << rank)));
      if (missing.length === 1 || missing.length === 2) straightRanks.push(...missing);
    }
    if (straightRanks.length > 0) good.push({ kind: "straight", ranks: straightRanks.map((r) => RANKS[r]).reverse() });
  }

  // Top pair: the board's top rank, when it is there once.
  const top = Math.max(...cards.map((c) => c.rank));
  if (cards.filter((c) => c.rank === top).length === 1 && !straightRanks.includes(top)) {
    good.push({ kind: "top-pair", ranks: [RANKS[top]] });
  }

  // Missed flush draws: a suit two cards of which came by the turn, the river not of it.
  const turnCards = cards.slice(0, 4);
  const riverCard = cards[4];
  for (const suit of suits) {
    if (turnCards.filter((c) => c.suit === suit).length === 2 && riverCard.suit !== suit) bad.push({ kind: "missed-flush", suit });
  }

  // Missed straight draws: two ranks off the board that made an open-ended
  // draw (or a double gutshot) on the turn and no straight on the river.
  const turnMask = maskOf(turnCards.map((c) => c.rank));
  const missed = new Set<number>();
  if (!hasStraight(turnMask)) {
    for (let a = 0; a < 13; a += 1) {
      for (let b = a + 1; b < 13; b += 1) {
        if (boardMask & ((1 << a) | (1 << b))) continue;
        const hand = turnMask | (1 << a) | (1 << b);
        if (hasStraight(hand) || outRanks(hand) < 2) continue;
        // The draw must use both cards: one alone has the same outs otherwise.
        if (outRanks(turnMask | (1 << a)) >= 2 || outRanks(turnMask | (1 << b)) >= 2) continue;
        if (hasStraight(boardMask | (1 << a) | (1 << b))) continue;
        missed.add(a);
        missed.add(b);
      }
    }
  }
  for (const rank of straightRanks) missed.delete(rank);
  if (missed.size > 0) {
    bad.push({
      kind: "missed-straight",
      ranks: [...missed].sort((x, y) => y - x).map((r) => RANKS[r]),
    });
  }

  if (good.length === 0 && bad.length === 0) return null;
  const code = (c: { rank: number; suit: string }) => `${RANKS[c.rank]}${c.suit}`;
  const inGroup = (c: { rank: number; suit: string }, group: BlockerGroup) => {
    switch (group.kind) {
      case "flush":
        return group.cards.includes(code(c));
      case "straight":
      case "top-pair":
      case "missed-straight":
        return group.ranks.includes(RANKS[c.rank]);
      case "missed-flush":
        return c.suit === group.suit;
    }
  };
  return {
    good,
    bad,
    mine: {
      good: mine.filter((c) => good.some((g) => inGroup(c, g))).map(code),
      bad: mine.filter((c) => !good.some((g) => inGroup(c, g)) && bad.some((g) => inGroup(c, g))).map(code),
    },
  };
}
