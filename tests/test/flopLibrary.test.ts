/**
 * The flop library (phase A5b): the representative flops and the mapping,
 * the chunk format and its loader, and the analysis reading it - behind
 * `FLOP_LIBRARY_ENABLED`, which is off, so every test hands the analysis a
 * library explicitly.
 *
 * The chunk the analysis reads here is solved in the test, on the 3-bet pot
 * the pilot solves (BTN opens, BB 3-bets, BTN calls), with the charts' real
 * ranges and a small tree (flop bets only, turn and river checked down) so
 * it takes seconds. The pilot's own chunks, when present, are checked by
 * `tests/scripts/flop-library` (`pilot.test.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  analyzeHand,
  flopBucket,
  FLOP_LIBRARY_ENABLED,
  FLOP_LINES,
  FLOP_PROFILE,
  FlopLibraryLoader,
  libraryEntry,
  libraryModel,
  memoryLibrary,
  walkRanges,
  type FlopEntry,
  type FlopProfile,
} from "../../frontend/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import { cardCode, cardIndex } from "../../frontend/src/lib/equity/evaluator.js";
import {
  canonicalFlops,
  chunkHeader,
  chunkPath,
  computeRepresentatives,
  decodeChunk,
  encodeChunk,
  FLOP_CLASSES,
  FLOP_REPRESENTATIVES,
  FlopChunkFormatError,
  flopDistance,
  flopFeatures,
  flopKey,
  mapFlop,
  comboHi,
  comboLo,
  parseCombo,
  rangesAt,
  representativeCoverage,
  straightPairs,
  type FlopChunk,
} from "../../frontend/src/lib/solver/index.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
import { scriptHand, seatOf, type HandScript, type ScriptAct } from "../../frontend/src/lib/training/handText.js";
import { lineActs } from "../../frontend/src/lib/training/preflop.js";
import { jobHeader, solveJob, type Job } from "../scripts/flop-library/job.js";
import { lineSpot } from "../scripts/flop-library/spots.js";
import { fullLibrary } from "./charts/support.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

/* ------------------------------------------------------------ the set - */

describe("representative flops", () => {
  it("covers the 1,755 canonical flops and all 22,100 flops", () => {
    const flops = canonicalFlops();
    expect(flops).toHaveLength(1755);
    expect(flops.reduce((s, f) => s + f.weight, 0)).toBe(22100);
    expect(FLOP_REPRESENTATIVES).toHaveLength(100);
    const coverage = representativeCoverage();
    let flopsCovered = 0;
    for (const entry of coverage.values()) flopsCovered += entry.flops;
    expect(flopsCovered).toBe(22100);
    // Every texture class has representatives.
    const classes = new Set(FLOP_REPRESENTATIVES.map((key) => flopFeatures(key.match(/../g) as string[]).cls));
    expect([...classes].sort()).toEqual([...FLOP_CLASSES].sort());
  });

  it("are what the selection computes (the committed list cannot drift)", () => {
    expect(computeRepresentatives()).toEqual(FLOP_REPRESENTATIVES);
  });

  it("maps a representative to itself, any flop within its texture class, and suits away", () => {
    for (const key of FLOP_REPRESENTATIVES) {
      expect(mapFlop(key.match(/../g) as string[])).toMatchObject({ representative: key, exact: true, distance: 0 });
    }
    for (const flop of canonicalFlops()) {
      const mapped = mapFlop(flop.board);
      expect(flopFeatures(mapped.representative.match(/../g) as string[]).cls).toBe(flop.features.cls);
    }
    // The same flop in other suits maps the same way.
    expect(mapFlop(["Th", "8d", "4c"])).toEqual(mapFlop(["Ts", "8h", "4d"]));
    expect(mapFlop(["Ts", "8h", "4d"])).toMatchObject({ representative: "Ts7h4d", exact: false, distance: 1 });
    // Which two ranks share a suit is part of the texture.
    expect(flopFeatures(["As", "Ks", "5h"]).cls).toBe("u-s12");
    expect(flopFeatures(["As", "Kh", "5s"]).cls).toBe("u-s13");
    expect(flopFeatures(["Ks", "Kh", "5s"]).cls).toBe("p-s");
  });

  it("measures texture: straight potential, and a metric within a class", () => {
    expect(straightPairs([11, 5, 0])).toBe(0); // K72
    expect(straightPairs([7, 6, 5])).toBeGreaterThan(straightPairs([7, 6, 0])); // 987 vs 982
    expect(straightPairs([12, 1, 0])).toBeGreaterThan(0); // A32: the wheel
    const a = flopFeatures(["Ks", "7h", "2d"]);
    const b = flopFeatures(["Qs", "7h", "2d"]);
    expect(flopDistance(a, b)).toBeCloseTo(1.5, 9);
    expect(flopDistance(a, b)).toBe(flopDistance(b, a));
    expect(flopDistance(a, flopFeatures(["Ks", "7s", "2d"]))).toBe(Infinity);
  });
});

