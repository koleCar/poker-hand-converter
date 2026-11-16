/**
 * The desktop app's nodelock editor state (`app/src/solver/nodelock/editor/
 * state.ts`, `docs/NODELOCK.md` §5.2): undo and redo, Range mode's
 * frequency moves (the hands closest to indifference first), painting, Lock
 * all / Unlock all / Invert, a class's lock, and the lock it produces over the
 * 1,326 combos.
 */
import { describe, expect, it } from "vitest";

import {
  editorReducer,
  fromLockArrays,
  initialState,
  lockArrays,
  lockedCount,
  shareOf,
  type EditorAction,
  type EditorSpot,
  type EditorState,
} from "../../app/src/solver/nodelock/editor/state.js";

/**
 * Five hands, two actions (check, bet). Hand 4 never reaches the node.
 * EV of betting minus checking: hand 0 +2 (bets), 1 +0.1, 2 −0.05, 3 −1 (checks).
 */
const SPOT: EditorSpot = {
  hands: [10, 20, 30, 40, 50],
  reach: [1, 1, 1, 1, 0],
  gto: [
    [0, 0.5, 0.5, 1, 1],
    [1, 0.5, 0.5, 0, 0],
  ],
  ev: [
    [1, 1, 1, 1, 0],
    [3, 1.1, 0.95, 0, 0],
  ],
};

function run(...actions: EditorAction[]): EditorState {
  return actions.reduce((state, action) => editorReducer(SPOT, state, action), initialState(SPOT));
}

function columnsSumToOne(state: EditorState) {
  for (let i = 0; i < SPOT.hands.length; i += 1) {
    expect(state.strategy.reduce((s, row) => s + row[i], 0)).toBeCloseTo(1, 12);
  }
}

