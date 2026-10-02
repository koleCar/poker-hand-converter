/**
 * Heads-up hold'em subgames: the river, and the turn with the river dealt.
 *
 * **Inputs are what a hand history gives**: the board, both ranges (weights
 * per combo, narrowed by everything that happened before), the pot, the
 * effective stack, who acts first, a bet-size menu per player, and the rake.
 * Everything is in one chip unit - big blinds in practice - and every EV the
 * solve reports comes back in that unit.
 *
 * **Players are range indices, not positions.** `ranges[0]` is player 0
 * everywhere: in `menus`, in the result's `hands`, `strategy` and `value`.
 * `firstToAct` says which of them is out of position. That keeps "hero" and
 * "villain" a caller's concern.
 *
 * **River: production.** One street, one showdown ordering, a few dozen nodes;
 * solved to well under 0.5% of the pot in about a second (see the benchmark).
 *
 * **Turn + river: correct, not yet fast enough to be the default.** A chance
 * node deals each of the 48 river cards (the 44 left given both hands, weighted
 * `1/44`, with the hands that hold the card zeroed), and below each one is a
 * full river tree. That is ~48x the river's work and memory per iteration;
 * there is no suit isomorphism on the dealt card and no bucketing of river
 * cards yet. Fine for tests, tools and cached precomputation; not something to
 * run on demand in a browser tab with wide ranges and three sizes.
 */

import { cardCode, evaluateMasks, STANDARD } from "../equity";
import { buildStreet, dealtPath, type BetMenu, type BettingRules, type NodeInfo } from "./betting";
import { comboHi, comboLo, NUM_COMBOS, parseCards, SolverInputError, toRange, type RangeInput } from "./combos";
import { handSet, showdownBoard, type Game, type ShowdownBoard } from "./game";
import { TreeBuilder, type Rake } from "./tree";

export interface SpotInput {
  /** Five cards for a river spot, four for a turn spot. Codes (`"Ah"`) or indices. */
  board: readonly (string | number)[];
  ranges: readonly [RangeInput, RangeInput];
  /** Pot at the start of the street, before any bet on it. */
  pot: number;
  /** Effective stack behind at the start of the street. */
  stack: number;
  /** Which player index acts first (is out of position). Default 0. */
  firstToAct?: 0 | 1;
  /** Bet menus per player index. */
  menus: readonly [BetMenu, BetMenu];
  /** Raises per street after the first bet. Default 2. */
  raiseCap?: number;
  /** Sizes leaving less than this x the pot-after-call behind become all-in. Default 0. */
  allInThreshold?: number;
  /** Smallest bet in chips. Default 0 (any size from the menu is allowed). */
  minBet?: number;
  rake?: Rake;
  /** Chips per big blind, for exploitability in mbb. Default 1 (amounts are in bb). */
  bigBlind?: number;
}

export type RiverSpot = SpotInput;

export interface TurnSpot extends SpotInput {
  /** Menus on the river; defaults to `menus`. */
  riverMenus?: readonly [BetMenu, BetMenu];
}

/** A subgame ready for the engine, plus what the result needs to describe it. */
export interface BuiltSubgame {
  street: "river" | "turn";
  game: Game;
  /** Card indices of the board. */
  board: number[];
  /** `combos[p][i]` is the combo index of player p's hand i. */
  combos: [Uint16Array, Uint16Array];
  /** Per tree node id: betting info for action nodes. */
  info: (NodeInfo | undefined)[];
  /** Per tree node id: path of chance nodes. */
  chancePath: Map<number, string>;
  pot: number;
  stack: number;
  firstToAct: 0 | 1;
}

function rulesOf(spot: SpotInput, menus: readonly [BetMenu, BetMenu]): BettingRules {
  for (const menu of menus) {
    for (const x of [...menu.bet, ...menu.raise]) {
      if (!(x > 0) || !Number.isFinite(x)) {
        throw new SolverInputError(`bet sizes are positive fractions of the pot, got ${x}`);
      }
    }
  }
  return {
    menus,
    raiseCap: spot.raiseCap ?? 2,
    allInThreshold: spot.allInThreshold ?? 0,
    minBet: spot.minBet ?? 0,
  };
}

function validate(spot: SpotInput, cards: number): number[] {
  const board = parseCards(spot.board);
  if (board.length !== cards) {
    throw new SolverInputError(`expected a ${cards}-card board, got ${board.length}`);
  }
  if (!(spot.pot > 0) || !(spot.stack >= 0)) {
    throw new SolverInputError("pot must be positive and stack non-negative");
  }
  if (spot.rake && (!(spot.rake.percent >= 0 && spot.rake.percent < 1) || !(spot.rake.cap >= 0))) {
    throw new SolverInputError("rake percent is a fraction in [0, 1) and the cap non-negative");
  }
  return board;
}

/** The combos of a range that do not touch the board, in combo-index order. */
function handsOf(range: Float64Array, board: readonly number[]) {
  const combos: number[] = [];
  const cards: [number, number][] = [];
  const weights: number[] = [];
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const hi = comboHi(c);
    const lo = comboLo(c);
    if (range[c] > 0 && !board.includes(hi) && !board.includes(lo)) {
      combos.push(c);
      cards.push([hi, lo]);
      weights.push(range[c]);
    }
  }
  if (!combos.length) {
    throw new SolverInputError("a range is empty once the board's cards are removed");
  }
  return { combos: Uint16Array.from(combos), cards, weights };
}

