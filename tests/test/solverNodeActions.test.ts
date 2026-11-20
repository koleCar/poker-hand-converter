/**
 * A node's own actions (`BettingRules.nodeActions`, a nodelock's custom
 * sizes): the game is built with them, labels the menu gives keep the
 * menu's exact amounts, and illegal labels are input errors. The same cases
 * as `core/rail-solver/tests/node_actions.rs`.
 */
import { describe, expect, it } from "vitest";

import { buildRiverGame, lockNodeActions, type LockSet, type SpotInput } from "../../web/src/lib/solver/index.js";

const range = (k: number) => Array.from({ length: 1326 }, (_, i) => (i % 7 === k ? 1 : 0));

function spot(nodeActions?: Record<string, string[]>): SpotInput {
  return {
    board: ["Ks", "5h", "3s", "7d", "2c"],
    ranges: [range(0), range(3)],
    pot: 10,
    stack: 50,
    menus: [
      { bet: [0.33, 0.75], raise: [1], allIn: true },
      { bet: [0.5], raise: [1], allIn: true },
    ],
    ...(nodeActions ? { nodeActions } : {}),
  };
}

function labelsAt(s: SpotInput, path: string): string[] {
  const info = buildRiverGame(s).info.find((i) => i?.path === path);
  if (!info) throw new Error(`no node ${path}`);
  return info.actions.map((a) => a.label);
}

describe("a node's own actions", () => {
  it("leaves the menu tree as it was without them", () => {
    expect(labelsAt(spot(), "")).toEqual(["X", "B3.3", "B7.5", "A50"]);
  });

  it("builds the node with its own actions", () => {
    const s = spot({ "": ["X", "B15", "A50"], X: ["B2"] });
    expect(labelsAt(s, "")).toEqual(["X", "B15", "A50"]);
    expect(labelsAt(s, "X")).toEqual(["B2"]);
    // Below a custom size the menu applies again.
    expect(labelsAt(s, "B15")).toEqual(["F", "C", "A50"]);
    expect(buildRiverGame(s).info.find((i) => i?.path === "B15")?.toCall).toBeCloseTo(15, 9);
  });

  it("keeps the menu's exact amounts for the menu's labels", () => {
    const a = buildRiverGame(spot()).game.tree;
    const b = buildRiverGame(spot({ "": ["X", "B3.3", "B7.5", "A50"] })).game.tree;
    expect(b.size).toBe(a.size);
    expect(Array.from(b.payoff)).toEqual(Array.from(a.payoff));
  });

  it("rejects labels that are not legal at the node", () => {
    const cases: Array<[string[], string]> = [
      [["C", "B5"], "has no bet to answer"],
      [["X", "R20"], "raises no bet"],
      [["X", "A40"], "is not all-in"],
      [["X", "B60"], "is the stack or more"],
      [["X", "X"], "is there twice"],
      [[], "without an action"],
    ];
    for (const [labels, why] of cases) expect(() => buildRiverGame(spot({ "": labels }))).toThrow(why);
  });
});

describe("lockNodeActions", () => {
  const node = (path: string, actions: string[], custom?: true) => ({ street: "flop" as const, path, player: 0 as const, actions, strategy: [], locked: [], ...(custom ? { custom } : {}) });
  const set = (nodes: ReturnType<typeof node>[]): LockSet => ({ version: 1, spot: { set: "s", line: "btn-bb", flop: "Ks5h3s" }, nodes, earlier: "player", targetPct: 1 });

  it("is undefined when every node keeps the tree's actions", () => {
    expect(lockNodeActions(set([node("X", ["X", "B1.82"])]))).toBeUndefined();
  });

  it("names the custom nodes by their game path", () => {
    expect(lockNodeActions(set([node("", ["X", "B8.25"], true), node("X", ["X", "B1.82"])]))).toEqual({ "": ["X", "B8.25"] });
    expect(lockNodeActions(set([node("X~Kd/X", ["B4"], true)]), (n) => n.path.split("/")[1])).toEqual({ X: ["B4"] });
  });
});