describe("nodelock editor state", () => {
  it("starts at GTO with nothing locked", () => {
    const state = initialState(SPOT);
    expect(state.strategy).toEqual([
      [0, 0.5, 0.5, 1, 1],
      [1, 0.5, 0.5, 0, 0],
    ]);
    expect(state.locked).toEqual([0, 0, 0, 0, 0]);
    expect(shareOf(SPOT, state.strategy, 1)).toBeCloseTo(0.5, 12);
  });

  it("moves the bet frequency up with the hands closest to indifference first, and locks the range", () => {
    // 50% → 62.5%: half a combo more bets; hand 1 (+0.1) is the cheapest, before hand 2 (−0.05).
    const up = run({ type: "frequency", action: 1, target: 0.625 });
    expect(shareOf(SPOT, up.strategy, 1)).toBeCloseTo(0.625, 12);
    expect(up.strategy[1][1]).toBeCloseTo(1, 12);
    expect(up.strategy[1][2]).toBeCloseTo(0.5, 12);
    expect(up.strategy[1][3]).toBe(0);
    expect(up.locked).toEqual([1, 1, 1, 1, 0]);
    columnsSumToOne(up);

    // Further: hand 2 next, hand 3 (−1) last.
    const more = editorReducer(SPOT, up, { type: "frequency", action: 1, target: 0.875 });
    expect(more.strategy[1][2]).toBeCloseTo(1, 12);
    expect(more.strategy[1][3]).toBeCloseTo(0.5, 12);
    columnsSumToOne(more);
  });

  it("moves the bet frequency down from the hands it helps least first", () => {
    // 50% → 25%: one combo fewer bets; hand 2 (bet loses 0.05) goes first, then hand 1 (+0.1); hand 0 (+2) keeps betting.
    const down = run({ type: "frequency", action: 1, target: 0.25 });
    expect(shareOf(SPOT, down.strategy, 1)).toBeCloseTo(0.25, 12);
    expect(down.strategy[1][2]).toBeCloseTo(0, 12);
    expect(down.strategy[1][1]).toBeCloseTo(0, 12);
    expect(down.strategy[1][0]).toBeCloseTo(1, 12);
    columnsSumToOne(down);
  });

  it("keeps a held action's share and moves a class only inside its mask", () => {
    const three: EditorSpot = {
      hands: [1, 2],
      reach: [1, 1],
      gto: [
        [0.2, 0.2],
        [0.3, 0.3],
        [0.5, 0.5],
      ],
      ev: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    };
    const state = editorReducer(three, initialState(three), { type: "frequency", action: 2, target: 0.8, held: [true, false, false] });
    // Only action 1 gives up share: action 0 stays at 20%.
    expect(shareOf(three, state.strategy, 0)).toBeCloseTo(0.2, 12);
    expect(shareOf(three, state.strategy, 2)).toBeCloseTo(0.8, 12);

    const classOnly = run({ type: "frequency", action: 1, target: 0, mask: [0, 1, 1, 0, 0] });
    expect(classOnly.strategy[1][1]).toBe(0);
    expect(classOnly.strategy[1][2]).toBe(0);
    expect(classOnly.strategy[1][0]).toBe(1);
    // A class lock locks that class only.
    expect(classOnly.locked).toEqual([0, 1, 1, 0, 0]);
  });

  it("paints a mix onto hands and locks them", () => {
    const state = run({ type: "paint", hands: [0, 3], mix: [3, 1] });
    expect(state.strategy[0][0]).toBeCloseTo(0.75, 12);
    expect(state.strategy[1][3]).toBeCloseTo(0.25, 12);
    expect(state.locked).toEqual([1, 0, 0, 1, 0]);
    expect(lockedCount(SPOT, state)).toEqual({ locked: 2, reaching: 4 });
  });

  it("locks all, unlocks all and inverts over the reaching hands; unlocked hands go back to GTO", () => {
    const painted = run({ type: "paint", hands: [0], mix: [1, 0] });
    const inverted = editorReducer(SPOT, painted, { type: "invert" });
    expect(inverted.locked).toEqual([0, 1, 1, 1, 0]);
    // Hand 0 adapts again, so it shows GTO's bet.
    expect(inverted.strategy[1][0]).toBe(1);

    expect(editorReducer(SPOT, painted, { type: "lockAll" }).locked).toEqual([1, 1, 1, 1, 0]);
    const none = editorReducer(SPOT, painted, { type: "unlockAll" });
    expect(none.locked).toEqual([0, 0, 0, 0, 0]);
    expect(none.strategy).toEqual(initialState(SPOT).strategy);
  });

  it("flips a cell's lock as a whole", () => {
    const one = run({ type: "toggleLock", hands: [1, 2] });
    expect(one.locked).toEqual([0, 1, 1, 0, 0]);
    const partly = run({ type: "toggleLock", hands: [1] }, { type: "toggleLock", hands: [1, 2] });
    expect(partly.locked).toEqual([0, 1, 1, 0, 0]);
    expect(editorReducer(SPOT, one, { type: "toggleLock", hands: [1, 2] }).locked).toEqual([0, 0, 0, 0, 0]);
  });

  it("undoes and redoes every step, and a new step clears the redo", () => {
    const a = run({ type: "paint", hands: [0], mix: [1, 0] }, { type: "paint", hands: [3], mix: [0, 1] });
    const back = editorReducer(SPOT, a, { type: "undo" });
    expect(back.locked).toEqual([1, 0, 0, 0, 0]);
    const twice = editorReducer(SPOT, back, { type: "undo" });
    expect(twice.locked).toEqual([0, 0, 0, 0, 0]);
    expect(editorReducer(SPOT, twice, { type: "undo" })).toBe(twice);
    const again = editorReducer(SPOT, twice, { type: "redo" });
    expect(again.locked).toEqual([1, 0, 0, 0, 0]);
    const branched = editorReducer(SPOT, again, { type: "lockAll" });
    expect(branched.future).toEqual([]);
    expect(editorReducer(SPOT, branched, { type: "redo" })).toBe(branched);
  });

  it("resets to GTO, and Reset is undoable", () => {
    const state = run({ type: "frequency", action: 1, target: 1 }, { type: "reset" });
    expect(state.strategy).toEqual(initialState(SPOT).strategy);
    expect(state.locked.some(Boolean)).toBe(false);
    expect(editorReducer(SPOT, state, { type: "undo" }).locked).toEqual([1, 1, 1, 1, 0]);
  });

  it("writes the lock over the 1,326 combos and reads it back", () => {
    const state = run({ type: "paint", hands: [1], mix: [0.25, 0.75] });
    const lock = lockArrays(SPOT, state);
    expect(lock.locked).toHaveLength(1326);
    expect(lock.locked[20]).toBe(1);
    expect(lock.locked.reduce((s, x) => s + x, 0)).toBe(1);
    expect(lock.strategy[1][20]).toBeCloseTo(0.75, 12);
    expect(lock.strategy[0][10]).toBe(0);

    const loaded = editorReducer(SPOT, initialState(SPOT), { type: "load", ...fromLockArrays(SPOT, lock), preset: "tight" });
    expect(loaded.locked).toEqual(state.locked);
    expect(loaded.strategy[1][1]).toBeCloseTo(0.75, 12);
    expect(loaded.preset).toBe("tight");
  });
});

describe("nodelock editor steps", () => {
  it("folds one drag into one undo step", () => {
    const state = run(
      { type: "paint", hands: [0], mix: [1, 0] },
      { type: "paint", hands: [1], mix: [1, 0], merge: true },
      { type: "paint", hands: [2], mix: [1, 0], merge: true },
    );
    expect(state.locked).toEqual([1, 1, 1, 0, 0]);
    expect(state.past).toHaveLength(1);
    expect(editorReducer(SPOT, state, { type: "undo" }).locked).toEqual([0, 0, 0, 0, 0]);
  });
});
