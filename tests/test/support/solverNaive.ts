/**
 * A deliberately naive reference for the solver's terminal arithmetic.
 *
 * The engine's showdown is two sorted sweeps with inclusion-exclusion over
 * per-card sums, and its chance node masks hands in place. Both are the kind
 * of code that is wrong by one card and still converges - to the wrong answer,
 * with a tiny exploitability measured by the same wrong arithmetic. So this
 * module recomputes best-response and profile values the slow, obvious way:
 * every pair of hands, compatibility by comparing cards, strength straight
 * from `lib/equity`'s `evaluate` on the actual seven cards, never from the
 * game's precomputed orderings. Only the tree's stored payoffs are shared.
 */

import { cardCode, evaluate } from "../../../frontend/src/lib/equity/index.js";
import type { BuiltSubgame } from "../../../frontend/src/lib/solver/subgame.js";
import { ACTION, CHANCE, FOLD, SHOWDOWN } from "../../../frontend/src/lib/solver/tree.js";
import type { Solver } from "../../../frontend/src/lib/solver/cfr.js";

interface Hand {
  a: number;
  b: number;
  w: number;
}

export interface NaiveValues {
  bestResponse: [number, number];
  value: [number, number];
}

export function naiveValues(built: BuiltSubgame, solver: Solver): NaiveValues {
  const { game, board } = built;
  const tree = game.tree;
  const hands: [Hand[], Hand[]] = [0, 1].map((p) =>
    Array.from({ length: game.hands[p].size }, (_, i) => ({
      a: game.hands[p].c1[i],
      b: game.hands[p].c2[i],
      w: game.hands[p].weight[i],
    })),
  ) as [Hand[], Hand[]];
  const strategy = new Map<number, Float32Array>();
  for (let node = 0; node < tree.size; node += 1) {
    if (tree.type[node] === ACTION) {
      strategy.set(node, solver.averageStrategy(node));
    }
  }
  const strengthCache = new Map<string, number>();
  const strength = (h: Hand, cards: number[]) => {
    const key = `${h.a},${h.b},${cards.join(",")}`;
    let v = strengthCache.get(key);
    if (v === undefined) {
      v = evaluate([h.a, h.b, ...cards].map(cardCode));
      strengthCache.set(key, v);
    }
    return v;
  };
  const clash = (x: Hand, y: Hand) => x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b;
  const holds = (h: Hand, card: number) => h.a === card || h.b === card;

  const walk = (node: number, p: number, best: boolean, reach: number[], dealt: number[]): number[] => {
    const mine = hands[p];
    const theirs = hands[1 - p];
    const type = tree.type[node];
    if (type === FOLD || type === SHOWDOWN) {
      const base = node * 6 + p * 3;
      const cards = [...board, ...dealt];
      return mine.map((h) => {
        let v = 0;
        theirs.forEach((o, j) => {
          if (reach[j] === 0 || clash(h, o)) {
            return;
          }
          if (type === FOLD) {
            v += reach[j] * tree.payoff[base];
            return;
          }
          const sh = strength(h, cards);
          const so = strength(o, cards);
          const pay = sh > so ? tree.payoff[base] : sh < so ? tree.payoff[base + 1] : tree.payoff[base + 2];
          v += reach[j] * pay;
        });
        return v;
      });
    }
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    if (type === CHANCE) {
      const out = mine.map(() => 0);
      for (let e = start; e < start + count; e += 1) {
        const card = tree.edgeCard[e];
        const masked = reach.map((r, j) => (holds(theirs[j], card) ? 0 : r));
        const child = walk(tree.children[e], p, best, masked, [...dealt, card]);
        mine.forEach((h, i) => {
          if (!holds(h, card)) {
            // Independent of the tree's stored weight: every card no one
            // can see is equally likely (44 under a turn, 45 under a flop).
            out[i] += child[i] / (52 - board.length - dealt.length - 4);
          }
        });
      }
      return out;
    }
    const s = strategy.get(node) as Float32Array;
    const actor = tree.player[node];
    if (actor === p) {
      const n = mine.length;
      const values = Array.from({ length: count }, (_, a) => walk(tree.children[start + a], p, best, reach, dealt));
      return mine.map((_, i) =>
        best
          ? Math.max(...values.map((v) => v[i]))
          : values.reduce((acc, v, a) => acc + s[a * n + i] * v[i], 0),
      );
    }
    const m = theirs.length;
    const out = mine.map(() => 0);
    for (let a = 0; a < count; a += 1) {
      const child = walk(
        tree.children[start + a],
        p,
        best,
        reach.map((r, j) => r * s[a * m + j]),
        dealt,
      );
      child.forEach((v, i) => {
        out[i] += v;
      });
    }
    return out;
  };

  let norm = 0;
  for (const h of hands[0]) {
    for (const o of hands[1]) {
      if (!clash(h, o)) {
        norm += h.w * o.w;
      }
    }
  }
  const root = (p: number, best: boolean) => {
    const cfv = walk(tree.root, p, best, hands[1 - p].map((h) => h.w), []);
    return cfv.reduce((acc, v, i) => acc + hands[p][i].w * v, 0) / norm;
  };
  return {
    bestResponse: [root(0, true), root(1, true)],
    value: [root(0, false), root(1, false)],
  };
}
