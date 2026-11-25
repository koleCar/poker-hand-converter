/**
 * The Trainer's "Look up in Solver" (#420, `lib/training/solverLink.ts`):
 * where a dealt spot sits in the Solver library - the chart node preflop,
 * the hand's line from the flop on the turn and river (on the spot's own
 * flop, or stopped at the turn's deal on a representative one), and the
 * preflop line when the library holds no flop for it.
 */

import { describe, expect, it } from "vitest";

import { parseWalk } from "../../web/src/lib/analysis/solverWalk.js";
import { DEFAULT_CHART_SET } from "../../web/src/lib/charts/index.js";
import { FLOP_REPRESENTATIVES, flopKey, mapFlop } from "../../web/src/lib/solver/index.js";
import { dealPreflop } from "../../web/src/lib/training/preflop.js";
import { generateRiverSpot } from "../../web/src/lib/training/river.js";
import { trainerSolverLink } from "../../web/src/lib/training/solverLink.js";
import type { FlopLibrary } from "../../web/src/lib/analysis/flopLibrary.js";
import { fullLibrary } from "./charts/support.js";

const library = fullLibrary();

/** A flop library whose manifest holds the flops `holds` says; nothing is ever read from it. */
function manifest(holds: (key: string) => boolean): FlopLibrary {
  return { has: (_set: string, _line: string, key: string) => holds(key), get: () => null } as unknown as FlopLibrary;
}

describe("trainer spot → Solver link", () => {
  it("opens a preflop spot at the chart node it was dealt from", () => {
    const spot = dealPreflop(library, { set: DEFAULT_CHART_SET, family: "vs-open", seat: "BB", vs: "BTN", bias: "range" }, 7)!;
    expect(trainerSolverLink(spot, library, null)).toEqual({ set: spot.set, line: spot.line, flop: null, path: null, walk: null, approx: null });
  });

  it("follows a river spot's own line onto its turn and river when the library holds its flop", () => {
    const spot = generateRiverSpot(library, { pot: "srp", seat: "oop" }, 11)!;
    const link = trainerSolverLink(spot, library, manifest(() => true))!;
    expect(link.approx).toBeNull();
    expect(link.flop).toBe(spot.board.slice(0, 3).join(""));
    const steps = parseWalk(link.walk)!;
    expect(steps.filter((step) => step.kind === "card").map((step) => step.kind === "card" && step.card)).toEqual([spot.board[3], spot.board[4]]);
    // Out of position the hero acts first on the river: the walk ends at the river's card.
    expect(steps[steps.length - 1]).toEqual({ kind: "card", card: spot.board[4] });
  });

  it("stops at the turn's deal on a representative flop", () => {
    for (let seed = 1; seed < 40; seed += 1) {
      const spot = generateRiverSpot(library, { pot: "srp", seat: "ip" }, seed);
      if (!spot) continue;
      const own = flopKey(spot.board.slice(0, 3));
      const representative = mapFlop(spot.board.slice(0, 3), FLOP_REPRESENTATIVES).representative;
      if (representative === own) continue;
      const link = trainerSolverLink(spot, library, manifest((key) => key === representative))!;
      expect(link.flop).toBe(representative);
      expect(link.approx).toBe("flop");
      expect(parseWalk(link.walk)?.some((step) => step.kind === "card") ?? false).toBe(false);
      return;
    }
    throw new Error("no river spot off a representative flop");
  });

  it("falls back to the preflop line when the library holds no flop for the spot", () => {
    const spot = generateRiverSpot(library, { pot: "srp", seat: "ip" }, 21)!;
    const link = trainerSolverLink(spot, library, manifest(() => false))!;
    expect(link.approx).toBe("preflop");
    expect(link.flop).toBeNull();
    expect(link.walk).toBeNull();
    expect(link.line).toMatch(/^[fkcra]+$/);
    expect(trainerSolverLink(spot, library, null)).toEqual(link);
  });
});
