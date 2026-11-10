/**
 * Run it twice in the replayer: run 2 is drawn from the street the hand was
 * actually run twice from, never as a second copy of the streets both runs
 * share.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { convertAny } from "../../web/src/lib/parsers/index.js";
import { buildReplay, sharedRunoutCards } from "../../web/src/lib/replay.js";

const RIVER_TWICE = fileURLToPath(
  new URL(
    "../../fixtures/samples/pokerstars/03-cash-plo-run-it-twice-sidepot-dualtimestamp.txt",
    import.meta.url,
  ),
);

describe("run it twice in the replayer", () => {
  it("counts the cards two runouts share, by street", () => {
    const first = ["7s", "9d", "3c", "Ad", "4s"];
    expect(sharedRunoutCards(first, ["7s", "9d", "3c", "Ad", "6s"])).toBe(4);
    expect(sharedRunoutCards(first, ["7s", "9d", "3c", "Kh", "6s"])).toBe(3);
    expect(sharedRunoutCards(first, ["Qh", "Jc", "2d", "Kh", "6s"])).toBe(0);
    // A runout never splits mid-flop.
    expect(sharedRunoutCards(first, ["7s", "9d", "Qc", "Kh", "6s"])).toBe(0);
    expect(sharedRunoutCards(first, [])).toBe(0);
  });

  it("shows one board through the turn when the hand was run twice on the river", async () => {
    const result = await convertAny(readFileSync(RIVER_TWICE, "utf8"), {
      sourceFilename: "03.txt",
      siteId: "pokerstars",
    });
    const hand = result.hands[0];
    expect(hand.board.runouts).toHaveLength(2);

    const frames = buildReplay(hand);
    for (const frame of frames) {
      expect(frame.boardSecondFrom).toBe(4);
      if (frame.board.length < 5) {
        expect(frame.boardSecond).toEqual([]);
      }
    }
    const last = frames[frames.length - 1];
    expect(last.board).toEqual(["3d", "Kd", "9h", "8h", "4s"]);
    expect(last.boardSecond).toEqual(["3d", "Kd", "9h", "8h", "Kc"]);
    // Run 2 arrives on the same frame as run 1's river, not before it.
    const firstRiver = frames.findIndex((frame) => frame.board.length === 5);
    const firstSecond = frames.findIndex((frame) => frame.boardSecond.length > 0);
    expect(firstSecond).toBe(firstRiver);
  });
});
