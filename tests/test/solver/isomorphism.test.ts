/**
 * Suit isomorphism: relabelling suits must not change the answer, and every
 * relabelling of a spot must canonicalise to the same input - which is what
 * lets the cache serve one solve to all of them.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalBoard,
  canonicalSpot,
  encodeSolution,
  inversePermutation,
  NUM_COMBOS,
  parseRange,
  permuteCard,
  permuteCombo,
  permuteRange,
  solveRiver,
  SUIT_PERMUTATIONS,
  type BetMenu,
} from "../../../frontend/src/lib/solver/index.js";
import { cardCode, cardIndex } from "../../../frontend/src/lib/equity/index.js";

const MENU: BetMenu = { bet: [0.5, 1], raise: [1], allIn: true };
// Deliberately suit-asymmetric: specific suited combos, and a flush draw that got there.
const RANGES: [string, string] = [
  "AA,KK,77,44,AKs,AhQh,KhQh,QhJh,Th9h,8h7h,AQo,KJo,A5s:0.5,65s",
  "QQ-TT,AK,AJs,KQs,Jh9h,Ts9s,98s,A4s,54s:0.7,KQo",
];
const BOARD = ["Ah", "Kd", "7c", "4h", "2h"];

function relabel(perm: readonly number[]) {
  return {
    board: BOARD.map((code) => cardCode(permuteCard(cardIndex(code), perm))),
    ranges: [permuteRange(parseRange(RANGES[0]), perm), permuteRange(parseRange(RANGES[1]), perm)] as [
      Float64Array,
      Float64Array,
    ],
  };
}

describe("suit permutations", () => {
  it("are the 24 bijections, each undone by its inverse", () => {
    expect(SUIT_PERMUTATIONS).toHaveLength(24);
    expect(new Set(SUIT_PERMUTATIONS.map((p) => p.join(""))).size).toBe(24);
    for (const perm of SUIT_PERMUTATIONS) {
      const inverse = inversePermutation(perm);
      for (let combo = 0; combo < NUM_COMBOS; combo += 1) {
        expect(permuteCombo(permuteCombo(combo, perm), inverse)).toBe(combo);
      }
    }
  });
});

describe("canonical board", () => {
  it("gives the highest flop card spades and the next new suit hearts", () => {
    expect(canonicalBoard(["Ah", "Kd", "7c"]).board).toEqual(["As", "Kh", "7d"]);
    expect(canonicalBoard(["7c", "Kd", "Ah"]).board).toEqual(["As", "Kh", "7d"]);
    expect(canonicalBoard(["Ah", "Kh", "7c"]).board).toEqual(["As", "Ks", "7h"]);
  });

  it("keeps the turn and river in place - the flop is a set, the rest is not", () => {
    expect(canonicalBoard(["Ah", "Kd", "7c", "2s", "3h"]).board).toEqual(["As", "Kh", "7d", "2c", "3s"]);
    expect(canonicalBoard(["Ah", "Kd", "7c", "2s"]).board).not.toEqual(
      canonicalBoard(["Ah", "Kd", "2s", "7c"]).board,
    );
  });

  it("is the same for every relabelling, and lists the interchangeable suits", () => {
    for (const perm of SUIT_PERMUTATIONS) {
      expect(canonicalBoard(relabel(perm).board).board).toEqual(canonicalBoard(BOARD).board);
    }
    // A monotone flop leaves the other three suits free: 3! permutations.
    expect(canonicalBoard(["Ah", "Kh", "7h"]).perms).toHaveLength(6);
  });
});

describe("isomorphic spots", () => {
  const solve = (board: string[], ranges: [ArrayLike<number>, ArrayLike<number>]) =>
    solveRiver(
      { board, ranges, pot: 10, stack: 40, menus: [MENU, MENU], raiseCap: 2 },
      { maxIterations: 300, targetExploitability: 0 },
    );

  it("get the same strategy, combo for combo", () => {
    const original = solve(BOARD, [parseRange(RANGES[0]), parseRange(RANGES[1])]);
    for (const perm of [SUIT_PERMUTATIONS[7], SUIT_PERMUTATIONS[22]]) {
      const spot = relabel(perm);
      const permuted = solve(spot.board, spot.ranges);
      expect(permuted.nodes.map((n) => n.path)).toEqual(original.nodes.map((n) => n.path));
      expect(permuted.value[0]).toBeCloseTo(original.value[0], 9);
      original.nodes.forEach((node, k) => {
        const other = permuted.nodes[k];
        const hands = original.hands[node.player];
        const otherHands = permuted.hands[node.player];
        const count = node.labels.length;
        hands.forEach((combo, i) => {
          const j = otherHands.indexOf(permuteCombo(combo, perm));
          expect(j).toBeGreaterThanOrEqual(0);
          for (let a = 0; a < count; a += 1) {
            // Only the summation order differs between the two solves.
            expect(other.strategy[a * otherHands.length + j]).toBeCloseTo(node.strategy[a * hands.length + i], 5);
            expect(other.ev[a * otherHands.length + j]).toBeCloseTo(node.ev[a * hands.length + i], 4);
          }
        });
      });
    }
  });

  it("canonicalise to one input, and so to one cached solution", () => {
    const base = canonicalSpot(BOARD, [parseRange(RANGES[0]), parseRange(RANGES[1])]);
    const blobs = new Set<string>();
    let solves = 0;
    for (const perm of SUIT_PERMUTATIONS) {
      const spot = relabel(perm);
      const canonical = canonicalSpot(spot.board, spot.ranges);
      expect(canonical.board).toEqual(base.board);
      expect(Array.from(canonical.ranges[0])).toEqual(Array.from(base.ranges[0]));
      expect(Array.from(canonical.ranges[1])).toEqual(Array.from(base.ranges[1]));
      // The permutation maps this relabelling onto the canonical spelling.
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        expect(canonical.ranges[0][permuteCombo(c, canonical.perm)]).toBe(spot.ranges[0][c]);
      }
      if (solves++ < 3) {
        const solved = solveRiver(
          { board: canonical.board, ranges: canonical.ranges, pot: 10, stack: 40, menus: [MENU, MENU] },
          { maxIterations: 40, targetExploitability: 0 },
        );
        blobs.add(Buffer.from(encodeSolution(solved)).toString("base64"));
        expect(blobs.size).toBe(1);
      }
    }
  });
});
