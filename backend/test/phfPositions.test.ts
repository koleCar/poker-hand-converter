import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, splitStandardHands } from "../../frontend/src/lib/phf/serialize.js";
import {
  assignPositions,
  positionRing,
  resolvePositions,
  type PhfHand,
  type Position,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { ggFiles, weplayFiles } from "./support/corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

function positionsOf(hand: PhfHand): Record<number, Position | null> {
  const out: Record<number, Position | null> = {};
  for (const player of hand.players) {
    out[player.seat] = player.position;
  }
  return out;
}

/* ------------------------------------------------------------- geometry --- */

describe("resolvePositions (pure geometry)", () => {
  it("puts the small blind on the button heads-up", () => {
    // The bug this pins: starting the ring one seat past the button inverts the
    // two seats heads-up, labelling the button BB and its opponent SB.
    expect(Object.fromEntries(resolvePositions([1, 2], 1))).toEqual({ 1: "SB", 2: "BB" });
    expect(Object.fromEntries(resolvePositions([1, 2], 2))).toEqual({ 2: "SB", 1: "BB" });
  });

  it("is heads-up correct with non-adjacent seat numbers", () => {
    expect(Object.fromEntries(resolvePositions([3, 7], 7))).toEqual({ 7: "SB", 3: "BB" });
    expect(Object.fromEntries(resolvePositions([3, 7], 3))).toEqual({ 3: "SB", 7: "BB" });
  });

  it("labels no seat BTN heads-up, because the button is the small blind", () => {
    const heads = [...resolvePositions([1, 2], 1).values()];
    expect(heads).not.toContain("BTN");
    expect(positionRing(2)).toEqual(["SB", "BB"]);
  });

  it("keeps the button on the button three-handed", () => {
    // The other easy off-by-one: three-handed the ring is SB, BB, BTN and the
    // button must land on the last slot, not the first.
    expect(Object.fromEntries(resolvePositions([1, 2, 3], 3))).toEqual({
      1: "SB",
      2: "BB",
      3: "BTN",
    });
    // ... and it has to wrap correctly for every button seat.
    expect(Object.fromEntries(resolvePositions([1, 2, 3], 1))).toEqual({
      2: "SB",
      3: "BB",
      1: "BTN",
    });
    expect(Object.fromEntries(resolvePositions([1, 2, 3], 2))).toEqual({
      3: "SB",
      1: "BB",
      2: "BTN",
    });
  });

  it("orders a six-max and a nine-handed table", () => {
    expect(Object.fromEntries(resolvePositions([1, 2, 3, 4, 5, 6], 6))).toEqual({
      1: "SB",
      2: "BB",
      3: "UTG",
      4: "HJ",
      5: "CO",
      6: "BTN",
    });
    const nine = resolvePositions([1, 2, 3, 4, 5, 6, 7, 8, 9], 9);
    expect(nine.get(1)).toBe("SB");
    expect(nine.get(2)).toBe("BB");
    expect(nine.get(3)).toBe("UTG");
    expect(nine.get(9)).toBe("BTN");
  });

  it("refuses to guess when the button is unknown or not seated", () => {
    expect(resolvePositions([1, 2, 3], null).size).toBe(0);
    expect(resolvePositions([1, 2, 3], 5).size).toBe(0);
    expect(resolvePositions([], 1).size).toBe(0);
  });
});

/* ------------------------------------------------- resolution from a hand --- */

const HEADS_UP = `Poker Hand #HU1: Hold'em No Limit ($1/$2) - 2026/02/17 05:56:01
Table 'HU' 2-max Seat #4 is the button
Seat 2: Villain ($200 in chips)
Seat 4: Hero ($200 in chips)
Hero: posts small blind $1
Villain: posts big blind $2
*** HOLE CARDS ***
Dealt to Hero [As Kd]
Hero: raises $4 to $6
Villain: folds
Uncalled bet ($4) returned to Hero
*** SHOWDOWN ***
Hero collected $4 from pot
*** SUMMARY ***
Total pot $4 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Seat 2: Villain (big blind) folded before Flop
Seat 4: Hero (button) (small blind) collected ($4)`;

const DEAD_BUTTON = `Poker Hand #DB1: Hold'em No Limit ($1/$2) - 2026/02/17 05:56:01
Table 'DB' 6-max Seat #3 is the button
Seat 1: A ($200 in chips)
Seat 4: B ($200 in chips)
Seat 5: C ($200 in chips)
B: posts small blind $1
C: posts big blind $2
*** HOLE CARDS ***
Dealt to A [As Kd]
A: folds
B: folds
Uncalled bet ($1) returned to C
*** SHOWDOWN ***
C collected $3 from pot
*** SUMMARY ***
Total pot $3 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Seat 1: A folded before Flop (didn't bet)
Seat 4: B (small blind) folded before Flop
Seat 5: C (big blind) collected ($3)`;

const SEATED_NOT_DEALT_IN = `Poker Hand #SO1: Hold'em No Limit ($1/$2) - 2026/02/17 05:56:01
Table 'SO' 6-max Seat #4 is the button
Seat 1: A ($200 in chips)
Seat 2: B ($200 in chips)
Seat 3: Sitout ($200 in chips)
Seat 4: D ($200 in chips)
A: posts small blind $1
B: posts big blind $2
*** HOLE CARDS ***
Dealt to D [As Kd]
D: folds
A: folds
Uncalled bet ($1) returned to B
*** SHOWDOWN ***
B collected $3 from pot
*** SUMMARY ***
Total pot $3 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Seat 1: A (small blind) folded before Flop
Seat 2: B (big blind) collected ($3)
Seat 4: D (button) folded before Flop (didn't bet)`;

const BOMB_POT = `Poker Hand #BP1: Hold'em No Limit ($1/$2) - 2026/02/17 05:56:01
Table 'BP' 6-max Seat #3 is the button
Seat 1: A ($200 in chips)
Seat 2: B ($200 in chips)
Seat 3: C ($200 in chips)
A: posts the ante $6
B: posts the ante $6
C: posts the ante $6
*** HOLE CARDS ***
Dealt to A [As Kd]
*** FLOP *** [2c 7h 9d]
A: bets $10
B: folds
C: folds
Uncalled bet ($10) returned to A
*** SHOWDOWN ***
A collected $18 from pot
*** SUMMARY ***
Total pot $18 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [2c 7h 9d]
Seat 1: A collected ($18)
Seat 2: B folded on the Flop
Seat 3: C folded on the Flop`;

describe("assignPositions (from the hand itself)", () => {
  it("resolves heads-up: the button posts the small blind", () => {
    const hand = parse(HEADS_UP);
    expect(validateHand(hand).ok).toBe(true);
    expect(positionsOf(hand)).toEqual({ 4: "SB", 2: "BB" });
    // Code that needs the button must read table.buttonSeat, not position.
    expect(hand.table.buttonSeat).toBe(4);
  });

  it("resolves a dead button from the posted blinds", () => {
    // Seat 3 holds the button but nobody is sitting there. Geometry alone
    // returns nothing at all here; the blinds still pin the ring.
    const hand = parse(DEAD_BUTTON);
    expect(hand.players.some((player) => player.seat === hand.table.buttonSeat)).toBe(false);
    expect(positionsOf(hand)).toEqual({ 4: "SB", 5: "BB", 1: "BTN" });
  });

  it("ignores a seated player who was never dealt in", () => {
    // Seat 3 is seated but takes no action. Counting them would shift every
    // other seat by one and turn a three-handed hand into a four-handed one.
    const hand = parse(SEATED_NOT_DEALT_IN);
    expect(positionsOf(hand)).toEqual({ 1: "SB", 2: "BB", 4: "BTN", 3: null });
  });

  it("falls back to geometry when no blinds were posted at all", () => {
    const hand = parse(BOMB_POT);
    expect(hand.game.bombPot).not.toBeNull();
    expect(positionsOf(hand)).toEqual({ 1: "SB", 2: "BB", 3: "BTN" });
  });

  it("falls back to geometry heads-up too", () => {
    const heads = BOMB_POT.split("\n")
      .filter((line) => !/(^Seat 3: C |^C: )/.test(line))
      .join("\n")
      .replace("Seat #3 is the button", "Seat #2 is the button")
      .replace("Total pot $18", "Total pot $12")
      .replace("A collected $18", "A collected $12")
      .replace("Seat 1: A collected ($18)", "Seat 1: A collected ($12)");
    const hand = parse(heads);
    expect(hand.players).toHaveLength(2);
    expect(positionsOf(hand)).toEqual({ 2: "SB", 1: "BB" });
  });

  it("is idempotent", () => {
    const hand = parse(HEADS_UP);
    const before = positionsOf(hand);
    assignPositions(hand);
    assignPositions(hand);
    expect(positionsOf(hand)).toEqual(before);
  });
});

/* -------------------------------------------------------- corpus oracle --- */

/**
 * The SUMMARY block's `(button)` / `(small blind)` / `(big blind)` words are
 * written by the room from who actually posted, so they are an independent
 * check on `PhfPlayer.position`. That independence is the point: the position
 * bug this suite exists for was invisible in the standard-text output and only
 * showed up in the replayer.
 *
 * Hands where a room labels two seats with the same blind word cannot arbitrate
 * anything - WePlay marks a player posting a dead blind to re-enter the game as
 * `(big blind)` alongside the real one - so they are skipped.
 */
function positionDisagreements(hand: PhfHand): string[] {
  const labelCounts = new Map<string, number>();
  for (const result of hand.results.players) {
    for (const label of result.positionLabels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  if ([...labelCounts.values()].some((count) => count > 1)) {
    return [];
  }

  const out: string[] = [];
  for (const result of hand.results.players) {
    const player = hand.players.find((entry) => entry.seat === result.seat);
    const labels = result.positionLabels;
    const expected = labels.includes("(small blind)")
      ? "SB"
      : labels.includes("(big blind)")
        ? "BB"
        : labels.includes("(button)")
          ? "BTN"
          : null;
    if (expected && player?.position !== expected) {
      out.push(
        `${hand.meta.handId} seat ${result.seat}: summary says ${expected}, ` +
          `PHF says ${player?.position}`,
      );
    }
  }
  return out;
}

describe("positions agree with the SUMMARY block over the whole corpus", () => {
  it.each(ggFiles().map((file) => [file.relativePath, file] as const))(
    "%s",
    (_name, file) => {
      for (const chunk of splitStandardHands(file.text)) {
        expect(positionDisagreements(parse(chunk))).toEqual([]);
      }
    },
  );

  it.each(weplayFiles().map((file) => [file.relativePath, file] as const))(
    "%s",
    async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        expect(positionDisagreements(hand)).toEqual([]);
      }
    },
  );

  it("covers every table size, heads-up included", async () => {
    const sizes = new Map<number, number>();
    for (const file of ggFiles()) {
      for (const chunk of splitStandardHands(file.text)) {
        const n = parse(chunk).players.length;
        sizes.set(n, (sizes.get(n) ?? 0) + 1);
      }
    }
    for (const file of weplayFiles()) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const n = hand.players.length;
        sizes.set(n, (sizes.get(n) ?? 0) + 1);
      }
    }
    // Heads-up is the case the resolver used to get exactly backwards, so the
    // corpus check is worthless unless it actually contains some.
    expect(sizes.get(2) ?? 0).toBeGreaterThan(50);
    expect(sizes.get(3) ?? 0).toBeGreaterThan(50);
    expect([...sizes.keys()].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
