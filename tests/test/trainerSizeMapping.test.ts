/**
 * A trainer answer is graded as the menu item the player clicked
 * (analysis/47). The menu quotes amounts to the cent of a big blind, so 33%
 * of a 9.96 bb pot is "bet to 3.29", 0.3303 of the pot: just past the tree's
 * 0.33. The translation put a sliver of it on the 75% and the hero's size was
 * graded as the better neighbour, so the verdict read "You: Bet 7.47 bb (75%)"
 * after a click on 33% (river seed 3 below). `mapAct` now reads a size that
 * puts in the tree's own amount, to the cent, as that size.
 */

import { describe, expect, it } from "vitest";

import { EXACT_SIZE_BB, mapAct } from "../../web/src/lib/analysis/index.js";
import type { SolvedNode } from "../../web/src/lib/solver/index.js";
import { gradeAnswer } from "../../web/src/lib/training/grade.js";
import { generateRiverSpot, riverAnswer, type RiverSpotOptions } from "../../web/src/lib/training/river.js";
import { generateTurnSpot, turnAnswer, type TurnSpotOptions } from "../../web/src/lib/training/turn.js";
import { fullLibrary } from "./charts/support.js";

const library = fullLibrary();

/** Every menu item of a spot, answered and graded: each must come back as its own option. */
function expectOwnOptions(
  label: string,
  menu: readonly { kind: string; to: number }[],
  grade: (index: number) => ReturnType<typeof gradeAnswer>,
) {
  menu.forEach((item, index) => {
    const decision = grade(index);
    const where = `${label} menu ${index} (${item.kind} to ${item.to})`;
    expect(decision, where).not.toBeNull();
    expect(decision!.source, where).toBe("solver");
    expect(decision!.options.length, where).toBe(menu.length);
    expect(decision!.chosen, where).toBe(index);
    // A menu size is the tree's own: never translated, never off the tree.
    expect(decision!.approximations, where).not.toContain("size-translated");
    expect(decision!.approximations, where).not.toContain("off-tree-size");
  });
}

describe("a river trainer answer is graded as the menu item clicked", () => {
  const cases: Array<[RiverSpotOptions, number[]]> = [
    // Seed 3: pot 9.96, the 33% is "to 3.29" and was graded as the 75%.
    [{ pot: "srp", seat: "ip", facing: "check" }, [3, 7, 21, 33]],
    [{ pot: "srp", seat: "ip", facing: "bet" }, [3, 7]],
    [{ pot: "3bp", seat: "oop" }, [4, 12]],
  ];
  for (const [options, seeds] of cases) {
    for (const seed of seeds) {
      it(`${JSON.stringify(options)} seed ${seed}`, () => {
        const spot = generateRiverSpot(library, options, seed);
        if (!spot) throw new Error("no river spot");
        expectOwnOptions(`river seed ${seed}`, spot.menu, (index) => {
          const answer = riverAnswer(spot, index);
          return gradeAnswer(answer.hand, answer.actionIndex, library);
        });
      });
    }
  }
});

describe("a turn trainer answer is graded as the menu item clicked", () => {
  const cases: Array<[TurnSpotOptions, number]> = [
    // One spot: a turn solve per answer costs seconds, and the rule is `mapAct`, tested on its own below.
    [{ pot: "srp", seat: "ip", facing: "check" }, 3],
  ];
  for (const [options, seed] of cases) {
    it(`${JSON.stringify(options)} seed ${seed}`, () => {
      const spot = generateTurnSpot(library, options, seed);
      if (!spot) throw new Error("no turn spot");
      expectOwnOptions(`turn seed ${seed}`, spot.menu, (index) => {
        const answer = turnAnswer(spot, index);
        return gradeAnswer(answer.hand, answer.actionIndex, library, { turn: true });
      });
    }, 120_000);
  }
});

/**
 * The flop shares `mapAct` (the library's lines, `flopLibrary.ts`), but no
 * library chunk is in the repo to deal a flop spot from (`learnFlop.test.ts`),
 * so the rule itself is tested on a node.
 */
describe("mapAct: a size to the cent of a tree size is that size", () => {
  // Unchecked, 9.96 in the pot: 33%, 75%, 150% and all-in.
  const pot = 9.96;
  const sizes = [0.33, 0.75, 1.5];
  const node = {
    kind: "action",
    player: 1,
    street: "river",
    path: "X",
    pot,
    toCall: 0,
    behind: 95.52,
    actions: [
      { label: "X", kind: "check", amount: 0, to: 0, sizePot: 0 },
      ...sizes.map((x) => ({ label: `B${x}`, kind: "bet", amount: pot * x, to: pot * x, sizePot: x })),
      { label: "A", kind: "allin", amount: 95.52, to: 95.52, sizePot: 95.52 / pot },
    ],
  } as unknown as SolvedNode;
  const bet = (to: number) => ({ type: "bet" as const, to, allIn: false, sizePot: to / pot });

  it("maps every tree size, rounded to two decimals either way, to its own edge alone", () => {
    sizes.forEach((x, k) => {
      // The menu's amount (nearest cent), and the furthest a cent's rounding can put it either way.
      for (const to of [Math.round(pot * x * 100) / 100, pot * x - 0.005, pot * x + 0.005]) {
        const mapped = mapAct(node, bet(to), 100)!;
        expect(mapped.edges, `${x} to ${to}`).toEqual([k + 1]);
        expect(mapped.weights).toEqual([1]);
        expect(mapped.distance).toBeLessThan(0.002);
      }
    });
  });

  it("still translates a size between two tree sizes onto both", () => {
    // 3.29 + a cent: past the tolerance, the pseudo-harmonic mix again.
    expect(EXACT_SIZE_BB).toBeLessThan(0.01);
    expect(mapAct(node, bet(3.3 + 0.01), 100)!.edges).toEqual([1, 2]);
    expect(mapAct(node, bet(5), 100)!.edges).toHaveLength(2);
  });
});