describe("hand categories", () => {
  const board = ["Ks", "7h", "2d"].map(cardIndex);
  const cat = (a: string, b: string) => flopBucket([cardIndex(a), cardIndex(b)], board);
  it("names the made hand and the draw, suit-blind", () => {
    expect(cat("Ah", "Kd")).toBe("tp-top/none");
    expect(cat("Kh", "9c")).toMatch(/^tp-weak\//);
    expect(cat("7s", "7d")).toBe("set/none");
    expect(cat("Ac", "Ad")).toBe("overpair/none");
    expect(cat("6h", "5h")).toMatch(/^nothing\/(oesd|gut|bd)$/);
    expect(cat("As", "Qs")).toBe("ace-high/bd");
    // Relabelled suits, same category.
    const board2 = ["Kh", "7d", "2c"].map(cardIndex);
    expect(flopBucket([cardIndex("Ad"), cardIndex("Kc")], board2)).toBe(cat("Ah", "Kd"));
  });
});

/* ------------------------------------------------------------ the chunk - */

/** A small tree: two flop bets, no raise, turn and river checked down. Seconds instead of minutes. */
const SMALL: FlopProfile = {
  ...FLOP_PROFILE,
  tree: "flop-test",
  flopMenu: { bet: [0.33, 0.75], raise: [], allIn: false },
  flopRaiseCap: 0,
  turnMenu: { bet: [], raise: [], allIn: false },
  riverMenu: { bet: [], raise: [], allIn: false },
  targetPct: 2,
  maxIterations: 40,
  checkFrom: 40,
  checkEvery: 40,
};

const LINE = FLOP_LINES.find((l) => l.id === "btn-bb-3bet")!;
const FLOP = "Ts7h4d";

function jobOf(flop: string): Job {
  const spot = lineSpot(CHARTS, LINE);
  return {
    id: `${LINE.id}/${flop}`,
    line: LINE.id,
    lineKey: LINE.key,
    flop,
    players: spot.players,
    ranges: [Array.from(spot.ranges[0]), Array.from(spot.ranges[1])],
    pot: spot.pot,
    stack: spot.stack,
    charts: { id: CHARTS.id, version: CHARTS.version, hash: CHARTS.model.hash },
    rake: { name: "test", percent: 0.05, cap: 3 },
    profile: SMALL,
  };
}

let bytes: Uint8Array;
let chunk: FlopChunk;

beforeAll(() => {
  bytes = solveJob(jobOf(FLOP)).bytes;
  chunk = decodeChunk(bytes);
}, 120_000);

describe("the chunk format", () => {
  it("round-trips a flop solve with its header", () => {
    expect(chunk.header).toEqual(jobHeader(jobOf(FLOP)));
    expect(chunkHeader(bytes)).toEqual(chunk.header);
    expect(chunk.result.street).toBe("flop");
    expect(chunk.result.board).toEqual(["Ts", "7h", "4d"]);
    // Flop decisions and the turn deals below them; the root has three options.
    const root = chunk.result.nodes[0];
    expect(root.actions.map((a) => a.kind)).toEqual(["check", "bet", "bet"]);
    expect(chunk.result.nodes.some((n) => n.kind === "chance" && n.children.every((c) => c === -1))).toBe(true);
    // Strategies sum to one per hand.
    const n = chunk.result.hands[0].length;
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let a = 0; a < 3; a += 1) sum += root.strategy[a * n + i];
      expect(sum).toBeCloseTo(1, 6);
    }
    expect(chunkPath(CHARTS.id, SMALL.tree, LINE.id, FLOP)).toBe(`${CHARTS.id}/flop-test/btn-bb-3bet/Ts7h4d.bin`);
  });

  it("is deterministic: the same job gives the same bytes", () => {
    // (A few iterations: the bits either repeat or they do not.)
    const short = { ...jobOf(FLOP), profile: { ...SMALL, maxIterations: 6, checkFrom: 6, checkEvery: 6 } };
    expect(Buffer.from(solveJob(short).bytes).equals(Buffer.from(solveJob(short).bytes))).toBe(true);
    // Re-encoding the decoded chunk keeps it: strategies to 16 bits (renormalised on decode), EVs exactly.
    const again = decodeChunk(encodeChunk(chunk.header, chunk.result));
    chunk.result.nodes.forEach((node, k) => {
      const other = again.result.nodes[k];
      expect(Array.from(other.ev)).toEqual(Array.from(node.ev));
      for (let j = 0; j < node.strategy.length; j += 1) expect(Math.abs(other.strategy[j] - node.strategy[j])).toBeLessThan(1e-4);
    });
  });

  it("refuses what it does not read", () => {
    expect(() => decodeChunk(new Uint8Array(16))).toThrow(FlopChunkFormatError);
    const other = Uint8Array.from(bytes);
    // Patch the header's version string in place ("floplib/1" -> "floplib/9").
    const text = Buffer.from(other).toString("latin1");
    other[text.indexOf("floplib/1") + 8] = "9".charCodeAt(0);
    expect(() => decodeChunk(other)).toThrow(/floplib\/9/);
  });

  it("is loaded on demand by the loader, from a manifest", async () => {
    const base = "https://example.test/floplib";
    const files = new Map<string, Uint8Array | unknown>([
      [`${base}/${CHARTS.id}/flop-test/manifest.json`, { entries: [{ line: LINE.id, flop: FLOP }] }],
      [`${base}/${chunkPath(CHARTS.id, "flop-test", LINE.id, FLOP)}`, bytes],
    ]);
    const fetched: string[] = [];
    const loader = new FlopLibraryLoader(
      base,
      async (url) => {
        fetched.push(url);
        const body = files.get(url);
        return {
          ok: body !== undefined,
          arrayBuffer: async () => {
            const b = body as Uint8Array;
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          },
          json: async () => body,
        };
      },
      "flop-test",
    );
    const hand = handOn(["Th", "7d", "4c"], [{ position: "BB", type: "check" }]);
    expect(loader.get(CHARTS.id, LINE.id, FLOP)).toBeNull();
    await loader.prefetch(hand, CHARTS);
    expect(loader.has(CHARTS.id, LINE.id, FLOP)).toBe(true);
    expect(loader.get(CHARTS.id, LINE.id, FLOP)?.header).toEqual(chunk.header);
    // A second hand on the same chunk fetches nothing new.
    await loader.prefetch(hand, CHARTS);
    expect(fetched).toHaveLength(2);
    // A hand on a line the library has not solved fetches no chunk.
    await loader.prefetch(handOn(["Th", "7d", "4c"], [{ position: "BB", type: "check" }], "fffrfc"), CHARTS);
    expect(fetched).toHaveLength(2);
  });
});

