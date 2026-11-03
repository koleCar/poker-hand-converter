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
  dealtCards,
  decodeChunk,
  ExploreError,
  exploreHistory,
  exploreNode,
  NUM_CLASSES,
  solveTurn,
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

describe("exploring a solve that deals a street (a full solve's turn file)", () => {
  // A small turn solve: its rivers are deals inside the result, as in `floplib:full`'s turn files.
  const result = solveTurn(
    {
      board: ["Qs", "Jh", "7s", "4h"],
      ranges: ["QQ,77,AQs,KQs,QJs,JTs,98s,A5s,65s,KJo", "KK,JJ,44,AQo,KJs,T9s,86s,AK,A4s"],
      pot: 10,
      stack: 30,
      menus: [
        { bet: [0.75], raise: [], allIn: true },
        { bet: [0.75], raise: [], allIn: true },
      ],
      raiseCap: 1,
    },
    { maxIterations: 20, targetExploitability: 0 },
  );
  const chunk = { header: { players: ["BB", "BTN"] }, result } as unknown as FlopChunk;

  it("points an action that ends the turn at the deal, and the deal at each river's first decision", () => {
    const checkBack = exploreNode(chunk, exploreNode(chunk, 0).actions.find((a) => a.kind === "check")!.child)
      .actions.find((a) => a.kind === "check")!;
    expect(checkBack.child).toBe(-1);
    expect(checkBack.ends).toBe("street");
    expect(result.nodes[checkBack.deal].kind).toBe("chance");
    const rivers = dealtCards(chunk, checkBack.deal);
    expect(rivers.length).toBeGreaterThan(0);
    for (const river of rivers) {
      expect(result.nodes[river.node].street).toBe("river");
      expect(river.card).not.toMatch(/^(Qs|Jh|7s|4h)$/);
    }
    expect(() => dealtCards(chunk, 0)).toThrow(ExploreError);
  });

  it("walks the history back over the river's deal, naming the card", () => {
    const deal = exploreNode(chunk, exploreNode(chunk, 0).actions.find((a) => a.kind === "check")!.child)
      .actions.find((a) => a.kind === "check")!.deal;
    const river = dealtCards(chunk, deal)[0];
    const history = exploreHistory(chunk, river.node);
    expect(history.map((s) => s.action.kind)).toEqual(["check", "check"]);
    expect(history[1].card).toBe(river.card);
    expect(history[0].card).toBeUndefined();
  });
});
