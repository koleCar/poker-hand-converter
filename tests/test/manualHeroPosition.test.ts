/**
 * Manual hand entry's "You are" picker (`components/manual/editorState.ts`):
 * the hero keeps their seat and picking a position moves the button, so every
 * option has to land the hero exactly where it says, in preflop order.
 */

import { describe, expect, it } from "vitest";

import {
  cleanName,
  defaultState,
  heroPositions,
  neighbourSeat,
  withTableSize,
  type EditorState,
} from "../../web/src/components/manual/editorState.js";
import { resolvePositions } from "../../web/src/lib/phf/types.js";

const name = (seat: number) => `Player ${seat}`;

function table(size: number, heroSeat = 3): EditorState {
  return { ...withTableSize(defaultState(name), size, name), heroSeat };
}

describe("heroPositions", () => {
  it("offers every 6-max position in preflop order", () => {
    expect(heroPositions(table(6)).map((option) => option.position)).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
  });

  it("puts the hero in the picked position for every table size", () => {
    for (const size of [2, 3, 6, 9]) {
      const state = table(size, 2);
      const seats = state.seats.map((seat) => seat.seat);
      const options = heroPositions(state);
      expect(options).toHaveLength(size);
      for (const option of options) {
        expect(resolvePositions(seats, option.buttonSeat).get(2)).toBe(option.position);
      }
    }
  });

  it("starts heads-up with the button, which is the small blind", () => {
    expect(heroPositions(table(2, 1)).map((option) => option.position)).toEqual(["SB", "BB"]);
  });

  it("skips empty seats", () => {
    const state = table(6);
    state.seats = state.seats.map((seat) => (seat.seat === 5 ? { ...seat, taken: false } : seat));
    const options = heroPositions(state);
    expect(options).toHaveLength(5);
    expect(options.some((option) => option.buttonSeat === 5)).toBe(false);
  });
});

describe("renaming helpers", () => {
  it("moves round the taken seats and wraps", () => {
    const state = table(6);
    expect(neighbourSeat(state, 6, 1)).toBe(1);
    expect(neighbourSeat(state, 1, -1)).toBe(6);
  });

  it("strips the characters PHF names cannot hold", () => {
    expect(cleanName("  fish (99) [x]: ")).toBe("fish 99 x");
  });
});