/* ------------------------------------------------------- the analysis - */

/** A hand on the 3-bet line (or `key`), the hero on the button, up to the given flop actions. */
/** The hero's hand: the button's heaviest combo in the chunk, a hand the line surely holds. */
function heroCards(): [string, string] {
  const weights = chunk.result.weights[1];
  let best = 0;
  for (let i = 1; i < weights.length; i += 1) if (weights[i] > weights[best]) best = i;
  const combo = chunk.result.hands[1][best];
  return [cardCode(comboHi(combo)), cardCode(comboLo(combo))];
}

/** Suits relabelled s -> h, h -> d, d -> c, c -> s. */
const RELABEL = (code: string) => code[0] + "hdcs"["shdc".indexOf(code[1])];

function handOn(board: string[], flop: ScriptAct[], key = LINE.key, cards: [string, string] = heroCards()) {
  const script: HandScript = {
    id: "FLTEST",
    hero: "BTN",
    heroCards: cards,
    stackBb: CHARTS.game.stackBb,
    preflop: lineActs(CHARTS, key),
    board,
    flop,
  };
  return scriptHand(script);
}


/**
 * The line to the hero's decision: the big blind leads with the size the
 * chunk leads with most (the small test tree has no turn or river betting,
 * so the 3-bettor leads nearly always), and the hero on the button decides.
 */
function lead(): { to: number; path: string } {
  const root = chunk.result.nodes[0];
  const n = chunk.result.hands[0].length;
  let best = -1;
  root.actions.forEach((action, a) => {
    if (action.kind === "bet" && (best < 0 || root.frequency[a] > root.frequency[best])) best = a;
  });
  void n;
  return { to: root.actions[best].to, path: root.labels[best] };
}
const LEAD = (): ScriptAct => ({ position: "BB", type: "bet", to: lead().to });
const CALL: ScriptAct = { position: "BTN", type: "call" };

