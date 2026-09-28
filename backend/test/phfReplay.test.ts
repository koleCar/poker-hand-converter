import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, splitStandardHands } from "../../frontend/src/lib/phf/serialize.js";
import {
  primaryBoard,
  toBigBlinds,
  toDisplayNumber,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { buildReplay, streetAnchors } from "../../frontend/src/lib/replay.js";
import { ggFiles, weplayFiles } from "./support/corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function ggHands(): PhfHand[] {
  return ggFiles().flatMap((file) =>
    splitStandardHands(file.text).map((chunk) => parseStandardHand(chunk, CTX)!),
  );
}

describe("buildReplay over the real corpus", () => {
  const hands = ggHands();

  it("has hands to replay", () => {
    expect(hands.length).toBeGreaterThan(400);
  });

  it("never lets a stack go negative", () => {
    const problems: string[] = [];
    for (const hand of hands) {
      for (const frame of buildReplay(hand)) {
        for (const seat of frame.seats) {
          if (seat.stack < -0.005) {
            problems.push(`${hand.meta.handId} ${seat.name} ${seat.stack}`);
          }
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  /**
   * Side pots are paid one frame each now, so "the final frame holds the whole
   * award" no longer holds. What has to stay true is stronger, and is checked
   * from two independent directions so that neither side can quietly go slack:
   *
   * 1. The *seats* — whose `winAmount` is accumulated by the replay's own stack
   *    bookkeeping, frame by frame — end up holding exactly what
   *    `results.winners` says they won, and the middle ends up empty.
   * 2. The *award frames* — `potAward`, which is what the felt animates — pay
   *    out that same total, each frame paying somebody and each naming an
   *    amount that matches the winners it lists.
   *
   * Drop a pot and (1) fails; animate a pot that pays nobody, or label a pile
   * with an amount it does not hand over, and (2) fails.
   */
  it("awards the whole pot across the award frames", () => {
    const problems: string[] = [];
    for (const hand of hands) {
      if (hand.results.winners.length === 0) {
        continue;
      }
      const frames = buildReplay(hand);
      const final = frames[frames.length - 1];
      const awardFrames = frames.filter((frame) => frame.kind === "award");
      expect(final.kind).toBe("award");

      if (final.pot !== 0) {
        problems.push(`${hand.meta.handId} leftover pot ${final.pot}`);
      }

      const expected = hand.results.winners.reduce(
        (sum, winner) => sum + toDisplayNumber(winner.amount, hand.game.unit),
        0,
      );

      const awarded = final.seats.reduce((sum, seat) => sum + seat.winAmount, 0);
      if (Math.abs(awarded - expected) > 0.011) {
        problems.push(`${hand.meta.handId} seats hold ${awarded} vs ${expected}`);
      }

      let paid = 0;
      for (const frame of awardFrames) {
        const award = frame.potAward;
        if (!award || award.winners.length === 0) {
          problems.push(`${hand.meta.handId} award frame ${frame.index} pays nobody`);
          continue;
        }
        const share = award.winners.reduce((sum, winner) => sum + winner.amount, 0);
        if (Math.abs(share - award.amount) > 0.011) {
          problems.push(
            `${hand.meta.handId} ${award.name} pot labelled ${award.amount}, pays ${share}`,
          );
        }
        paid += share;
      }
      if (Math.abs(paid - expected) > 0.011) {
        problems.push(
          `${hand.meta.handId} ${awardFrames.length} award frames paid ${paid} vs ${expected}`,
        );
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("anchors frames on the action index, never on the frame index", () => {
    const hand = hands.find((entry) => primaryBoard(entry).length === 5)!;
    const frames = buildReplay(hand);
    const byIndex = new Map(hand.actions.map((action) => [action.index, action]));

    let anchored = 0;
    for (const frame of frames) {
      if (frame.actionIndex === null) {
        // Dealer-side frames: setup, the deal, a street, the sweep.
        expect(["setup", "deal", "street", "collect"]).toContain(frame.kind);
        continue;
      }
      expect(byIndex.has(frame.actionIndex), `frame ${frame.index}`).toBe(true);
      anchored += 1;
    }
    expect(anchored).toBeGreaterThan(0);
  });

  it("reveals the full board by the last frame", () => {
    for (const hand of hands) {
      const frames = buildReplay(hand);
      expect(frames[frames.length - 1].board).toEqual(primaryBoard(hand));
    }
  });

  it("exposes stacks in big blinds", () => {
    for (const hand of hands.slice(0, 40)) {
      const first = buildReplay(hand)[0];
      for (const seat of first.seats) {
        const player = hand.players.find((entry) => entry.seat === seat.seatNo)!;
        expect(seat.stackBb).toBe(toBigBlinds(player.startingStack, hand.game.bigBlind));
      }
      expect(first.potBb).toBe(0);
    }
  });

  it("exposes a resolved position for every seat that was dealt in", () => {
    for (const hand of hands.slice(0, 40)) {
      const first = buildReplay(hand)[0];
      const dealtIn = first.seats.filter((seat) => seat.position !== null);
      // Everyone in this corpus is dealt in; a sit-out would be null, never a
      // plausible-looking wrong position.
      expect(dealtIn).toHaveLength(first.seats.length);

      const positions = dealtIn.map((seat) => seat.position);
      expect(positions.filter((position) => position === "SB")).toHaveLength(1);
      expect(positions.filter((position) => position === "BB")).toHaveLength(1);

      const button = first.seats.find((seat) => seat.isButton);
      if (dealtIn.length === 2) {
        // Heads-up the button posts the small blind and nothing is BTN.
        expect(positions).not.toContain("BTN");
        expect(button?.position).toBe("SB");
      } else {
        expect(positions.filter((position) => position === "BTN")).toHaveLength(1);
        expect(button?.position).toBe("BTN");
      }
    }
  });

  it("anchors every street it visits", () => {
    const hand = hands.find((entry) => primaryBoard(entry).length === 5)!;
    const anchors = streetAnchors(buildReplay(hand));
    expect(anchors.map((anchor) => anchor.street)).toEqual([
      "preflop",
      "flop",
      "turn",
      "river",
      "showdown",
    ]);
  });
});

describe("buildReplay over converted WePlay hands", () => {
  it("ends every hand on an award frame", async () => {
    let checked = 0;
    for (const file of weplayFiles().slice(0, 25)) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const frames = buildReplay(hand);
        expect(frames[frames.length - 1].kind, hand.meta.handId).toBe("award");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

/**
 * Side pots, which the GG reference corpus happens not to contain: every hand
 * in `gg-hh/` settles into a single pot, so the per-pot award path needs a hand
 * that actually splits the middle or it is untested.
 */
describe("buildReplay over a hand with a side pot", () => {
  const SAMPLES = join(import.meta.dirname, "../../fixtures/samples");

  async function sidePotHand(relativePath: string): Promise<PhfHand> {
    const text = readFileSync(join(SAMPLES, relativePath), "utf8");
    const result = await convertAny(text, { sourceFilename: relativePath });
    const hand = result.hands.find((entry) => entry.results.pots.length > 1);
    expect(hand, relativePath).toBeDefined();
    return hand!;
  }

  it("splits the middle into main and side piles while the hand is live", async () => {
    const hand = await sidePotHand("pokerstars/09-cash-nlhe-sidepot-ante-mojibake-name.txt");
    const frames = buildReplay(hand);

    for (const frame of frames) {
      expect(frame.pots.length, `frame ${frame.index}`).toBeGreaterThan(0);
      const sum = frame.pots.reduce((total, pot) => total + pot.amount, 0);
      // However the middle is divided, the piles are the pot.
      expect(Math.abs(sum - frame.pot), `frame ${frame.index}`).toBeLessThan(0.011);
    }

    const split = frames.filter((frame) => frame.pots.length > 1);
    expect(split.length).toBeGreaterThan(0);
    expect(split[0].pots[0].name).toBe("Main");
    expect(split[0].pots[1].name).toBe("Side");
  });

  it("pays each pot as its own frame, main first", async () => {
    const hand = await sidePotHand("pokerstars/09-cash-nlhe-sidepot-ante-mojibake-name.txt");
    const awards = buildReplay(hand).filter((frame) => frame.kind === "award");

    expect(awards).toHaveLength(2);
    expect(awards.map((frame) => frame.potAward?.name)).toEqual(["Main", "Side"]);
    // The source pays the side pot first and the main pot second; the replay
    // orders them the way the summary reports the piles, main first.
    expect(awards[0].potAward?.amount).toBe(30.37);
    expect(awards[1].potAward?.amount).toBe(7.91);
    expect(awards[0].potAward?.winners).toEqual([{ seatNo: 3, amount: 30.37 }]);
    // The first award dwells; a side pot is only a number by then.
    expect(awards[0].holdMs).toBe(1600);
    expect(awards[1].holdMs).toBe(1100);
    // The middle empties one pot at a time, and empties completely.
    expect(awards[0].pot).toBe(7.91);
    expect(awards[1].pot).toBe(0);
    // Each award anchors on the collect action that paid it.
    for (const frame of awards) {
      const action = hand.actions.find((entry) => entry.index === frame.actionIndex);
      expect(action?.type, `frame ${frame.index}`).toBe("collect");
    }
  });

  it("flags the frame before an all-in runout", async () => {
    const hand = await sidePotHand("pokerstars/09-cash-nlhe-sidepot-ante-mojibake-name.txt");
    const frames = buildReplay(hand);
    const beats = frames.filter((frame) => frame.allInAt);

    // Both players were all-in on the flop, so the turn and river run out in
    // one go and exactly one frame is the beat before them.
    expect(beats).toHaveLength(1);
    const beat = frames[beats[0].index + 1];
    expect(beat.kind).toBe("street");
    expect(beat.street).toBe("turn");
  });
});
