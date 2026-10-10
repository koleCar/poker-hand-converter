/**
 * The turn realisation measurement (`analysis/16`,
 * `tests/scripts/flop-library/turnRealisation.ts`) on a committed pilot
 * chunk: the corpus's turns are the flop's own endings with the solve's
 * ranges, fixed run to run; the per-node equities over the river are exact
 * (against `equityVsRange` enumerating); a call that puts the caller all-in
 * realises its equity exactly (R = 1), which is why the measurement leaves
 * those out; every sample falls in a category of the table; the shard files
 * round-trip. The table itself is measured by `npm run floplib:turn-realisation`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE, turnRealisation } from "../../frontend/src/lib/analysis/index.js";
import { toIndices } from "../../frontend/src/lib/analysis/texture.js";
import { cardCode, equityVsRange } from "../../frontend/src/lib/equity/index.js";
import { comboHi, comboLo, decodeChunk, NUM_COMBOS, rangesAt } from "../../frontend/src/lib/solver/index.js";
import { nodeEquities, runouts } from "../scripts/flop-library/realisation.js";
import {
  libraryTurns,
  MIN_LINE_REACH,
  packSamples,
  SAMPLE_KEYS,
  solveLibraryTurn,
  turnSamples,
  unpackSamples,
} from "../scripts/flop-library/turnRealisation.js";

const CHUNK = join(import.meta.dirname, "../scripts/flop-library/pilot/nlhe-cash-6max-100bb", FLOP_PROFILE.tree, "btn-bb/Ts7h4d.bin");

describe.runIf(existsSync(CHUNK))("the turn realisation measurement", { timeout: 300_000 }, () => {
  const chunk = decodeChunk(readFileSync(CHUNK));
  const turns = libraryTurns(chunk, "nlhe-cash-6max-100bb");
  // The smallest tree: a flop raise called, the least behind.
  const spot = [...turns].sort((a, b) => a.stack / a.pot - b.stack / b.pot)[0];
  const result = solveLibraryTurn(spot);

  it("deals each flop ending both ranges reach a fixed turn, with the solve's ranges and the pot as it stands", () => {
    expect(turns.length).toBeGreaterThanOrEqual(3);
    expect(libraryTurns(chunk, "nlhe-cash-6max-100bb").map((t) => t.turn)).toEqual(turns.map((t) => t.turn));
    expect(turns.some((t) => t.path === "X-X")).toBe(true);
    for (const t of turns) {
      expect(new Set(t.board).size).toBe(4);
      expect(t.pot).toBeGreaterThanOrEqual(chunk.header.pot);
      expect(t.pot + 2 * t.stack).toBeCloseTo(chunk.header.pot + 2 * chunk.header.stack, 6);
      const index = chunk.result.nodes.findIndex((n) => n.path === t.path);
      const reach = rangesAt(chunk.result, index);
      for (const p of [0, 1] as const) {
        let total = 0;
        let kept = 0;
        chunk.result.hands[p].forEach((c, i) => {
          total += reach[p][i];
          if (comboHi(c) !== t.turn && comboLo(c) !== t.turn) {
            kept += reach[p][i];
            expect(t.ranges[p][c]).toBeCloseTo(reach[p][i], 12);
          }
        });
        expect(kept).toBeGreaterThan(0);
        const start = chunk.result.weights[p].reduce((s, v) => s + v, 0);
        expect(total / start).toBeGreaterThanOrEqual(MIN_LINE_REACH);
        for (let c = 0; c < NUM_COMBOS; c += 1) if (comboHi(c) === t.turn || comboLo(c) === t.turn) expect(t.ranges[p][c]).toBe(0);
      }
    }
  });

  it("measures exact equities over the river against the node's range", () => {
    const board = toIndices(result.board);
    const pre = runouts(board, result.hands, 1);
    expect(pre.count).toBe(48);
    const index = result.nodes.findIndex((n) => n.kind === "action" && n.street === "turn" && n.toCall > 0);
    expect(index).toBeGreaterThan(0);
    const node = result.nodes[index];
    const p = node.player as 0 | 1;
    const reach = rangesAt(result, index);
    const equities = nodeEquities(pre, result.hands, p, reach[1 - p]);
    for (const i of [0, 23, 101]) {
      const combo = result.hands[p][i];
      const cards = [comboHi(combo), comboLo(combo)];
      const range = Array.from(result.hands[1 - p])
        .map((c, j) => ({ cards: [comboHi(c), comboLo(c)] as [number, number], weight: reach[1 - p][j] }))
        .filter((c) => c.weight > 0 && !c.cards.some((x) => cards.includes(x)));
      const exact = equityVsRange({ hero: cards.map((c) => cardCode(c)), range, board: result.board, method: "exhaustive" });
      expect(equities[i]).toBeCloseTo(exact.equity, 9);
    }
  });

  it("finds an all-in call realising its equity exactly, and leaves those nodes out", () => {
    const board = toIndices(result.board);
    const pre = runouts(board, result.hands, 1);
    const allIns = result.nodes
      .map((n, index) => ({ n, index }))
      .filter(({ n }) => n.kind === "action" && n.street === "turn" && n.toCall > 0 && n.toCall >= n.behind - 1e-9);
    expect(allIns.length).toBeGreaterThan(0);
    for (const { n, index } of allIns) {
      const p = n.player as 0 | 1;
      const reach = rangesAt(result, index);
      const equities = nodeEquities(pre, result.hands, p, reach[1 - p]);
      const call = n.actions.findIndex((a) => a.kind === "call");
      const fold = n.actions.findIndex((a) => a.kind === "fold");
      const size = result.hands[p].length;
      const after = n.pot + n.toCall;
      const raked = after - Math.min(after * spot.rake.percent, spot.rake.cap);
      for (let i = 0; i < size; i += 7) {
        if (!(reach[p][i] > 0)) continue;
        const y = n.ev[call * size + i] - n.ev[fold * size + i] + n.toCall;
        expect(y).toBeCloseTo(equities[i] * raked, 2);
      }
    }
    const samples = turnSamples(result, spot);
    expect(samples.length).toBeGreaterThan(100);
    for (const s of samples) {
      expect(SAMPLE_KEYS).toContain(s.key);
      expect(s.w).toBeGreaterThan(0);
      expect(s.x).toBeGreaterThanOrEqual(0);
      const [pos, made, draw] = s.key.split("|");
      expect(turnRealisation(`${made}|${draw}`, pos === "ip")).toBeGreaterThan(0);
    }
  });

  it("round-trips samples through a shard file", () => {
    const samples = turnSamples(result, spot).slice(0, 50);
    const back = unpackSamples(packSamples(samples));
    expect(back.length).toBe(samples.length);
    back.forEach((s, j) => {
      const o = samples[j];
      expect([s.key, s.line, s.train]).toEqual([o.key, o.line, o.train]);
      for (const f of ["w", "x", "y", "toCall"] as const) expect(s[f]).toBeCloseTo(o[f], 5);
      expect(s.call.e).toBeCloseTo(o.call.e, 5);
      expect(s.raise === null).toBe(o.raise === null);
    });
  });
});
