/**
 * Measuring equity realisation with the postflop solver.
 *
 * The preflop model (`preflopModel.ts`) values a pot that sees a flop by a
 * realised share per hand class. This module measures that share on real
 * postflop play instead of setting it by hand: for one heads-up spot (two
 * ranges, a pot, the stacks behind, who is in position) it deals a sampled
 * flop and turn, solves the turn and river with `cfr.ts` (the same engine the
 * river and turn solves use), and records, per hand class and player,
 *
 *  - `weight`: probability mass of the class on this board (own range weight
 *    x the opponent's compatible range mass), summed over the class's combos;
 *  - `share`:  the same sum of `weight x EV / pot`, where EV is the solved
 *    root value of the combo (net chips from the start of the turn, the pot
 *    counted as winnable, no rake) - the share of the pot the hand realises,
 *    which can exceed its equity (it wins the opponent's chips too) or fall
 *    below it (it folds);
 *  - `equity`: the same sum of `weight x check-down equity` on the same board
 *    (every river card), the raw equity on exactly the deals the share was
 *    measured on, so the ratio `share / equity` is free of board-sampling
 *    noise in the equity.
 *
 * **What is simplified, and why.** The flop is dealt with no betting: a flop
 * solve is ~50x a turn solve (`subgame.ts`), out of reach for the thousands
 * of spots the generator measures. The turn and river are played with
 * `REALISATION_MENU` (a 75% bet or all-in) at the real stack-to-pot ratio, so
 * implied odds - a set or a flush that wins the stacks - are in the
 * measurement, but a street short. A checked flop gives both players a free
 * card and keeps ranges uncapped; see docs/CHARTS.md §4.2 and §9 for what
 * that does to the numbers.
 *
 * Deterministic: no clock, no random source (the caller samples the boards).
 */

import { buildStreet, type BetMenu, type NodeInfo } from "./betting";
import { Solver } from "./cfr";
import { toRange } from "./combos";
import { handSet, showdownBoard, type Game } from "./game";
import { COMBO_CLASS, NUM_CLASSES } from "./handClasses";
import { handsOf, rulesOf, strengths } from "./subgame";
import { TreeBuilder } from "./tree";

export interface RealisationSpot {
  /** Flop and turn: four card indices. */
  board: readonly number[];
  /** Per-combo range weights (1326) of player 0 and player 1. */
  ranges: readonly [ArrayLike<number>, ArrayLike<number>];
  /** Pot at the flop, in bb. */
  pot: number;
  /** Effective stack behind at the flop, in bb. */
  stack: number;
  /** Player index out of position. */
  firstToAct: 0 | 1;
  menu: BetMenu;
  raiseCap: number;
  iterations: number;
  /**
   * River cards to deal (a sample of the 48 left); every one by default.
   * Sampled river cards are dead: hands holding one are left out of both
   * ranges on this deal, so every pair of hands that meets sees all of them
   * and each is dealt with probability `1 / rivers.length` exactly. (Without
   * that, a pair holding a sampled card would see fewer rivers than the
   * engine's single chance weight assumes, and its showdowns would count for
   * less than its turn folds.)
   */
  rivers?: readonly number[];
}

/** Per player, per class (`[player][class]`), summed over the class's combos. */
export interface RealisationSample {
  weight: [Float64Array, Float64Array];
  share: [Float64Array, Float64Array];
  equity: [Float64Array, Float64Array];
}

/**
 * The menu the generator measures with, on the turn and the river: a 75% pot
 * bet or all-in, and all-in as the only raise. Small on purpose - the river
 * tree is copied once per river card - and still able to get the stacks in
 * over two streets at any stack-to-pot ratio the preflop tree produces.
 */
export const REALISATION_MENU: Readonly<BetMenu> = { bet: [0.75], raise: [], allIn: true };

const CHECK_DOWN: BetMenu = { bet: [], raise: [], allIn: false };

export function emptySample(): RealisationSample {
  const z = () => new Float64Array(NUM_CLASSES);
  return { weight: [z(), z()], share: [z(), z()], equity: [z(), z()] };
}

/** Adds `b` into `a`. */
export function addSample(a: RealisationSample, b: RealisationSample): void {
  for (let p = 0; p < 2; p += 1) {
    for (let i = 0; i < NUM_CLASSES; i += 1) {
      a.weight[p][i] += b.weight[p][i];
      a.share[p][i] += b.share[p][i];
      a.equity[p][i] += b.equity[p][i];
    }
  }
}

interface Built {
  game: Game;
  combos: [Uint16Array, Uint16Array];
}

