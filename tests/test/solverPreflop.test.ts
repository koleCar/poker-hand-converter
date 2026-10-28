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

describe("a later seat's options (everyone before it folds)", () => {
  const set = charts("nlhe-cash-6max-100bb");
  const lines = flopLinesFor(6);
  const ahead = (line: string) =>
    Object.fromEntries(preflopState(set, line, lines).seats.map((seat) => [seat.position, seat.ahead?.line ?? null]));

  it("folds the seats in between, up to the big blind's walk", () => {
    // Unopened: each later seat is reached by folds alone; folding to the big blind ends the hand.
    expect(ahead("")).toEqual({ UTG: null, HJ: "f", CO: "ff", BTN: "fff", SB: "ffff", BB: null });
    // After an open, the big blind faces it once everyone else folds; the opener has acted.
    expect(ahead("r")).toEqual({ UTG: null, HJ: null, CO: "rf", BTN: "rff", SB: "rfff", BB: "rffff" });
  });

  it("stops at a seat that has acted", () => {
    // UTG opens, HJ 3-bets, CO to act: the seats behind get theirs, the folds stop at UTG.
    expect(ahead("rr")).toEqual({ UTG: null, HJ: null, CO: null, BTN: "rrf", SB: "rrff", BB: "rrfff" });
    // The big blind facing the small blind's limp cannot fold (it checks): nobody is ahead of it.
    expect(Object.values(ahead("ffffc")).every((line) => line === null)).toBe(true);
  });

  it("lands on the seat's own decision, and picking an option plays the folds", () => {
    for (const line of ["", "r", "ff", "rr", "fr"]) {
      for (const seat of preflopState(set, line, lines).seats) {
        if (!seat.ahead) continue;
        expect(seat.ahead.node.actor).toBe(seat.position);
        expect(preflopState(set, seat.ahead.line, lines).node?.actor).toBe(seat.position);
      }
    }
    const btn = preflopState(set, "", lines).seats.find((seat) => seat.position === "BTN")!.ahead!;
    const raise = btn.node.options.find((option) => option.action === "raise")!;
    const after = preflopState(set, btn.line + raise.code, lines);
    expect(after.seats.filter((seat) => seat.folded).map((seat) => seat.position)).toEqual(["UTG", "HJ", "CO"]);
    expect(after.node?.actor).toBe("SB");
    expect(after.node?.facing).toEqual({ position: "BTN", toBb: raise.toBb });
  });
});

describe("a later seat's options on full ring and heads-up", () => {
  const sets = Object.fromEntries(["nlhe-cash-9max-100bb", "nlhe-cash-hu-100bb"].map((id) => [id, charts(id)]));
  const ahead = (id: string, line: string) => {
    const set = sets[id];
    const state = preflopState(set, line, flopLinesFor(set.game.players));
    return Object.fromEntries(state.seats.map((seat) => [seat.position, seat.ahead?.line ?? null]));
  };

  it("9-max: folds the seats in between, up to the big blind's walk", () => {
    const id = "nlhe-cash-9max-100bb";
    expect(ahead(id, "")).toEqual({
      UTG: null, "UTG+1": "f", "UTG+2": "ff", LJ: "fff", HJ: "ffff", CO: "fffff", BTN: "ffffff", SB: "fffffff", BB: null,
    });
    expect(ahead(id, "r")).toEqual({
      UTG: null, "UTG+1": null, "UTG+2": "rf", LJ: "rff", HJ: "rfff", CO: "rffff", BTN: "rfffff", SB: "rffffff", BB: "rfffffff",
    });
  });

  it("9-max: stops at a seat that has acted", () => {
    const id = "nlhe-cash-9max-100bb";
    // UTG opens, UTG+1 3-bets, UTG+2 to act: the folds stop at UTG.
    expect(ahead(id, "rr")).toEqual({
      UTG: null, "UTG+1": null, "UTG+2": null, LJ: "rrf", HJ: "rrff", CO: "rrfff", BTN: "rrffff", SB: "rrfffff", BB: "rrffffff",
    });
    // UTG folds, UTG+1 opens: a seat that folded has acted too.
    expect(ahead(id, "fr")).toEqual({
      UTG: null, "UTG+1": null, "UTG+2": null, LJ: "frf", HJ: "frff", CO: "frfff", BTN: "frffff", SB: "frfffff", BB: "frffffff",
    });
    // The big blind facing the small blind's limp checks rather than folds: nobody is ahead of it.
    expect(Object.values(ahead(id, "fffffffc")).every((line) => line === null)).toBe(true);
  });

  it("heads-up: the small blind acts first and folding it ends the hand, so nobody is ever ahead", () => {
    const set = sets["nlhe-cash-hu-100bb"];
    expect(set.game.positions).toEqual(["SB", "BB"]);
    expect(preflopState(set, "", flopLinesFor(2)).node?.actor).toBe("SB");
    expect(preflopState(set, "f", flopLinesFor(2)).end).toEqual({ kind: "folded", winner: "BB" });
    // Every other decision is the big blind's against the small blind's act, or the small blind's after acting.
    for (const line of set.nodes.keys()) {
      expect(Object.values(ahead("nlhe-cash-hu-100bb", line)).every((a) => a === null)).toBe(true);
    }
  });

  it("every ahead line, at every chart node, lands on the seat's own decision through folds only", () => {
    for (const set of Object.values(sets)) {
      const lines = flopLinesFor(set.game.players);
      for (const line of set.nodes.keys()) {
        for (const seat of preflopState(set, line, lines).seats) {
          if (!seat.ahead) continue;
          expect(seat.acts).toEqual([]);
          expect(seat.ahead.node.actor).toBe(seat.position);
          expect(seat.ahead.line.startsWith(line)).toBe(true);
          const there = preflopState(set, seat.ahead.line, lines);
          expect(there.line).toBe(seat.ahead.line);
          expect(there.node).toBe(seat.ahead.node);
          const played = there.seats.flatMap((s) => s.acts).filter((act) => act.index >= line.length);
          expect(played.every((act) => act.action === "fold")).toBe(true);
        }
      }
    }
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
