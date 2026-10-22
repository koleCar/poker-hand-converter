import { describe, expect, it } from "vitest";

import {
  arrivalSignalFromRow,
  createArrivalBatcher,
  type ArrivalBatch,
  type ArrivalTimers,
} from "../../frontend/src/lib/live/arrivals.js";

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  const timers: ArrivalTimers = {
    set(callback, ms) {
      const id = nextId++;
      queue.set(id, { at: now + ms, callback });
      return id;
    },
    clear(handle) {
      queue.delete(handle as number);
    },
    now: () => now,
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of queue) {
        if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  }
  return { timers, advance, pendingTimers: () => queue.size };
}

function setup(options: { hidden?: boolean } = {}) {
  const clock = fakeTimers();
  const flushes: ArrivalBatch[] = [];
  const batcher = createArrivalBatcher({
    onFlush: (batch) => flushes.push(batch),
    quietMs: 1500,
    maxWaitMs: 5000,
    maxWaitCapMs: 30000,
    hidden: options.hidden,
    timers: clock.timers,
  });
  return { ...clock, flushes, batcher };
}

describe("createArrivalBatcher", () => {
  it("refreshes once, 1.5 s after a single signal", () => {
    const { batcher, advance, flushes } = setup();
    batcher.push({ hands: 500, origin: "desktop" });
    advance(1499);
    expect(flushes).toHaveLength(0);
    advance(1);
    expect(flushes).toEqual([{ seq: 1, hands: 500, desktop: true, desktopHands: 500, resync: false }]);
  });

  it("folds a burst into one refresh, never one per signal", () => {
    const { batcher, advance, flushes } = setup();
    for (let i = 0; i < 3; i += 1) {
      batcher.push({ hands: 500, origin: "desktop" });
      advance(1000);
    }
    expect(flushes).toHaveLength(0);
    advance(500);
    expect(flushes).toEqual([{ seq: 1, hands: 1500, desktop: true, desktopHands: 1500, resync: false }]);
  });

  it("a burst that never goes quiet still refreshes after the max wait", () => {
    const { batcher, advance, flushes } = setup();
    // A batch every second for 5 s: never 1.5 s of quiet.
    for (let i = 0; i < 5; i += 1) {
      batcher.push({ hands: 500, origin: "desktop" });
      advance(1000);
    }
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ seq: 1, hands: 2500 });
  });

  it("backs off while a backfill streams: 5 s, 10 s, 20 s, then 30 s", () => {
    const { batcher, advance, flushes } = setup();
    const at: number[] = [];
    let t = 0;
    while (t < 120000) {
      batcher.push({ hands: 500, origin: "desktop" });
      advance(1000);
      t += 1000;
      while (at.length < flushes.length) at.push(t);
    }
    const gaps = at.map((value, index) => value - (index === 0 ? 0 : at[index - 1]));
    expect(gaps.slice(0, 5)).toEqual([5000, 10000, 20000, 30000, 30000]);
    // Every hand is counted exactly once across the flushes.
    advance(2000);
    expect(flushes.reduce((sum, batch) => sum + batch.hands, 0)).toBe(120 * 500);
  });

  it("a quiet flush resets the back-off", () => {
    const { batcher, advance, flushes } = setup();
    for (let i = 0; i < 5; i += 1) {
      batcher.push({ hands: 1, origin: "desktop" });
      advance(1000);
    }
    expect(flushes).toHaveLength(1); // forced: the next wait is 10 s
    batcher.push({ hands: 1, origin: "desktop" });
    advance(1500); // the last batch, then quiet
    expect(flushes).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) {
      batcher.push({ hands: 1, origin: "desktop" });
      advance(1000);
    }
    expect(flushes).toHaveLength(3); // back to 5 s
  });

  it("holds everything while hidden and refreshes once when shown", () => {
    const { batcher, advance, flushes, pendingTimers } = setup({ hidden: true });
    for (let i = 0; i < 40; i += 1) {
      batcher.push({ hands: 500, origin: "desktop" });
      advance(1000);
    }
    expect(flushes).toHaveLength(0);
    expect(pendingTimers()).toBe(0);
    batcher.setHidden(false);
    expect(flushes).toEqual([{ seq: 1, hands: 20000, desktop: true, desktopHands: 20000, resync: false }]);
  });

  it("hiding cancels a scheduled refresh; showing with nothing pending does nothing", () => {
    const { batcher, advance, flushes } = setup();
    batcher.push({ hands: 2, origin: "web" });
    batcher.setHidden(true);
    advance(60000);
    expect(flushes).toHaveLength(0);
    batcher.setHidden(false);
    expect(flushes).toEqual([{ seq: 1, hands: 2, desktop: false, desktopHands: 0, resync: false }]);
    batcher.setHidden(true);
    batcher.setHidden(false);
    advance(60000);
    expect(flushes).toHaveLength(1);
  });

  it("a resync refreshes with an unknown count", () => {
    const { batcher, advance, flushes } = setup();
    batcher.push({ hands: null, origin: null });
    advance(1500);
    expect(flushes).toEqual([{ seq: 1, hands: 0, desktop: false, desktopHands: 0, resync: true }]);
  });

  it("numbers its flushes and keeps the origins of one batch together", () => {
    const { batcher, advance, flushes } = setup();
    batcher.push({ hands: 1, origin: "web" });
    advance(1500);
    batcher.push({ hands: 3, origin: "web" });
    batcher.push({ hands: 500, origin: "desktop" });
    advance(1500);
    expect(flushes.map((batch) => [batch.seq, batch.hands, batch.desktop, batch.desktopHands])).toEqual([
      [1, 1, false, 0],
      [2, 503, true, 500],
    ]);
  });

  it("does nothing after dispose (unmount, sign-out)", () => {
    const { batcher, advance, flushes, pendingTimers } = setup();
    batcher.push({ hands: 5, origin: "desktop" });
    batcher.dispose();
    expect(pendingTimers()).toBe(0);
    batcher.push({ hands: 5, origin: "desktop" });
    batcher.setHidden(true);
    batcher.setHidden(false);
    advance(60000);
    expect(flushes).toHaveLength(0);
  });
});

describe("arrivalSignalFromRow", () => {
  it("reads the row Realtime delivers", () => {
    expect(
      arrivalSignalFromRow({ id: "x", owner_id: "y", seq: 4, hands: 500, origin: "desktop", arrived_at: "z" }),
    ).toEqual({ hands: 500, origin: "desktop" });
    expect(arrivalSignalFromRow({ hands: "2", origin: "web" })).toEqual({ hands: 2, origin: "web" });
  });

  it("an unexpected shape still means something arrived", () => {
    expect(arrivalSignalFromRow(undefined)).toEqual({ hands: null, origin: null });
    expect(arrivalSignalFromRow({ hands: -1, origin: "mars" })).toEqual({ hands: null, origin: null });
  });
});