/**
 * The turn+river game of `subgame.ts`'s `buildTurnGame`, with the river dealt
 * from `rivers` only. Both players' hands are the combos of their ranges that
 * miss the board.
 */
function buildGame(spot: RealisationSpot, menu: BetMenu, raiseCap: number): Built {
  const board = [...spot.board];
  const rules = rulesOf({ board, ranges: spot.ranges, pot: spot.pot, stack: spot.stack, menus: [menu, menu], raiseCap }, [
    menu,
    menu,
  ]);
  const dead = [...board, ...(spot.rivers ?? [])];
  const h0 = handsOf(toRange(spot.ranges[0]), dead);
  const h1 = handsOf(toRange(spot.ranges[1]), dead);
  const rivers = spot.rivers ? [...spot.rivers] : [];
  if (!spot.rivers) {
    for (let card = 0; card < 52; card += 1) if (!board.includes(card)) rivers.push(card);
  }
  const weight = spot.rivers ? 1 / rivers.length : 1 / (52 - 4 - 4);
  const builder = new TreeBuilder();
  const info: (NodeInfo | undefined)[] = [];
  const root = buildStreet(
    {
      builder,
      street: "turn",
      pot: spot.pot,
      stack: spot.stack,
      rake: undefined,
      first: spot.firstToAct,
      rules,
      info,
      close: (c0, c1, allIn) => {
        const edges = rivers.map((card, k) => ({
          label: String(card),
          card,
          child: allIn
            ? builder.showdown(k, spot.pot, c0, c1)
            : buildStreet(
                {
                  builder,
                  street: "river",
                  pot: spot.pot,
                  stack: spot.stack,
                  rake: undefined,
                  first: spot.firstToAct,
                  rules,
                  info,
                  close: (r0, r1) => builder.showdown(k, spot.pot, r0, r1),
                },
                [c0, c1],
                "",
              ),
        }));
        return builder.chance(weight, edges);
      },
    },
    [0, 0],
    "",
  );
  const boards = rivers.map((card) =>
    showdownBoard(strengths(h0.cards, [...board, card]), strengths(h1.cards, [...board, card])),
  );
  return {
    game: {
      tree: builder.finish(root),
      numCards: 52,
      hands: [handSet(0, 52, h0.cards, h0.weights), handSet(1, 52, h1.cards, h1.weights)],
      boards,
      pot: spot.pot,
    },
    combos: [h0.combos, h1.combos],
  };
}

/** Root EV per hand of each player, after `iterations` DCFR iterations. */
function rootEvs(game: Game, iterations: number): [Float64Array, Float64Array] {
  const solver = new Solver(game);
  solver.iterate(iterations);
  return solver.evaluate().rootEv;
}

/** Opponent compatible mass per hand of player `p` (inclusion-exclusion over cards). */
function compatibleMass(game: Game, p: 0 | 1): Float64Array {
  const own = game.hands[p];
  const opp = game.hands[1 - p];
  const cardSum = new Float64Array(54);
  let total = 0;
  const key = new Map<number, number>();
  for (let j = 0; j < opp.size; j += 1) {
    const w = opp.weight[j];
    total += w;
    cardSum[opp.c1[j]] += w;
    cardSum[opp.c2[j]] += w;
    key.set(opp.c1[j] * 64 + opp.c2[j], w);
  }
  const out = new Float64Array(own.size);
  for (let i = 0; i < own.size; i += 1) {
    const a = own.c1[i];
    const b = own.c2[i];
    const same = (key.get(a * 64 + b) ?? 0) + (key.get(b * 64 + a) ?? 0);
    out[i] = total - cardSum[a] - cardSum[b] + same;
  }
  return out;
}

/** Solves one spot on one board and returns its per-class sums. */
export function measureRealisation(spot: RealisationSpot): RealisationSample {
  const played = buildGame(spot, spot.menu, spot.raiseCap);
  const checked = buildGame(spot, CHECK_DOWN, 0);
  const ev = rootEvs(played.game, spot.iterations);
  const eq = rootEvs(checked.game, 1);
  const out = emptySample();
  for (const p of [0, 1] as const) {
    const mass = compatibleMass(played.game, p);
    const hands = played.game.hands[p];
    const combos = played.combos[p];
    for (let i = 0; i < hands.size; i += 1) {
      const w = hands.weight[i] * mass[i];
      if (w <= 0) continue;
      const c = COMBO_CLASS[combos[i]];
      out.weight[p][c] += w;
      out.share[p][c] += (w * ev[p][i]) / spot.pot;
      out.equity[p][c] += (w * eq[p][i]) / spot.pot;
    }
  }
  return out;
}
