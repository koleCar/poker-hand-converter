/**
 * The replayer's "Open in Solver" (`app/src/solver/handSpot.ts`): the hero's
 * decision where the replayer stands, its spot as the Solver tab's parameter
 * (`app/src/solver/param.ts`), and what stands in for a spot the library
 * has no tree for - the preflop ranges, a set at another depth.
 */
import { describe, expect, it } from "vitest";

import type { DecisionAnalysis } from "../../app/src/analysis/library";
import { decisionAt, handSpotOf } from "../../app/src/solver/handSpot";
import { parseSolverParam, spotParam } from "../../app/src/solver/param";

const SET = "nlhe-cash-6max-100bb";

function decision(order: number, actionIndex: number, street: string, facts: Record<string, unknown>): DecisionAnalysis {
  return {
    order,
    actionIndex,
    street,
    facts: {
      holeCards: ["Ah", "Kd"],
      position: "BTN",
      board: [],
      effStackBb: 100,
      chart: null,
      flop: null,
      players: 2,
      ...facts,
    },
  } as unknown as DecisionAnalysis;
}

const open = decision(0, 3, "preflop", { chart: { set: SET, line: "f" } });
const flopMultiway = decision(1, 9, "flop", { board: ["Qs", "7h", "2c"], players: 3 });
const turn = decision(2, 14, "turn", { board: ["Qs", "7h", "2c", "9d"], players: 3 });

describe("decisionAt", () => {
  const all = [open, flopMultiway, turn];
  it("is the first decision at the start and with no position", () => {
    expect(decisionAt(all, null)).toBe(open);
    expect(decisionAt(all, { kind: "start" })).toBe(open);
  });
  it("is the decision at the action, else the next one, else the last", () => {
    expect(decisionAt(all, { kind: "action", actionIndex: 9 })).toBe(flopMultiway);
    expect(decisionAt(all, { kind: "action", actionIndex: 10 })).toBe(turn);
    expect(decisionAt(all, { kind: "action", actionIndex: 40 })).toBe(turn);
  });
  it("is the street's first decision, and the last at the end", () => {
    expect(decisionAt(all, { kind: "street", street: "flop" })).toBe(flopMultiway);
    expect(decisionAt(all, { kind: "street", street: "river" })).toBe(turn);
    expect(decisionAt(all, { kind: "end" })).toBe(turn);
  });
  it("is null without decisions", () => {
    expect(decisionAt([], null)).toBeNull();
  });
});

describe("handSpotOf", () => {
  it("opens a preflop decision on its chart, the hero's cards marked", () => {
    const spot = handSpotOf([open], undefined, null);
    expect(spot?.approx).toBe("exact");
    const route = parseSolverParam(spot?.param ?? null);
    expect(route).toMatchObject({ set: SET, line: "f", hero: { cards: "AhKd", position: "BTN" }, approx: null, handDepth: null });
  });

  it("stands in for a heads-up flop the library has no tree for with the preflop ranges", () => {
    const flopHeadsUp = decision(1, 9, "flop", { board: ["Qs", "7h", "2c"], players: 2 });
    const spot = handSpotOf([open, flopHeadsUp], undefined, { kind: "action", actionIndex: 9 });
    expect(spot?.approx).toBe("preflop");
    expect(parseSolverParam(spot?.param ?? null)).toMatchObject({ set: SET, line: "f", approx: "preflop" });
  });

  it("offers nothing after a flop three or more saw, and still the preflop chart (analysis/46)", () => {
    const all = [open, flopMultiway, turn];
    expect(handSpotOf(all, undefined, { kind: "action", actionIndex: 14 })).toBeNull();
    expect(handSpotOf(all, undefined, { kind: "street", street: "flop" })).toBeNull();
    // Heads-up by the turn, but the flop was three-way: the analysis says so on every postflop decision.
    const huTurn = decision(2, 14, "turn", { board: ["Qs", "7h", "2c", "9d"], players: 2, reason: undefined });
    const flopMarked = { ...decision(1, 9, "flop", { players: 2 }), reason: "multiway" } as DecisionAnalysis;
    expect(handSpotOf([open, flopMarked, huTurn], undefined, { kind: "end" })).toBeNull();
    expect(handSpotOf(all, undefined, { kind: "start" })?.approx).toBe("exact");
  });

  it("names the hand's depth when the set is another", () => {
    const short = decision(0, 3, "preflop", { chart: { set: SET, line: "f" }, effStackBb: 62.4 });
    const spot = handSpotOf([short], undefined, null);
    expect(spot).toMatchObject({ depth: 100, handDepth: 62.4 });
    expect(parseSolverParam(spot?.param ?? null).handDepth).toBe(62);
    // Within 10 %: the set is the hand's own.
    const near = decision(0, 3, "preflop", { chart: { set: SET, line: "f" }, effStackBb: 95 });
    expect(handSpotOf([near], undefined, null)?.depth).toBeNull();
  });

  it("is null where nothing of the hand is in the charts", () => {
    expect(handSpotOf([flopMultiway, turn], undefined, null)).toBeNull();
    expect(handSpotOf([], undefined, null)).toBeNull();
  });
});

describe("the Solver tab's parameter", () => {
  it("carries a hand's walk and hero, and drops what is malformed", () => {
    const param = spotParam(
      { set: SET, line: "fffr", flop: "Qs7h2c", node: null, turn: null, path: "X-B1.82", walk: "x-b33-c-9d-x" },
      { cards: "AhKd", position: "UTG+1" },
    );
    expect(parseSolverParam(param)).toMatchObject({
      set: SET,
      line: "fffr",
      flop: "Qs7h2c",
      walk: "x-b33-c-9d-x",
      // The walk wins over the path: it reaches the decision on any street.
      path: null,
      hero: { cards: "AhKd", position: "UTG+1" },
    });
    expect(parseSolverParam("set=x&walk=zz&hero=AhK&pos=BTN&eff=abc&approx=river")).toMatchObject({
      set: null,
      walk: null,
      hero: null,
      handDepth: null,
      approx: null,
    });
  });
});
