import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, splitStandardHands } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { ggFiles, weplayFiles } from "./support/corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

const SIMPLE_HAND = `Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
Table 'NLHPurple70' 6-max Seat #1 is the button
Seat 1: 8c668f2d ($81.22 in chips)
Seat 2: da2a0a00 ($11.75 in chips)
Seat 3: 41ff0a42 ($50.99 in chips)
Seat 4: Hero ($82.8 in chips)
Seat 5: a28e4f77 ($34.98 in chips)
Seat 6: fb779d10 ($11.68 in chips)
da2a0a00: posts small blind $0.25
41ff0a42: posts big blind $0.5
*** HOLE CARDS ***
Dealt to Hero [5s 8c]
Hero: folds
a28e4f77: folds
fb779d10: raises $0.5 to $1
8c668f2d: folds
da2a0a00: calls $0.75
41ff0a42: calls $0.5
*** FLOP *** [Tc 4h Ad]
da2a0a00: checks
41ff0a42: checks
fb779d10: bets $1.5
da2a0a00: folds
41ff0a42: folds
Uncalled bet ($1.5) returned to fb779d10
*** SHOWDOWN ***
fb779d10 collected $2.85 from pot
*** SUMMARY ***
Total pot $3 | Rake $0.15 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Tc 4h Ad]
Seat 6: fb779d10 won ($2.85)`;

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

function codes(hand: PhfHand): string[] {
  return validateHand(hand).errors.map((problem) => problem.code);
}

describe("validateHand", () => {
  it("accepts a well formed hand", () => {
    const report = validateHand(parse(SIMPLE_HAND));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("flags a pot that does not match what the players put in", () => {
    const hand = parse(SIMPLE_HAND);
    hand.results.totalPot += 500;
    expect(codes(hand)).toContain("chip-mismatch");
  });

  it("flags winnings that match neither the pot nor the pot minus fees", () => {
    const hand = parse(SIMPLE_HAND);
    const collect = hand.actions.find((action) => action.type === "collect")!;
    collect.amount += 111;
    expect(codes(hand)).toContain("payout-mismatch");
  });

  it("accepts both rake conventions", () => {
    // GG deducts the rake from the reported pot; WePlay reports it alongside a
    // pot the winner collects in full. Both are internally consistent.
    const deducted = parse(SIMPLE_HAND);
    expect(validateHand(deducted).ok).toBe(true);

    const separate = parse(SIMPLE_HAND);
    const collect = separate.actions.find((action) => action.type === "collect")!;
    collect.amount = separate.results.totalPot;
    expect(validateHand(separate).errors.map((p) => p.code)).not.toContain("payout-mismatch");
  });

  it("flags a stack going negative", () => {
    const hand = parse(SIMPLE_HAND);
    hand.players.find((player) => player.name === "fb779d10")!.startingStack = 10;
    expect(codes(hand)).toContain("negative-stack");
  });

  it("flags an actor who is not seated", () => {
    const hand = parse(SIMPLE_HAND);
    hand.actions[0].player = "ghost";
    expect(codes(hand)).toContain("unseated-actor");
  });

  it("flags a duplicated card", () => {
    const hand = parse(SIMPLE_HAND);
    hand.players.find((player) => player.isHero)!.holeCards = ["Tc", "8c"];
    expect(codes(hand)).toContain("duplicate-card");
  });

  it("does not mistake a shared run-it-twice flop for duplicates", () => {
    const hand = parse(SIMPLE_HAND);
    hand.board.runouts.push({
      index: 1,
      flop: null,
      turn: "2h",
      river: "3h",
      markerLabels: {},
      summaryCards: null,
    });
    expect(codes(hand)).not.toContain("duplicate-card");
  });

  it("flags an illegal board size", () => {
    const hand = parse(SIMPLE_HAND);
    hand.board.runouts[0].flop = ["Tc", "4h"];
    expect(codes(hand)).toContain("board-size");
  });

  it("flags a river with no turn", () => {
    const hand = parse(SIMPLE_HAND);
    hand.board.runouts[0].river = "2c";
    expect(codes(hand)).toContain("river-without-turn");
  });

  it("flags an uncalled return larger than the commitment", () => {
    const hand = parse(SIMPLE_HAND);
    const uncalled = hand.actions.find((action) => action.type === "uncalled")!;
    uncalled.amount = -9999;
    expect(codes(hand)).toContain("uncalled-exceeds-commitment");
  });

  it("separates warnings from errors", () => {
    const hand = parse(SIMPLE_HAND);
    hand.table.buttonSeat = null;
    const report = validateHand(hand);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((problem) => problem.code)).toContain("missing-button");
  });
});

describe("the real corpus validates", () => {
  it.each(ggFiles().map((file) => [file.relativePath, file] as const))(
    "%s has no validation errors",
    (_name, file) => {
      for (const chunk of splitStandardHands(file.text)) {
        const report = validateHand(parse(chunk));
        expect(report.errors, chunk.split("\n")[0]).toEqual([]);
      }
    },
  );

  it("rejects every WePlay hand it cannot vouch for, with a reason", async () => {
    const reasons = new Set<string>();
    let failures = 0;
    for (const file of weplayFiles()) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const failure of result.failures) {
        failures += 1;
        reasons.add(failure.reason);
        expect(failure.message.length).toBeGreaterThan(0);
        expect(failure.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
      for (const hand of result.hands) {
        expect(validateHand(hand).ok, hand.meta.handId).toBe(true);
      }
    }
    expect(failures).toBeGreaterThan(0);
    // Every rejection carries a code we can write a converter or a fix for.
    expect([...reasons].every((reason) => /^[a-z0-9-]+$/.test(reason))).toBe(true);
  });
});
