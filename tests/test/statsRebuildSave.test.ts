/**
 * The statistics rebuild's writes (docs/RAIL-PLAN.md R4.4, finding F1):
 * `web/src/lib/db/statsSave.ts`, against a fake `save_hand_stats` that
 * refuses a whole call when one of its rows breaks a constraint, as the
 * database does.
 */

import { describe, expect, it } from "vitest";

import { isRowRefusal, saveRowsByHand, type SaveError } from "../../web/src/lib/db/statsSave";

type Row = { hand_key: string; seat: number };

/** A fake RPC: refuses any call with a row in `bad` (23514), records every call. */
function fakeSave(bad: (row: Row) => boolean, error: SaveError = { code: "23514", message: "check" }) {
  const calls: Row[][] = [];
  const save = async (rows: Row[]) => {
    calls.push(rows);
    return rows.some(bad) ? { data: null, error } : { data: { inserted: rows.length }, error: null };
  };
  return { calls, save };
}

/** `n` hands of `seats` rows each, keyed h0, h1, ... */
function hands(n: number, seats: number): Row[] {
  return Array.from({ length: n }, (_, h) => Array.from({ length: seats }, (_, s) => ({ hand_key: `h${h}`, seat: s + 1 }))).flat();
}

describe("saveRowsByHand", () => {
  it("writes whole hands per call, never splitting one across two", async () => {
    const { calls, save } = fakeSave(() => false);
    const out = await saveRowsByHand(hands(10, 6), save, 20);
    expect(out).toEqual({ inserted: 60, refused: new Set() });
    expect(calls.map((c) => c.length)).toEqual([18, 18, 18, 6]);
    for (const call of calls) {
      const keys = new Set(call.map((r) => r.hand_key));
      for (const key of keys) expect(call.filter((r) => r.hand_key === key)).toHaveLength(6);
    }
  });

  it("a refused row costs its hand, not the page: the rest are saved", async () => {
    const rows = hands(5, 3);
    rows[7] = { hand_key: "h2", seat: 1227 }; // an Ignition tournament seat in hand h2
    const { calls, save } = fakeSave((r) => r.seat > 24);
    const out = await saveRowsByHand(rows, save, 900);
    expect(out.refused).toEqual(new Set(["h2"]));
    expect(out.inserted).toBe(12);
    // One refused call for the page, then one call per hand.
    expect(calls).toHaveLength(1 + 5);
  });

  it("a call of one hand that is refused is not retried", async () => {
    const { calls, save } = fakeSave((r) => r.hand_key === "h0");
    const out = await saveRowsByHand(hands(3, 2), save, 2);
    expect(out).toEqual({ inserted: 4, refused: new Set(["h0"]) });
    expect(calls).toHaveLength(3);
  });

  it("skips the hands it is told to (no EV row for refused statistics)", async () => {
    const { calls, save } = fakeSave(() => false);
    const out = await saveRowsByHand(hands(3, 1), save, 900, new Set(["h1"]));
    expect(out.inserted).toBe(2);
    expect(calls.flat().map((r) => r.hand_key)).toEqual(["h0", "h2"]);
  });

  it("anything but a row refusal still fails the slice (the budget, the session)", async () => {
    for (const code of ["53400", "42501", undefined]) {
      const { save } = fakeSave(() => true, { code, message: "nope" });
      await expect(saveRowsByHand(hands(2, 2), save, 900)).rejects.toMatchObject({ message: "nope" });
    }
    // ... also when it comes from the per-hand retry.
    let n = 0;
    const save = async (_rows: Row[]) => {
      n += 1;
      return n === 1
        ? { data: null, error: { code: "23514", message: "check" } }
        : { data: null, error: { code: "53400", message: "budget" } };
    };
    await expect(saveRowsByHand(hands(2, 2), save, 900)).rejects.toMatchObject({ code: "53400" });
  });

  it("nothing to write is no call", async () => {
    const { calls, save } = fakeSave(() => false);
    expect(await saveRowsByHand([], save, 900)).toEqual({ inserted: 0, refused: new Set() });
    expect(calls).toHaveLength(0);
  });
});

describe("isRowRefusal", () => {
  it("is SQLSTATE class 22 or 23 only", () => {
    expect(isRowRefusal({ code: "23514", message: "" })).toBe(true); // check_violation
    expect(isRowRefusal({ code: "22003", message: "" })).toBe(true); // numeric_value_out_of_range
    expect(isRowRefusal({ code: "53400", message: "" })).toBe(false);
    expect(isRowRefusal({ code: "42501", message: "" })).toBe(false);
    expect(isRowRefusal({ code: "PGRST301", message: "" })).toBe(false);
    expect(isRowRefusal({ message: "" })).toBe(false);
  });
});
