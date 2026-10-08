/**
 * Learn L2: the flop drills and the range split, on the flop library's
 * committed pilot (`tests/scripts/flop-library/pilot/`: btn-bb and
 * btn-bb-3bet on five flops) — the same chunks the analysis grades from.
 *
 * 1. **Flop spots** are deterministic in their seed, dealt only on the
 *    library's lines and flops (exact, never mapped), and graded by
 *    `analyzeHand` with the library (the trainer's one-grader rule): the
 *    analysis lands on the node the hero was dealt at, with the same menu,
 *    and the best option there grades Perfect.
 * 2. **The range split** reads the solved node by `flopBucket` category: its
 *    rows and mix are recomputed here from the chunk, and the grader accepts
 *    the solve's top group and refuses one it barely plays.
 * 3. **The worker's plumbing**: the chunk a job needs is named before it
 *    runs, and a job without the library finds no flop spot.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { flopBucket, FLOP_LINES, FLOP_PROFILE, FlopLibraryLoader, memoryLibrary } from "../../frontend/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { cardIndex } from "../../frontend/src/lib/equity/evaluator.js";
import { comboHi, comboLo, decodeChunk, flopKey, rangesAt, type FlopChunk, type FlopManifest } from "../../frontend/src/lib/solver/index.js";
import { analysisReadsLine, flopAnswer, flopChunkFor, generateFlopSpot, heroNode, libraryFlops } from "../../frontend/src/lib/training/flop.js";
import { gradeAnswer } from "../../frontend/src/lib/training/grade.js";
import { prepareFlopLibrary, runTrainingJob, trainingChunk } from "../../frontend/src/lib/training/jobs.js";
import { seeded } from "../../frontend/src/lib/training/rng.js";
import { generateSplit, gradeSplit, rightGroups, SPLIT_PASS, splitTable } from "../../frontend/src/lib/training/split.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
const DIR = join(import.meta.dirname, "../scripts/flop-library/pilot", CHARTS.id, FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));

function chunks(): FlopChunk[] {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest;
  return manifest.entries.map((e) => decodeChunk(readFileSync(join(DIR, e.path))));
}

const sameCharts = PRESENT && (JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest).charts.hash === CHARTS.model.hash;
const SEEDS = [11, 222, 3333, 44444, 555555, 6666666];

describe("the loader under concurrent jobs (L2)", () => {
  it("lets a second caller wait for a manifest still being fetched, instead of reading it as empty", async () => {
    let fetches = 0;
    const loader = new FlopLibraryLoader("mem:", async (url) => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const manifest = { entries: url.endsWith("manifest.json") ? [{ line: "btn-bb", flop: "Ts7h4d" }] : [] };
      return { ok: true, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    const [a, b] = await Promise.all([loader.ready(CHARTS.id), loader.ready(CHARTS.id)]);
    expect([a, b]).toEqual([true, true]);
    expect(loader.has(CHARTS.id, "btn-bb", "Ts7h4d")).toBe(true);
    expect(fetches).toBe(1);
  });
});

describe("which library lines the drills deal (L2)", () => {
  it("deals only lines a real hand reads the library on: every line, btn-sb included (placed fffrc, keyed fffrcf)", () => {
    for (const line of FLOP_LINES) expect(analysisReadsLine(CHARTS, line), line.id).toBe(true);
  });
});

describe.runIf(sameCharts)("flop spots from the library (L2)", () => {
  const library = memoryLibrary(chunks());

  it("deal only the library's lines and flops, deterministically", () => {
    expect(libraryFlops(library, CHARTS.id, "btn-bb").sort()).toEqual(["AsKh7d", "KhKs9d", "Ks6s3s", "Qs8s4h", "Ts7h4d"].sort());
    expect(libraryFlops(library, CHARTS.id, "co-bb")).toEqual([]);
    for (const seed of SEEDS) {
      const spot = generateFlopSpot(CHARTS, library, { pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed);
      expect(spot, String(seed)).not.toBeNull();
      if (!spot) continue;
      // The same spot (the parsed hand carries its parse time, so it is compared without it).
      const again = generateFlopSpot(CHARTS, library, { pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed);
      expect({ ...again, hand: null }).toEqual({ ...spot, hand: null });
      expect(spot.lineId).toBe("btn-bb");
      expect(spot.hero).toBe("BTN");
      expect(flopKey(spot.board)).toBe(spot.flop);
      expect(spot.path).toBe("X");
      expect(spot.menu.map((m) => m.kind)).toEqual(["check", "bet", "bet"]);
      // The hero's cards are not on the board.
      for (const card of spot.cards) expect(spot.board).not.toContain(card);
      // The chunk the worker loads first is the one dealt from.
      expect(flopChunkFor(CHARTS, library, { pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed)).toEqual({ set: CHARTS.id, line: "btn-bb", flop: spot.flop });
    }
  });

  it("are graded by the analysis on the same chunk, node and menu: exact, never mapped", () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const spot = generateFlopSpot(CHARTS, library, { pot: "srp", role: "caller", facing: "bet" }, seed);
      expect(spot, String(seed)).not.toBeNull();
      if (!spot) continue;
      expect(spot.toCallBb).toBeGreaterThan(0);
      expect(spot.menu.map((m) => m.kind)).toContain("fold");
      const graded = spot.menu.map((_, i) => {
        const answer = flopAnswer(spot, i);
        return gradeAnswer(answer.hand, answer.actionIndex, CHARTS, { flopLibrary: library });
      });
      for (const decision of graded) {
        expect(decision?.street).toBe("flop");
        expect(decision?.source).toBe("solver");
        expect(decision?.facts.flop).toMatchObject({ source: "library", mapped: false, flop: spot.flop, path: spot.path });
        expect(decision?.approximations).not.toContain("flop-mapped");
        expect(decision?.options.length).toBe(spot.menu.length);
      }
      // The option with the highest EV is never worse than Good, and some answer is Perfect.
      expect(graded.some((d) => d?.grade === "perfect")).toBe(true);
    }
  });

  it("deal 3-bet pots, check-raises and the out-of-position caller's first decision", () => {
    const threeBet = generateFlopSpot(CHARTS, library, { pot: "3bp", role: "pfr" }, 7);
    expect(threeBet?.lineId).toBe("btn-bb-3bet");
    expect(threeBet?.hero).toBe("BB");
    const raised = generateFlopSpot(CHARTS, library, { role: "pfr", facing: "raise" }, 8);
    expect(raised).not.toBeNull();
    expect(raised?.facing?.kind === "raise" || raised?.facing?.kind === "allin").toBe(true);
    expect(raised?.script.flop?.some((a) => a.position === raised.hero && a.type === "bet")).toBe(true);
    const lead = generateFlopSpot(CHARTS, library, { line: "btn-bb", seat: "oop" }, 9);
    expect(lead?.path).toBe("");
    expect(lead?.hero).toBe("BB");
    // A filter the library cannot serve: no spot, never a mapped one.
    expect(generateFlopSpot(CHARTS, library, { pot: "limped" }, 10)).toBeNull();
  });

  it("run through the worker's job, which names its chunk first", async () => {
    const request = { type: "flop" as const, jobId: 1, options: { pot: "srp" as const, role: "pfr" as const, seat: "ip" as const, facing: "check" as const }, seed: 99 };
    const want = trainingChunk(request, CHARTS, library);
    expect(want?.line).toBe("btn-bb");
    const loaded: string[] = [];
    const loader = {
      ...library,
      ready: async () => true,
      load: async (set: string, line: string, flop: string) => {
        loaded.push(`${set}/${line}/${flop}`);
        return library.get(set, line, flop);
      },
    };
    const prepared = await prepareFlopLibrary(request, CHARTS, loader);
    expect(loaded).toEqual([`${want?.set}/${want?.line}/${want?.flop}`]);
    const response = runTrainingJob(request, CHARTS, prepared);
    expect(response.type === "spot" && response.spot?.kind).toBe("flop");
    // Without a library the job finds nothing; it never falls back to a guess.
    const none = runTrainingJob(request, CHARTS, null);
    expect(none.type === "spot" && none.spot).toBeNull();
    if (response.type !== "spot" || !response.spot) return;
    const graded = runTrainingJob({ type: "answer", jobId: 2, spot: response.spot, menuIndex: 0 }, CHARTS, prepared);
    expect(graded.type === "graded" && graded.decision?.source).toBe("solver");
  });
});

describe.runIf(sameCharts)("the range split (L2)", () => {
  const all = chunks();
  const library = memoryLibrary(all);

  it("is deterministic and reads the solved node by flopBucket category", () => {
    for (const seed of SEEDS) {
      const item = generateSplit(CHARTS, library, { street: "flop", pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed);
      expect(item, String(seed)).not.toBeNull();
      if (!item) continue;
      expect(generateSplit(CHARTS, library, { street: "flop", pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed)).toEqual(item);
      expect(item.groups).toEqual(["check", "small", "big"]);
      expect(item.rows.length).toBeGreaterThanOrEqual(3);
      expect(item.rows.length).toBeLessThanOrEqual(8);
      for (const row of item.rows) {
        expect(row.freq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
        expect(row.share).toBeGreaterThanOrEqual(0.03);
      }
      expect(item.overall.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
      // Recomputed from the chunk: the in-position node after a check, by category.
      const chunk = all.find((c) => c.header.line === "btn-bb" && flopKey(item.board) === c.header.flop)!;
      const node = chunk.result.nodes.findIndex((n) => n.path === "X");
      const reach = rangesAt(chunk.result, node)[1];
      const at = chunk.result.nodes[node];
      const n = chunk.result.hands[1].length;
      const board = chunk.result.board.map(cardIndex);
      for (const row of item.rows) {
        let w = 0;
        let check = 0;
        for (let i = 0; i < n; i += 1) {
          const combo = chunk.result.hands[1][i];
          if (!(reach[i] > 0) || flopBucket([comboHi(combo), comboLo(combo)], board) !== row.key) continue;
          w += reach[i];
          check += reach[i] * at.strategy[i];
        }
        expect(row.combos).toBeCloseTo(w, 1);
        expect(row.freq[0]).toBeCloseTo(check / w, 3);
      }
    }
  });

  it("grades a class right at the solve's top group and wrong where the solve barely goes", () => {
    const item = generateSplit(CHARTS, library, { street: "flop", pot: "srp", role: "pfr", seat: "ip", facing: "check" }, 12345)!;
    const best = item.rows.map((row) => row.freq.indexOf(Math.max(...row.freq)));
    expect(gradeSplit(item, best)).toMatchObject({ correct: item.rows.length, passed: true });
    for (const [r, row] of item.rows.entries()) expect(rightGroups(row)).toContain(best[r]);
    const worst = item.rows.map((row) => row.freq.indexOf(Math.min(...row.freq)));
    const graded = gradeSplit(item, worst);
    for (const [r, row] of item.rows.entries()) {
      const top = Math.max(...row.freq);
      expect(graded.right[r]).toBe(row.freq[worst[r]] >= top - 0.15);
    }
    // Unanswered rows are wrong; the item needs SPLIT_PASS of its rows.
    expect(gradeSplit(item, []).correct).toBe(0);
    const some = best.map((g, r) => (r < Math.ceil(SPLIT_PASS * item.rows.length) ? g : -1));
    expect(gradeSplit(item, some).passed).toBe(true);
  });

  it("splits fold / call / raise facing a bet, and splits on the 3-bet pot's flops", () => {
    const facing = generateSplit(CHARTS, library, { street: "flop", pot: "srp", role: "caller", seat: "oop", facing: "bet" }, 5);
    expect(facing?.groups).toEqual(["fold", "call", "raise"]);
    expect(facing?.toCallBb).toBeGreaterThan(0);
    expect(facing?.before.map((b) => b.who)).toEqual(["hero", "villain"]);
    const threeBet = generateSplit(CHARTS, library, { street: "flop", pot: "3bp", seat: "ip", facing: "check" }, 6);
    expect(threeBet?.lineId).toBe("btn-bb-3bet");
    expect(threeBet?.groups[0]).toBe("check");
    // No library, no flop split.
    expect(generateSplit(CHARTS, null, { street: "flop", pot: "srp" }, 1)).toBeNull();
  });

  it("walks the tree the way the drills deal: a raise is reached only through the hero's own bet", () => {
    const chunk = all.find((c) => c.header.line === "btn-bb" && c.header.flop === "Ts7h4d")!;
    const rng = seeded(4);
    const walked = heroNode(chunk.result, 1, "raise", rng);
    expect(walked?.steps.map((s) => s.player)).toEqual([0, 1, 0]);
    expect(chunk.result.nodes[walked!.node].toCall).toBeGreaterThan(0);
  });

  it("table: every group of the node, in a fixed order", () => {
    const chunk = all.find((c) => c.header.line === "btn-bb" && c.header.flop === "AsKh7d")!;
    const table = splitTable(chunk.result, 0, "flop", chunk.result.board.map(cardIndex));
    // The big blind first: check, or lead small or big.
    expect(table.groups).toEqual(["check", "small", "big"]);
  });
});

describe("the range split on the turn (L2, a turn solve)", () => {
  it("splits a turn by the turn study's categories, graded the same way", () => {
    const item = generateSplit(CHARTS, null, { street: "turn", pot: "srp", role: "caller", seat: "oop", facing: "bet" }, 31);
    expect(item).not.toBeNull();
    if (!item) return;
    expect(item.source).toBe("turn-solve");
    expect(item.board).toHaveLength(4);
    expect(item.groups).toEqual(["fold", "call", "raise"]);
    for (const row of item.rows) expect(row.key).not.toContain("/");
    const best = item.rows.map((row) => row.freq.indexOf(Math.max(...row.freq)));
    expect(gradeSplit(item, best).passed).toBe(true);
  }, 60_000);
});
