/**
 * The flop realisation measurement (`analysis/15`,
 * `tests/scripts/flop-library/realisation.ts`) on the committed pilot: the
 * per-node equities are exact (against `equityVsRange` enumerating), every
 * measured combo falls in a category the committed table holds, and the
 * least-squares fit and the agreement measure do what they say on numbers
 * worked by hand. The table itself is measured on the full library by
 * `npm run floplib:realisation`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE, FLOP_REALISATION, flopRealisation } from "../../frontend/src/lib/analysis/index.js";
import { toIndices } from "../../frontend/src/lib/analysis/texture.js";
import { cardCode, equityVsRange } from "../../frontend/src/lib/equity/index.js";
import { comboHi, comboLo, decodeChunk, rangesAt } from "../../frontend/src/lib/solver/index.js";
import { agreement, approxGrade, chunkSamples, fitRealisation, nodeEquities, runouts, type Sample } from "../scripts/flop-library/realisation.js";

const DIR = join(import.meta.dirname, "../scripts/flop-library/pilot/nlhe-cash-6max-100bb", FLOP_PROFILE.tree);
const CHUNK = join(DIR, "btn-bb/Ts7h4d.bin");

describe.runIf(existsSync(CHUNK))("the flop realisation measurement", { timeout: 300_000 }, () => {
  const chunk = decodeChunk(readFileSync(CHUNK));

  it("measures exact equities against the node's range", () => {
    const result = chunk.result;
    const board = toIndices(result.board);
    const pre = runouts(board, result.hands);
    const index = result.nodes.findIndex((n) => n.kind === "action" && n.toCall > 0 && n.actions.some((a) => a.kind === "fold"));
    expect(index).toBeGreaterThan(0);
    const node = result.nodes[index];
    const p = node.player as 0 | 1;
    const reach = rangesAt(result, index);
    const equities = nodeEquities(pre, result.hands, p, reach[1 - p]);
    for (const i of [0, 37, 151]) {
      const combo = result.hands[p][i];
      const cards = [comboHi(combo), comboLo(combo)];
      const range = Array.from(result.hands[1 - p])
        .map((c, j) => ({ cards: [comboHi(c), comboLo(c)] as [number, number], weight: reach[1 - p][j] }))
        .filter((c) => c.weight > 0 && !c.cards.some((x) => cards.includes(x)));
      const exact = equityVsRange({ hero: cards.map((c) => cardCode(c)), range, board: result.board, method: "exhaustive" });
      expect(equities[i]).toBeCloseTo(exact.equity, 9);
    }
  });

  it("samples every node facing a bet in categories the committed table holds", () => {
    const samples = chunkSamples(chunk);
    expect(samples.length).toBeGreaterThan(500);
    for (const s of samples) {
      const [pos, made, draw] = s.key.split("|");
      expect(["ip", "oop"]).toContain(pos);
      const factor = flopRealisation(`${made}|${draw}`, pos === "ip");
      expect(factor).toBeGreaterThan(0);
      expect(s.w).toBeGreaterThan(0);
      expect(s.x).toBeGreaterThanOrEqual(0);
    }
    // Most of the weight reads its own row, not a fallback.
    const own = samples.filter((s) => FLOP_REALISATION[s.key] !== undefined).reduce((t, s) => t + s.w, 0);
    const all = samples.reduce((t, s) => t + s.w, 0);
    expect(own / all).toBeGreaterThan(0.95);
  });
});

describe("the realisation fit and its agreement measure", () => {
  const sample = (key: string, x: number, y: number, call: number, fold = 0): Sample => ({
    key,
    line: "btn-bb",
    train: true,
    w: 1,
    x,
    y,
    toCall: 0.3,
    fold: { f: call > fold ? 0 : 1, e: fold },
    call: { f: call > fold ? 1 : 0, e: call },
    raise: null,
  });

  it("fits R per key by weighted least squares", () => {
    const fit = fitRealisation([sample("ip|a|nd", 1, 2, 0), sample("ip|a|nd", 2, 4, 0), sample("oop|a|nd", 1, 0.5, 0)]);
    expect(fit.get("ip|a|nd")?.r).toBeCloseTo(2, 12);
    expect(fit.get("oop|a|nd")?.r).toBeCloseTo(0.5, 12);
    expect(fit.get("ip|a|nd")?.weight).toBe(2);
  });

  it("forgives the margin, and counts a false alarm only against the library's Perfect or Good", () => {
    expect(approxGrade(-0.04, "call", 0.05)).toBe("perfect");
    expect(approxGrade(-0.2, "call", 0.05)).toBe("mistake");
    expect(approxGrade(-0.2, "fold", 0.05)).toBe("perfect");
    // The library says calling wins 0.1 pots; the model says it loses 0.2.
    const s = sample("ip|a|nd", 0.1, 0.1, 0.1);
    const a = agreement([s], () => 1, 0.05);
    expect(a.sameVerdict).toBe(0);
    expect(a.evPot).toBeCloseTo(30, 9);
    expect(a.falseAlarm).toBeCloseTo(0.5, 9);
    // And folding, a Blunder by the library, is Perfect by the model: a miss.
    expect(a.miss).toBeCloseTo(0.5, 9);
  });
});
