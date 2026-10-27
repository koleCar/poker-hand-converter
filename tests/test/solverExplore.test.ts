/**
 * Browsing a flop library chunk (`web/src/lib/solver/explore.ts`, the Solver
 * library tab) on the committed pilot: every decision of a chunk is reached
 * from the root through the actions' children, the class view adds up to the
 * solve's own numbers (reach, the range's frequencies, the combos), and the
 * history walks back to the root.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE } from "../../web/src/lib/analysis/index.js";
import {
  classCombos,
  decodeChunk,
  ExploreError,
  exploreHistory,
  exploreNode,
  NUM_CLASSES,
  type FlopChunk,
  type FlopManifest,
} from "../../web/src/lib/solver/index.js";

const DIR = join(import.meta.dirname, "../scripts/flop-library/pilot/nlhe-cash-6max-100bb", FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));

function chunks(): FlopChunk[] {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest;
  return manifest.entries.map((e) => decodeChunk(readFileSync(join(DIR, e.path))));
}

/** Every decision reached from the root through the actions' children. */
function walk(chunk: FlopChunk): number[] {
  const seen: number[] = [];
  const next = [0];
  while (next.length > 0) {
    const index = next.pop()!;
    seen.push(index);
    for (const action of exploreNode(chunk, index).actions) if (action.child >= 0) next.push(action.child);
  }
  return seen.sort((a, b) => a - b);
}

describe.runIf(PRESENT)("exploring the pilot's chunks", () => {
  it("reaches every flop decision from the root, and nothing else", () => {
    for (const chunk of chunks()) {
      const decisions = chunk.result.nodes.flatMap((node, i) => (node.kind === "action" && node.street === "flop" ? [i] : []));
      expect(walk(chunk)).toEqual(decisions);
    }
  });

  it("adds the classes up to the solve: combos, reach, the range's frequencies", () => {
    for (const chunk of chunks()) {
      for (const index of walk(chunk)) {
        const view = exploreNode(chunk, index);
        const node = chunk.result.nodes[index];
        expect(view.position).toBe(chunk.header.players[node.player]);
        expect(view.classes).toHaveLength(NUM_CLASSES);
        expect(view.classes.reduce((sum, c) => sum + c.combos, 0)).toBe(chunk.result.hands[node.player].length);
        expect(view.classes.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(view.reach, 6);
        // The stored frequencies were taken before the strategies were cut to 16 bits.
        view.totals.forEach((total, a) => expect(total.share).toBeCloseTo(node.frequency[a], 3));
        expect(view.totals.reduce((sum, t) => sum + t.share, 0)).toBeCloseTo(1, 6);
        for (const c of view.classes) {
          if (c.combos === 0) continue;
          expect(c.freq.reduce((sum, f) => sum + f, 0)).toBeCloseTo(1, 4);
          expect(c.value).toBeCloseTo(c.freq.reduce((sum, f, a) => sum + f * c.ev[a], 0), 9);
        }
        for (const action of view.actions) {
          if (action.child >= 0) expect(chunk.result.nodes[action.child].kind).toBe("action");
          else expect(action.ends).toBe(action.kind === "fold" ? "fold" : "street");
        }
      }
    }
  });

  it("lists a class's combos with the class's own reach", () => {
    const chunk = chunks()[0];
    const view = exploreNode(chunk, 0);
    const reached = view.classes.filter((c) => c.weight > 0);
    expect(reached.length).toBeGreaterThan(10);
    for (const c of reached) {
      const combos = classCombos(chunk, 0, c.index);
      expect(combos).toHaveLength(c.combos);
      expect(combos.reduce((sum, x) => sum + x.weight, 0)).toBeCloseTo(c.weight, 6);
      for (const x of combos) {
        expect(x.cards).toMatch(/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/);
        expect(chunk.result.board.some((card) => x.cards.includes(card))).toBe(false);
      }
    }
  });

  it("walks the history back to the root", () => {
    for (const chunk of chunks()) {
      expect(exploreHistory(chunk, 0)).toEqual([]);
      for (const index of walk(chunk)) {
        const history = exploreHistory(chunk, index);
        let at = 0;
        for (const step of history) {
          expect(step.node).toBe(at);
          at = step.action.child;
        }
        expect(at).toBe(index);
      }
    }
  });

  it("refuses a node that is not a decision", () => {
    const chunk = chunks()[0];
    const chance = chunk.result.nodes.findIndex((node) => node.kind === "chance");
    expect(chance).toBeGreaterThan(0);
    expect(() => exploreNode(chunk, chance)).toThrow(ExploreError);
    expect(() => exploreNode(chunk, chunk.result.nodes.length)).toThrow(ExploreError);
  });
});
