/**
 * The Solver library's live turn (`web/src/lib/solver/liveTurn.ts`) on the
 * committed pilot chunks: the turn game a deal builds carries the flop's
 * pot, stack and narrowed ranges, and its solve reads like a full solve's
 * turn file - a turn decision at the root, river deals below, players named
 * by the chunk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE } from "../../../web/src/lib/analysis/index.js";
import {
  dealtCards,
  decodeChunk,
  exploreNode,
  liveTurnSpot,
  LiveTurnError,
  NUM_COMBOS,
  rangesAt,
  solveLiveTurn,
  turnDeal,
  type FlopChunk,
  type FlopManifest,
} from "../../../web/src/lib/solver/index.js";

const DIR = join(import.meta.dirname, "../../scripts/flop-library/pilot/nlhe-cash-6max-100bb", FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));

function chunk(line: string, flop: string): FlopChunk {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest;
  const entry = manifest.entries.find((e) => e.line === line && e.flop === flop);
  if (!entry) throw new Error(`no ${line}/${flop} in the pilot`);
  return decodeChunk(readFileSync(join(DIR, entry.path)));
}

/** The deal after a line of flop action labels from the root, e.g. ["X", "X"]. */
function dealAfter(c: FlopChunk, labels: string[]): number {
  let at = 0;
  for (const [k, label] of labels.entries()) {
    const action = exploreNode(c, at).actions.find((a) => a.label === label);
    if (!action) throw new Error(`no ${label} at node ${at}`);
    if (k === labels.length - 1) return action.deal;
    at = action.child;
  }
  throw new Error("empty line");
}

describe.runIf(PRESENT)("a live turn from a pilot chunk", () => {
  // needs the flop-library pilot chunks, deleted with Rail's own ranges (analysis/41): none are solved on the GTO Wizard ranges yet.
  if (!PRESENT) {
    it.skip("waits for a flop library on the GTO Wizard ranges", () => {});
    return;
  }
  const c = chunk("btn-bb", "AsKh7d");

  it("keeps the flop's pot after check-check, and grows it by both bets after bet-call", () => {
    const xx = dealAfter(c, ["X", "X"]);
    expect(turnDeal(c, xx)).toEqual({ pot: c.header.pot, stack: c.header.stack });

    const root = exploreNode(c, 0);
    const bet = root.actions.find((a) => a.kind === "bet")!;
    const facing = exploreNode(c, bet.child);
    const call = facing.actions.find((a) => a.kind === "call")!;
    const deal = turnDeal(c, call.deal)!;
    expect(deal.pot).toBeCloseTo(c.header.pot + 2 * bet.amount, 6);
    expect(deal.stack).toBeCloseTo(c.header.stack - bet.amount, 6);
  });

  it("narrows both ranges as the flop did and takes the turn card's combos out", () => {
    const xx = dealAfter(c, ["X", "X"]);
    const card = c.result.nodes[xx].labels[0];
    const spot = liveTurnSpot(c, xx, card);
    expect(spot.board).toEqual([...c.result.board, card]);
    expect(spot.firstToAct).toBe(c.result.firstToAct);
    const reach = rangesAt(c.result, xx);
    for (let p = 0; p < 2; p += 1) {
      const range = spot.ranges[p] as Float64Array;
      expect(range.length).toBe(NUM_COMBOS);
      let kept = 0;
      let flop = 0;
      c.result.hands[p].forEach((_, i) => (flop += reach[p][i]));
      for (let k = 0; k < NUM_COMBOS; k += 1) kept += range[k];
      // The turn card's combos and pruned slivers are all that leave.
      expect(kept).toBeLessThanOrEqual(flop + 1e-9);
      expect(kept).toBeGreaterThan(flop * 0.85);
    }
  });

  it("refuses a card the deal does not deal", () => {
    const xx = dealAfter(c, ["X", "X"]);
    expect(() => liveTurnSpot(c, xx, "As")).toThrow(LiveTurnError);
  });

  it("solves to the target and reads like a full solve's turn file", () => {
    const xx = dealAfter(c, ["X", "X"]);
    const card = c.result.nodes[xx].labels.find((x) => x[0] === "2") ?? c.result.nodes[xx].labels[0];
    const seen: number[] = [];
    const started = performance.now();
    const result = solveLiveTurn(c, xx, card, (p) => seen.push(p.iteration));
    const seconds = (performance.now() - started) / 1000;
    console.log(`live turn btn-bb AsKh7d X-X ${card}: ${result.iterations} it, ${result.exploitabilityPct.toFixed(3)}% pot, ${seconds.toFixed(1)} s, ${result.nodes.length} nodes`);

    expect(result.street).toBe("turn");
    expect(result.exploitabilityPct).toBeLessThan(0.5 + 1e-9);
    expect(seen.length).toBeGreaterThan(0);
    const turn = { header: c.header, result };
    const root = exploreNode(turn, 0);
    expect(root.position).toBe(c.header.players[c.result.firstToAct]);
    expect(root.pot).toBeCloseTo(c.header.pot, 6);
    // Check-check on the turn deals a river, which leads to a river decision.
    const check = root.actions.find((a) => a.kind === "check")!;
    const behind = exploreNode(turn, check.child).actions.find((a) => a.kind === "check")!;
    expect(behind.deal).toBeGreaterThanOrEqual(0);
    const rivers = dealtCards(turn, behind.deal);
    expect(rivers.length).toBeGreaterThan(0);
    expect(rivers.every((r) => r.node >= 0 && turn.result.nodes[r.node].street === "river")).toBe(true);
  }, 120_000);
});
