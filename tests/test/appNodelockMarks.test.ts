/**
 * The desktop app's lock marks (`app/src/solver/nodelock/marks.ts`,
 * `docs/NODELOCK.md` §7.3): which actions of a locked decision carry the
 * lock icon, GTO's share against the lock's, the combos fixed, the grid's
 * cells, where the lock came from, and the locked decisions of a lock and
 * its ancestors by path.
 */
import { describe, expect, it } from "vitest";

import type { LockSet, NodeLockSpec } from "../../app/src/solver/nodelock/contract.js";
import { markIndex, markPath, nodeMark, type MarkSpot } from "../../app/src/solver/nodelock/marks.js";

const COMBOS = 1326;

/** A spec over three actions (check, bet, overbet) fixing `fixed` combos at the given mixes. */
function spec(path: string, fixed: Record<number, [number, number, number]>): NodeLockSpec {
  const strategy = [0, 1, 2].map(() => new Array<number>(COMBOS).fill(0));
  const locked = new Array<number>(COMBOS).fill(0);
  for (const [combo, mix] of Object.entries(fixed)) {
    locked[Number(combo)] = 1;
    mix.forEach((x, a) => {
      strategy[a][Number(combo)] = x;
    });
  }
  return { street: "flop", path, player: 0, actions: ["X", "B2.5", "B10"], strategy, locked };
}

/**
 * Four hands: combos 10, 11 (cell 0), 20 (cell 1), 30 (cell 2, never reaches).
 * GTO: hand 0 checks, hand 1 half/half check-bet, hand 2 bets, hand 3 overbets.
 */
const SPOT: MarkSpot = {
  hands: [10, 11, 20, 30],
  reach: [1, 1, 2, 0],
  cell: [0, 0, 1, 2],
  gto: [
    [1, 0.5, 0, 0],
    [0, 0.5, 1, 0],
    [0, 0, 0, 1],
  ],
  rest: [
    [1, 0.5, 0, 0],
    [0, 0.5, 1, 0],
    [0, 0, 0, 1],
  ],
};

describe("nodeMark", () => {
  it("compares GTO's shares with the lock's, free hands at GTO", () => {
    // Combo 20 (reach 2) always checks instead of betting.
    const mark = nodeMark(spec("X", { 20: [1, 0, 0] }), SPOT);
    // GTO: check (1 + 0.5) / 4, bet (0.5 + 2) / 4.
    expect(mark.gto).toEqual([0.375, 0.625, 0]);
    // Locked: check (1 + 0.5 + 2) / 4, bet 0.5 / 4.
    expect(mark.shares).toEqual([0.875, 0.125, 0]);
    expect(mark.fixed).toBe(1);
    expect(mark.reaching).toBe(3);
    expect(mark.origin).toBe("painted");
  });

  it("marks the actions a fixed combo plays, and one the lock took to 0 %", () => {
    // Combo 20 bet under GTO; the lock has it check: check is played, bet was held at 0 %.
    expect(nodeMark(spec("X", { 20: [1, 0, 0] }), SPOT).locked).toEqual([true, true, false]);
    // Combo 10 checks under GTO and the lock: only check.
    expect(nodeMark(spec("X", { 10: [1, 0, 0] }), SPOT).locked).toEqual([true, false, false]);
  });

  it("calls a lock of every reaching combo a range lock, and ignores a combo that does not reach", () => {
    const mark = nodeMark(spec("X", { 10: [0, 1, 0], 11: [0, 1, 0], 20: [0, 1, 0], 30: [1, 0, 0] }), SPOT);
    expect(mark.origin).toBe("range");
    expect(mark.fixed).toBe(3);
    expect(mark.shares).toEqual([0, 1, 0]);
    // Combo 30 never reaches: its check is not an action the lock plays here.
    expect(mark.locked).toEqual([true, true, false]);
  });

  it("normalises a fixed mix and lays the lock over the grid", () => {
    const mark = nodeMark(spec("X", { 10: [0, 2, 2] }), SPOT);
    const [first, second, third] = mark.cells;
    // Cell 0: combo 10 fixed at bet/overbet half each, combo 11 free at half check, half bet.
    expect(first).toEqual({ mix: [0.25, 0.5, 0.25], fixed: 0.5 });
    expect(second).toEqual({ mix: [0, 1, 0], fixed: 0 });
    // Cell 2's only hand does not reach.
    expect(third).toBeNull();
    expect(mark.cells.filter(Boolean)).toHaveLength(2);
  });

  it("has no GTO shares when GTO is not at hand, and judges a held action by the rest", () => {
    const mark = nodeMark(spec("X", { 20: [1, 0, 0] }), { ...SPOT, gto: null, rest: [[1, 0.5, 1, 0], [0, 0.5, 0, 0], [0, 0, 0, 1]] });
    expect(mark.gto).toBeNull();
    expect(mark.locked).toEqual([true, false, false]);
  });
});

describe("markIndex", () => {
  const set = (nodes: NodeLockSpec[]): LockSet => ({
    version: 1,
    spot: { set: "s", line: "btn-bb", flop: "Qs6h3d" },
    nodes,
    earlier: "player",
    targetPct: 1,
  });

  it("holds the lock's own nodes, then its ancestors' on paths it does not lock", () => {
    const own = spec("X~Kd/X", { 10: [1, 0, 0] });
    const mine = spec("X", { 11: [1, 0, 0] });
    const parentFlop = spec("X", { 20: [1, 0, 0] });
    const parentBet = spec("B2.5", { 20: [0, 1, 0] });
    const index = markIndex(set([own, mine]), [
      { id: "p", name: "Passive BB", set: set([parentFlop, parentBet]) },
      { id: "g", name: "Root", set: set([spec("B2.5", {})]) },
    ]);
    expect(index.get("X~Kd/X")).toEqual({ spec: own, from: null });
    // The open lock's own node wins over its parent's on the same path.
    expect(index.get("X")).toEqual({ spec: mine, from: null });
    // The nearest ancestor wins over a farther one.
    expect(index.get("B2.5")).toEqual({ spec: parentBet, from: { id: "p", name: "Passive BB" } });
    expect(index.size).toBe(3);
  });
});

describe("markPath", () => {
  it("is the flop's node path, or the deal's path, the turn card and the turn's path", () => {
    expect(markPath("X-B1.82", null)).toBe("X-B1.82");
    expect(markPath("B2.5", { dealPath: "X-X", card: "Kd" })).toBe("X-X~Kd/B2.5");
    expect(markPath("X-X|7h|X", { dealPath: "X-X", card: "Kd" })).toBe("X-X~Kd/X-X|7h|X");
  });
});
