/**
 * The Solver library's preflop line (`web/src/components/solver/preflop.ts`)
 * on the committed chart sets, and the picked flop's suit relabelling
 * (`pickedFlop`, `web/src/lib/solver/explore.ts`): every library line is
 * reached by walking its own key and ends as that line's heads-up flop, the
 * stacks follow the chart's amounts, a rewind is a prefix, and a flop in any
 * suits finds its canonical key and reads the chunk's cards back in its own.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { flopLinesFor } from "../../web/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../web/src/lib/charts/index.js";
import { canonicalBoard, flopKey, pickedFlop } from "../../web/src/lib/solver/index.js";
import { preflopState } from "../../web/src/components/solver/preflop.js";

const charts = (id: string): ChartSet =>
  loadCharts(JSON.parse(readFileSync(join(import.meta.dirname, `../../web/src/lib/charts/data/${id}.json`), "utf8")));

describe("the preflop line", () => {
  for (const id of ["nlhe-cash-6max-100bb", "nlhe-cash-9max-100bb", "nlhe-cash-hu-100bb"]) {
    const set = charts(id);
    const lines = flopLinesFor(set.game.players);

    it(`${id}: starts at the first seat with the blinds posted`, () => {
      const state = preflopState(set, "", lines);
      expect(state.node?.actor).toBe(set.game.positions[0]);
      expect(state.end).toBeNull();
      expect(state.potBb).toBeCloseTo(1.5, 9);
      const bb = state.seats.find((s) => s.position === "BB")!;
      expect(bb.stackBb).toBeCloseTo(set.game.stackBb - 1, 9);
    });

    it(`${id}: every library line walks to its own heads-up flop`, () => {
      for (const line of lines) {
        const state = preflopState(set, line.key, lines);
        expect(state.line).toBe(line.key);
        expect(state.node).toBeNull();
        expect(state.end).toMatchObject({ kind: "flop", line: { id: line.id } });
        // The pot is what the chunks were solved at: the two players' money and the folded blinds'.
        const inPot = state.seats.reduce((sum, seat) => sum + seat.inBb, 0);
        expect(state.potBb).toBeCloseTo(inPot, 9);
        for (const seat of state.seats) expect(seat.stackBb + seat.inBb).toBeCloseTo(set.game.stackBb, 9);
      }
    });

    it(`${id}: a rewind is a prefix, and a malformed tail is cut off`, () => {
      const key = lines[0].key;
      const state = preflopState(set, key, lines);
      const acted = state.seats.flatMap((seat) => seat.acts);
      expect(acted.map((a) => a.index).sort((x, y) => x - y)).toEqual([...key].map((_, i) => i));
      const back = preflopState(set, key.slice(0, acted[acted.length - 1].index), lines);
      expect(back.node).not.toBeNull();
      expect(preflopState(set, `${key}zz`, lines).line).toBe(key);
    });
  }

  it("ends a line where everyone folds to one player", () => {
    const set = charts("nlhe-cash-6max-100bb");
    const state = preflopState(set, "fffff", flopLinesFor(6));
    expect(state.end).toEqual({ kind: "folded", winner: "BB" });
  });
});

describe("the picked flop", () => {
  it("finds the canonical key and reads the chunk's cards back in the picked suits", () => {
    for (const flop of [["Ks", "7h", "2d"], ["Ah", "Ad", "9c"], ["Qc", "Jc", "Tc"], ["8d", "8h", "3d"], ["5s", "4c", "4s"]]) {
      const picked = pickedFlop(flop);
      expect(picked.key).toBe(flopKey(flop));
      const canonical = canonicalBoard(flop).board;
      expect(canonical.map(picked.toPicked).sort()).toEqual([...flop].sort());
      // A card off the board maps one to one too: all 52 stay distinct.
      const deck = "AKQJT98765432".split("").flatMap((r) => ["s", "h", "d", "c"].map((s) => `${r}${s}`));
      expect(new Set(deck.map(picked.toPicked)).size).toBe(52);
    }
  });
});