function flopDecision(hand: ReturnType<typeof handOn>, library: FlopChunk[] | null) {
  const analysis = analyzeHand(hand, { charts: CHARTS, turn: false, flopLibrary: library ? memoryLibrary(library) : null });
  return analysis.decisions.find((d) => d.street === "flop");
}

describe("the analysis reading the library", () => {
  it("is off by default", () => {
    expect(FLOP_LIBRARY_ENABLED).toBe(false);
    const decision = flopDecision(handOn(["Ts", "7h", "4d"], [LEAD(), CALL]), null);
    expect(decision?.source).toBe("heuristic");
    expect(decision?.facts.flop ?? null).toBeNull();
  });

  it("grades a flop decision on a solved flop from the library, combo for combo", () => {
    const decision = flopDecision(handOn(["Ts", "7h", "4d"], [LEAD(), CALL]), [chunk]);
    expect(decision?.source).toBe("solver");
    expect(decision?.status).toBe("analysed");
    expect(decision?.options.map((o) => o.action)).toEqual(["fold", "call"]);
    expect(decision?.facts.flop).toMatchObject({ source: "library", line: "btn-bb-3bet", flop: FLOP, mapped: false, path: lead().path, bucket: null });
    expect(decision?.approximations).toEqual(expect.arrayContaining(["coarse-river", "rake-profile"]));
    for (const code of ["flop-mapped", "library-bucketed", "narrowing-heuristic"] as const) expect(decision?.approximations).not.toContain(code);
    const freq = decision!.options.reduce((s, o) => s + o.freq, 0);
    expect(freq).toBeCloseTo(1, 3);
    // The options are the chunk's numbers for this combo (EV scaled by the real pot over the solved one: 1 here).
    const node = chunk.result.nodes[chunk.result.nodes.findIndex((n) => n.path === lead().path)];
    const n = chunk.result.hands[1].length;
    const i = chunk.result.hands[1].indexOf(parseCombo(heroCards().join("")));
    expect(i).toBeGreaterThanOrEqual(0);
    decision!.options.forEach((option, a) => {
      expect(option.freq).toBeCloseTo(node.strategy[a * n + i], 3);
      expect(option.ev).toBeCloseTo(node.ev[a * n + i], 2);
    });
  });

  it("reads the same flop in other suits through the relabelling", () => {
    const a = flopDecision(handOn(["Ts", "7h", "4d"], [LEAD(), CALL]), [chunk]);
    // s -> h, h -> d, d -> c, c -> s.
    const b = flopDecision(handOn(["Ts", "7h", "4d"].map(RELABEL), [LEAD(), CALL], LINE.key, heroCards().map(RELABEL) as [string, string]), [chunk]);
    expect(b?.source).toBe("solver");
    expect(b?.facts.flop?.mapped).toBe(false);
    expect(b?.options).toEqual(a?.options);
    expect(b?.grade).toBe(a?.grade);
  });

  it("reads a flop it has not solved from its representative, by hand category", () => {
    const decision = flopDecision(handOn(["Ts", "8h", "4d"], [LEAD(), CALL]), [chunk]);
    expect(decision?.source).toBe("solver");
    expect(decision?.facts.flop).toMatchObject({ mapped: true, flop: FLOP, distance: 1 });
    expect(decision?.facts.flop?.bucket).toMatch(/\//);
    expect(decision?.approximations).toEqual(expect.arrayContaining(["flop-mapped", "library-bucketed"]));
  });

  it("falls back to the heuristic where the library has nothing to say", () => {
    // Another line (a single-raised pot): no chunk.
    const srp = handOn(["Ts", "7h", "4d"], [{ position: "BB", type: "bet", to: 1.82 }, CALL], "fffrfc");
    expect(flopDecision(srp, [chunk])?.source).toBe("heuristic");
    // A flop of another texture class: its representative has no chunk.
    expect(flopDecision(handOn(["Ts", "7s", "4d"], [LEAD(), CALL]), [chunk])?.source).toBe("heuristic");
    // A chunk solved from another chart set (hash) is not read.
    const stale = { ...chunk, header: { ...chunk.header, charts: { ...chunk.header.charts, hash: "other" } } };
    expect(flopDecision(handOn(["Ts", "7h", "4d"], [LEAD(), CALL]), [stale])?.source).toBe("heuristic");
    // A raise the tree does not have (it has no flop raise) leaves the line: the heuristic.
    const raised = handOn(["Ts", "7h", "4d"], [LEAD(), { position: "BTN", type: "raise", to: 25 }]);
    expect(flopDecision(raised, [chunk])?.source).toBe("heuristic");
  });

  it("narrows the flop by the solved strategy: the turn starts from the library's ranges", () => {
    // The walk records the turn's ranges at the turn's first action.
    const hand = scriptHand({
      id: "FLTURN",
      hero: "BTN",
      heroCards: heroCards(),
      stackBb: CHARTS.game.stackBb,
      preflop: lineActs(CHARTS, LINE.key),
      board: ["Ts", "7h", "4d", "2c"],
      flop: [LEAD(), CALL],
      turn: [{ position: "BB", type: "check" }],
    });
    const context = buildContext(hand);
    const hero = seatOf("BTN");
    const villain = seatOf("BB");
    const entry = libraryEntry(hand, context, hero, CHARTS, memoryLibrary([chunk])) as FlopEntry;
    expect(entry.ok).toBe(true);
    const model = libraryModel(entry);
    const walk = walkRanges(hand, context, hero, villain, CHARTS, model);
    expect(walk.ok).toBe(true);
    if (!walk.ok || !walk.turnStart) throw new Error("no walk to the turn");
    expect(model.flopSource()).toBe("library");
    expect(walk.model).toMatch(/^floplib:/);
    // The library's own ranges where the flop closed (B-C), as 1,326 weights, the turn card removed.
    const closed = entry.result.nodes.findIndex((n) => n.kind === "chance" && n.path === `${lead().path}-C`);
    expect(closed).toBeGreaterThan(0);
    const reach = rangesAt(entry.result, closed);
    const turn = cardIndex("2c");
    for (const [p, range] of [
      [0, walk.turnStart.villain],
      [1, walk.turnStart.hero],
    ] as const) {
      let diff = 0;
      let mass = 0;
      entry.result.hands[p].forEach((combo, i) => {
        if (comboHi(combo) === turn || comboLo(combo) === turn) return;
        diff += Math.abs(range[combo] - reach[p][i]);
        mass += reach[p][i];
      });
      expect(mass).toBeGreaterThan(1);
      expect(diff / mass).toBeLessThan(1e-6);
    }
  });

  it("reads chunks of the chart set the hand's line was answered from (a chart library)", () => {
    const library = fullLibrary();
    const at = (stackBb: number) =>
      analyzeHand(
        scriptHand({ id: "FLSET", hero: "BTN", heroCards: heroCards(), stackBb, preflop: lineActs(CHARTS, LINE.key), board: ["Ts", "7h", "4d"], flop: [LEAD(), CALL] }),
        { charts: library, turn: false, flopLibrary: memoryLibrary([chunk]) },
      ).decisions.find((d) => d.street === "flop");
    // 100bb: the 6-max 100bb set answers, and its chunk is read.
    expect(at(100)?.source).toBe("solver");
    // 150bb: the 150bb set answers; the library has nothing solved from it.
    expect(at(150)?.source).toBe("heuristic");
  });

  it("narrows by the heuristic from where the line leaves the tree", () => {
    const hand = scriptHand({
      id: "FLMIX",
      hero: "BTN",
      heroCards: heroCards(),
      stackBb: CHARTS.game.stackBb,
      preflop: lineActs(CHARTS, LINE.key),
      board: ["Ts", "7h", "4d", "2c"],
      flop: [LEAD(), { position: "BTN", type: "raise", to: 25 }, { position: "BB", type: "call" }],
      turn: [{ position: "BB", type: "check" }],
    });
    const context = buildContext(hand);
    const entry = libraryEntry(hand, context, seatOf("BTN"), CHARTS, memoryLibrary([chunk])) as FlopEntry;
    const model = libraryModel(entry);
    const walk = walkRanges(hand, context, seatOf("BTN"), seatOf("BB"), CHARTS, model);
    expect(walk.ok).toBe(true);
    // The lead is the library's; the raise (the small tree has none) and the call are the heuristic's.
    expect(model.flopSource()).toBe("mixed");
  });

  it("maps each real flop to the chunk it reads", () => {
    expect(flopKey(["Th", "7d", "4c"])).toBe(FLOP);
  });
});
