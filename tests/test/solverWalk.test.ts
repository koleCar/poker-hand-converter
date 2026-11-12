/**
 * The analysis' links into the Solver library (`web/src/lib/analysis/solverWalk.ts`):
 * a hand's line written as a walk, read back, and followed on the pilot's
 * chunks - to a flop decision, to the turn's deal with the card the hand
 * saw (a card the deal names only by its suit class read as the one it
 * names), and on a live turn's solve to the river's decision.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE } from "../../web/src/lib/analysis/index.js";
import { encodeWalk, followWalk, handWalk, parseWalk, solverLinkOf, type WalkStep } from "../../web/src/lib/analysis/solverWalk.js";
import type { DecisionAnalysis } from "../../web/src/lib/analysis/types.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import {
  decodeChunk,
  exploreNode,
  pickedFlop,
  solveLiveTurn,
  turnDeal,
  type FlopChunk,
  type FlopManifest,
} from "../../web/src/lib/solver/index.js";

const DIR = join(import.meta.dirname, "../scripts/flop-library/pilot/nlhe-cash-6max-100bb", FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));

function chunk(line: string, flop: string): FlopChunk {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest;
  const entry = manifest.entries.find((e) => e.line === line && e.flop === flop);
  if (!entry) throw new Error(`no ${line}/${flop} in the pilot`);
  return decodeChunk(readFileSync(join(DIR, entry.path)));
}

const act = (type: "fold" | "check" | "call" | "bet" | "raise", sizePot: number | null = null, allIn = false): WalkStep => ({
  kind: "act",
  type,
  sizePot,
  allIn,
});
const card = (c: string): WalkStep => ({ kind: "card", card: c });
const IDENTITY = [0, 1, 2, 3];

describe("writing and reading a walk", () => {
  it("round-trips actions, sizes in whole percent of the pot, all-ins and cards", () => {
    const steps = [act("check"), act("bet", 0.33), act("raise", 1.2), act("call"), card("Kh"), act("bet", 2.5, true), act("fold")];
    const text = encodeWalk(steps);
    expect(text).toBe("x-b33-r120-c-Kh-b250a-f");
    expect(parseWalk(text)).toEqual(steps);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "x--c", "b", "q", "Kx", "x-b33-1h", Array(41).fill("x").join("-")]) {
      expect(parseWalk(bad)).toBeNull();
    }
  });
});

describe("a hand's walk to a decision", () => {
  // Heads-up after the flop, 1/2: 12 in at the flop, a third of it bet, then 15 into 20 on the turn.
  const hand = {
    game: { bigBlind: 2 },
    actions: [
      { index: 0, street: "preflop", seat: 1, type: "raise", amount: 6, allIn: false },
      { index: 1, street: "preflop", seat: 2, type: "call", amount: 6, allIn: false },
      { index: 2, street: "flop", seat: 2, type: "check", amount: 0, allIn: false },
      { index: 3, street: "flop", seat: 1, type: "bet", amount: 4, allIn: false },
      { index: 4, street: "flop", seat: 2, type: "call", amount: 4, allIn: false },
      { index: 5, street: "turn", seat: 2, type: "check", amount: 0, allIn: false },
      { index: 6, street: "turn", seat: 1, type: "bet", amount: 15, allIn: false },
      { index: 7, street: "turn", seat: 2, type: "call", amount: 15, allIn: false },
      { index: 8, street: "river", seat: 2, type: "check", amount: 0, allIn: false },
      { index: 9, street: "river", seat: 1, type: "bet", amount: 80, allIn: true },
    ],
  } as unknown as PhfHand;
  const at = (street: string, actionIndex: number, board: string[]) =>
    ({ street, actionIndex, facts: { board } }) as unknown as DecisionAnalysis;

  it("takes both players' actions before it, with the cards between the streets", () => {
    const board = ["As", "Kh", "7d", "2c", "9s"];
    expect(encodeWalk(handWalk(hand, at("river", 9, board))!)).toBe("x-b33-c-2c-x-b75-c-9s-x");
    expect(encodeWalk(handWalk(hand, at("turn", 7, board.slice(0, 4)))!)).toBe("x-b33-c-2c-x-b75");
    expect(encodeWalk(handWalk(hand, at("flop", 2, board.slice(0, 3)))!)).toBe("");
  });

  it("links a decision to the Solver library: the table, the preflop line, the flop in the hand's suits", () => {
    const board = ["As", "Kh", "7d", "2c", "9s"];
    const flopFacts = { line: "btn-bb", flop: "AsKh7d", mapped: false };
    const preflop = { ...at("preflop", 1, []), facts: { board: [], chart: { set: "nlhe-cash-6max-100bb", line: "fffr" } } } as unknown as DecisionAnalysis;
    const flop = { ...at("flop", 3, board.slice(0, 3)), facts: { board: board.slice(0, 3), flop: flopFacts } } as unknown as DecisionAnalysis;
    const river = at("river", 9, board);
    const link = solverLinkOf([preflop, flop, river], river, hand);
    expect(link).toEqual({ set: "nlhe-cash-6max-100bb", line: "fffrfc", flop: "AsKh7d", walk: "x-b33-c-2c-x-b75-c-9s-x", exact: true });

    // Read from a representative flop: the hand's turn and river are not on it, so the walk stops at the turn's deal.
    const mapped = { ...flop, facts: { ...flop.facts, flop: { ...flopFacts, flop: "AsKh8d", mapped: true } } } as unknown as DecisionAnalysis;
    expect(solverLinkOf([preflop, mapped, river], river, hand)).toEqual({
      set: "nlhe-cash-6max-100bb",
      line: "fffrfc",
      flop: "AsKh8d",
      walk: "x-b33-c",
      exact: false,
    });

    // No flop the library graded, or a preflop decision: no link.
    expect(solverLinkOf([preflop, river], river, hand)).toBeNull();
    expect(solverLinkOf([preflop, flop, river], preflop, hand)).toBeNull();
  });

  it("has none preflop or without the street's cards", () => {
    expect(handWalk(hand, at("preflop", 1, []))).toBeNull();
    expect(handWalk(hand, at("river", 9, ["As", "Kh", "7d", "2c"]))).toBeNull();
  });
});

describe.runIf(PRESENT)("following a walk on the pilot's chunks", () => {
  it("lands on a flop decision, and on the decision before a step the tree has no edge for", () => {
    const c = chunk("btn-bb", "AsKh7d");
    const root = exploreNode(c, 0);
    const check = root.actions.find((a) => a.kind === "check")!;
    const end = followWalk(c, [act("check")], IDENTITY);
    expect(end).toMatchObject({ node: check.child, deal: null, complete: true });

    // Facing a check, a fold is no option: the walk stops at the decision.
    const off = followWalk(c, [act("check"), act("fold")], IDENTITY);
    expect(off).toMatchObject({ node: check.child, deal: null, complete: false });
  });

  it("maps a bet to the tree's nearest size", () => {
    const c = chunk("btn-bb", "AsKh7d");
    const bets = exploreNode(c, 0).actions.filter((a) => a.kind === "bet");
    expect(bets.length).toBeGreaterThan(0);
    const target = bets[0];
    const end = followWalk(c, [act("bet", target.sizePot + 0.01)], IDENTITY);
    expect(end.node).toBe(target.child);
  });

  it("stops at the turn's deal with the card, in the chunk's suits, and the steps after it", () => {
    const c = chunk("btn-bb", "AsKh7d");
    const end = followWalk(c, [act("check"), act("check"), card("2c"), act("check")], IDENTITY);
    expect(end.complete).toBe(true);
    expect(end.deal).not.toBeNull();
    expect(c.result.nodes[end.deal!].labels).toContain(end.card);
    expect(end.card).toBe("2c");
    expect(end.rest).toEqual([act("check")]);
    expect(turnDeal(c, end.deal!)).not.toBeNull();
  });

  it("reads a turn card the deal names by its class as the one it names, and relabels the suits after it", () => {
    // A monotone flop: every off-suit turn of a rank is one class.
    const c = chunk("btn-bb", "Ks6s3s");
    const picked = pickedFlop(["Kh", "6h", "3h"]);
    expect(picked.key).toBe("Ks6s3s");
    const deal = followWalk(c, [act("check"), act("check")], picked.perm).deal!;
    const labels = c.result.nodes[deal].labels;
    const twos = labels.filter((x) => x[0] === "2");
    // One spade two and one off-suit two stand for all four.
    expect(twos.length).toBe(2);
    for (const two of ["2c", "2d", "2s"]) {
      const end = followWalk(c, [act("check"), act("check"), card(two)], picked.perm);
      expect(labels).toContain(end.card);
      expect(end.card).not.toBe("2s");
      // The relabelling sends the hand's two to the card the deal names, and hearts to spades still.
      expect(end.perm[1]).toBe(picked.perm[1]);
    }
    const flush = followWalk(c, [act("check"), act("check"), card("2h")], picked.perm);
    expect(flush.card).toBe("2s");
  });

  it("goes on through a live turn's solve to the river's decision", () => {
    const c = chunk("btn-bb", "AsKh7d");
    const flop = followWalk(c, [act("check"), act("check"), card("2c"), act("check"), act("check"), card("9d"), act("check")], IDENTITY);
    expect(flop.card).toBe("2c");
    const turn = { header: c.header, result: solveLiveTurn(c, flop.deal!, flop.card!) };
    const end = followWalk(turn, flop.rest, flop.perm);
    expect(end.complete).toBe(true);
    const node = turn.result.nodes[end.node];
    expect(node.kind).toBe("action");
    expect(node.street).toBe("river");
    expect(node.path).toMatch(/^X-X\|9[cdhs]\|X$/);
  }, 120_000);
});
