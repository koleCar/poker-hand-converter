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

  it("awards the whole pot in the final frame", () => {
    const problems: string[] = [];
    for (const hand of hands) {
      if (hand.results.winners.length === 0) {
        continue;
      }
      const frames = buildReplay(hand);
      const final = frames[frames.length - 1];
      expect(final.kind).toBe("award");
      if (final.pot !== 0) {
        problems.push(`${hand.meta.handId} leftover pot ${final.pot}`);
      }
      const awarded = final.seats.reduce((sum, seat) => sum + seat.winAmount, 0);
      const expected = hand.results.winners.reduce(
        (sum, winner) => sum + toDisplayNumber(winner.amount, hand.game.unit),
        0,
      );
      if (Math.abs(awarded - expected) > 0.011) {
        problems.push(`${hand.meta.handId} awarded ${awarded} vs ${expected}`);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
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