/** Evaluator values of every hand on a five-card board; NaN where a hand holds a board card. */
function strengths(cards: readonly [number, number][], board: readonly number[]): Float64Array {
  const masks = [0, 0, 0, 0];
  for (const card of board) {
    masks[card & 3] |= 1 << (card >> 2);
  }
  const out = new Float64Array(cards.length);
  for (let i = 0; i < cards.length; i += 1) {
    const [a, b] = cards[i];
    if (board.includes(a) || board.includes(b)) {
      out[i] = NaN;
      continue;
    }
    const m = masks.slice();
    m[a & 3] |= 1 << (a >> 2);
    m[b & 3] |= 1 << (b >> 2);
    out[i] = evaluateMasks(STANDARD, m[0], m[1], m[2], m[3]);
  }
  return out;
}

/** Builds the river game for a spot. */
export function buildRiverGame(spot: RiverSpot): BuiltSubgame {
  const board = validate(spot, 5);
  const rules = rulesOf(spot, spot.menus);
  const h0 = handsOf(toRange(spot.ranges[0]), board);
  const h1 = handsOf(toRange(spot.ranges[1]), board);
  const builder = new TreeBuilder();
  const info: (NodeInfo | undefined)[] = [];
  const firstToAct = spot.firstToAct ?? 0;
  const root = buildStreet(
    {
      builder,
      street: "river",
      pot: spot.pot,
      stack: spot.stack,
      rake: spot.rake,
      first: firstToAct,
      rules,
      info,
      close: (c0, c1) => builder.showdown(0, spot.pot, c0, c1, spot.rake),
    },
    [0, 0],
    "",
  );
  const boards: ShowdownBoard[] = [showdownBoard(strengths(h0.cards, board), strengths(h1.cards, board))];
  return {
    street: "river",
    game: {
      tree: builder.finish(root),
      numCards: 52,
      hands: [handSet(0, 52, h0.cards, h0.weights), handSet(1, 52, h1.cards, h1.weights)],
      boards,
      pot: spot.pot,
      bigBlind: spot.bigBlind,
    },
    board,
    combos: [h0.combos, h1.combos],
    info,
    chancePath: new Map(),
    pot: spot.pot,
    stack: spot.stack,
    firstToAct,
  };
}

/** Builds the turn game for a spot: turn betting, a dealt river, river betting. */
export function buildTurnGame(spot: TurnSpot): BuiltSubgame {
  const board = validate(spot, 4);
  const turnRules = rulesOf(spot, spot.menus);
  const riverRules = rulesOf(spot, spot.riverMenus ?? spot.menus);
  const h0 = handsOf(toRange(spot.ranges[0]), board);
  const h1 = handsOf(toRange(spot.ranges[1]), board);
  const builder = new TreeBuilder();
  const info: (NodeInfo | undefined)[] = [];
  const chancePath = new Map<number, string>();
  const firstToAct = spot.firstToAct ?? 0;

  const rivers: number[] = [];
  for (let card = 0; card < 52; card += 1) {
    if (!board.includes(card)) {
      rivers.push(card);
    }
  }
  // Given the turn board and both players' hands, 52 - 4 - 4 cards can come.
  const weight = 1 / (52 - 4 - 4);

  const root = buildStreet(
    {
      builder,
      street: "turn",
      pot: spot.pot,
      stack: spot.stack,
      rake: spot.rake,
      first: firstToAct,
      rules: turnRules,
      info,
      close: (c0, c1, allIn, path) => {
        const edges = rivers.map((card, k) => ({
          label: cardCode(card),
          card,
          child: allIn
            ? builder.showdown(k, spot.pot, c0, c1, spot.rake)
            : buildStreet(
                {
                  builder,
                  street: "river",
                  pot: spot.pot,
                  stack: spot.stack,
                  rake: spot.rake,
                  first: firstToAct,
                  rules: riverRules,
                  info,
                  close: (r0, r1) => builder.showdown(k, spot.pot, r0, r1, spot.rake),
                },
                [c0, c1],
                dealtPath(path, card),
              ),
        }));
        const id = builder.chance(weight, edges);
        chancePath.set(id, path);
        return id;
      },
    },
    [0, 0],
    "",
  );

  const boards = rivers.map((card) =>
    showdownBoard(strengths(h0.cards, [...board, card]), strengths(h1.cards, [...board, card])),
  );
  return {
    street: "turn",
    game: {
      tree: builder.finish(root),
      numCards: 52,
      hands: [handSet(0, 52, h0.cards, h0.weights), handSet(1, 52, h1.cards, h1.weights)],
      boards,
      pot: spot.pot,
      bigBlind: spot.bigBlind,
    },
    board,
    combos: [h0.combos, h1.combos],
    info,
    chancePath,
    pot: spot.pot,
    stack: spot.stack,
    firstToAct,
  };
}
