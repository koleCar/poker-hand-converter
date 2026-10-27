/**
 * Games with known answers, built as ordinary trees for the same engine.
 *
 * They are here, and not in a test file, because they are the solver's
 * calibration: if a change to `cfr.ts` makes Kuhn miss -1/18 or Leduc stop
 * converging, nothing it says about a river can be trusted either. Keeping
 * them next to the engine means a benchmark, a test and a debugging session all
 * build exactly the same game.
 *
 *  - **Kuhn poker** (Kuhn 1950): three cards, one ante, one bet. The first
 *    player's equilibrium value is exactly -1/18.
 *  - **Leduc hold'em** (Southey et al. 2005): six cards, two betting rounds and
 *    a public card - the smallest game with a chance node mid-tree, card
 *    removal and a board that changes hand strength. Its value for the first
 *    player is about -0.0856.
 *  - **The clairvoyance game**: a polarised bettor (nuts or air) against a
 *    bluff-catcher, one bet size. Closed form: bet all nuts, bluff so that
 *    bluffs are `s / (1 + 2s)` of the betting range, and the caller calls
 *    `1 / (1 + s)` - minimum defence frequency.
 */

import { handSet, showdownBoard, type Game } from "./game";
import { TreeBuilder, type Edge } from "./tree";

/** Kuhn poker. Cards 0, 1, 2 are J, Q, K; antes of 1; a bet of 1. */
export function kuhnGame(): Game {
  const b = new TreeBuilder();
  // Contributions include the antes, so payoffs are net chips for the hand.
  const checkCheck = b.showdown(0, 0, 1, 1);
  const checkBetFold = b.fold(0, 0, 1, 2);
  const checkBetCall = b.showdown(0, 0, 2, 2);
  const afterCheckBet = b.action(0, [
    { label: "f", child: checkBetFold },
    { label: "c", child: checkBetCall },
  ]);
  const afterCheck = b.action(1, [
    { label: "k", child: checkCheck },
    { label: "b", child: afterCheckBet },
  ]);
  const betFold = b.fold(1, 0, 2, 1);
  const betCall = b.showdown(0, 0, 2, 2);
  const afterBet = b.action(1, [
    { label: "f", child: betFold },
    { label: "c", child: betCall },
  ]);
  const root = b.action(0, [
    { label: "k", child: afterCheck },
    { label: "b", child: afterBet },
  ]);
  const cards: [number, number][] = [
    [0, -1],
    [1, -1],
    [2, -1],
  ];
  const ones = [1, 1, 1];
  return {
    tree: b.finish(root),
    numCards: 3,
    hands: [handSet(0, 3, cards, ones), handSet(1, 3, cards, ones)],
    boards: [showdownBoard([0, 1, 2], [0, 1, 2])],
    pot: 2,
  };
}

/**
 * Leduc hold'em. Cards `0..5` are J, J, Q, Q, K, K (`rank = card >> 1`); antes
 * of 1; one bet and one raise per round, of 2 in the first round and 4 in the
 * second; player 0 acts first in both rounds. Showdown: a pair with the board
 * wins, otherwise the higher card; equal ranks split.
 */
export function leducGame(): Game {
  const b = new TreeBuilder();
  const numCards = 6;

  const round = (
    second: boolean,
    board: number,
    c: [number, number],
    toAct: number,
    bets: number,
    checked: boolean,
  ): number => {
    const size = second ? 4 : 2;
    const me = toAct;
    const op = 1 - toAct;
    const edges: Edge[] = [];
    const endRound = (c0: number, c1: number): number =>
      second ? b.showdown(board, 0, c0, c1) : deal(c0, c1);
    if (c[op] > c[me]) {
      edges.push({ label: "f", child: b.fold(me, 0, c[0], c[1]) });
      edges.push({ label: "c", child: endRound(c[op], c[op]) });
      if (bets < 2) {
        const next: [number, number] = [c[0], c[1]];
        next[me] = c[op] + size;
        edges.push({ label: "r", child: round(second, board, next, op, bets + 1, checked) });
      }
    } else {
      edges.push({
        label: "k",
        child: checked ? endRound(c[0], c[1]) : round(second, board, c, op, bets, true),
      });
      const next: [number, number] = [c[0], c[1]];
      next[me] = c[op] + size;
      edges.push({ label: "b", child: round(second, board, next, op, bets + 1, checked) });
    }
    return b.action(me, edges);
  };

  const deal = (c0: number, c1: number): number => {
    const edges: Edge[] = [];
    for (let card = 0; card < numCards; card += 1) {
      edges.push({ label: `${"JQK"[card >> 1]}${card & 1}`, card, child: round(true, card, [c0, c1], 0, 0, false) });
    }
    // Given both private cards, four cards remain for the board.
    return b.chance(1 / 4, edges);
  };

  const root = round(false, -1, [1, 1], 0, 0, false);
  const cards: [number, number][] = [];
  for (let card = 0; card < numCards; card += 1) {
    cards.push([card, -1]);
  }
  const ones = new Array(numCards).fill(1);
  const boards = [];
  for (let pub = 0; pub < numCards; pub += 1) {
    const strength = cards.map(([card]) =>
      card === pub ? NaN : (card >> 1) === (pub >> 1) ? 10 + (card >> 1) : card >> 1,
    );
    boards.push(showdownBoard(strength, strength));
  }
  return {
    tree: b.finish(root),
    numCards,
    hands: [handSet(0, numCards, cards, ones), handSet(1, numCards, cards, ones)],
    boards,
    pot: 2,
  };
}

/**
 * The clairvoyance game. Pot 1. Player 0 holds the nuts with probability
 * `nutShare`, air otherwise, and may check (showdown) or bet `betSize` times the
 * pot; player 1 holds a bluff-catcher and may call or fold.
 */
export function clairvoyanceGame(betSize: number, nutShare: number): Game {
  const b = new TreeBuilder();
  const check = b.showdown(0, 1, 0, 0);
  const fold = b.fold(1, 1, betSize, 0);
  const call = b.showdown(0, 1, betSize, betSize);
  const facing = b.action(1, [
    { label: "f", child: fold },
    { label: "c", child: call },
  ]);
  const root = b.action(0, [
    { label: "k", child: check },
    { label: "b", child: facing },
  ]);
  // Distinct cards everywhere: no card removal between the three hands.
  return {
    tree: b.finish(root),
    numCards: 3,
    hands: [
      handSet(0, 3, [[0, -1], [1, -1]], [nutShare, 1 - nutShare]),
      handSet(1, 3, [[2, -1]], [1]),
    ],
    boards: [showdownBoard([2, 0], [1])],
    pot: 1,
  };
}

/** Closed-form equilibrium of `clairvoyanceGame`, valid while air can supply the bluffs. */
export function clairvoyanceSolution(betSize: number, nutShare: number) {
  const s = betSize;
  const v = nutShare;
  const call = 1 / (1 + s);
  const bluffs = (v * s) / (1 + s);
  return {
    /** How often the bluff-catcher calls: MDF, `1 / (1 + s)`. */
    callFrequency: call,
    /** How often air bets. */
    bluffFrequency: bluffs / (1 - v),
    /** Bluffs as a share of the betting range: `s / (1 + 2s)`. */
    bluffShare: s / (1 + 2 * s),
    /** Player 0's value: nuts win the pot plus a called bet; bluffs break even. */
    value: v * (1 + s * call),
  };
}
