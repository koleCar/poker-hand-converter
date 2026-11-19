/**
 * The desktop app's nodelock worker engine (`app/src/solver/nodelock/engine`,
 * `docs/NODELOCK.md` §2.4–2.5), its workers run in this thread: a flop lock
 * solved split over the pool comes back as the sequential reference's
 * chunk; the next lock on the spot goes on warm; a cancel rejects and keeps
 * the warm parts; a turn lock comes back as a turn chunk.
 */
import { describe, expect, it } from "vitest";

import { createWorkerEngine, etaOf, type LockSet, type NodelockProgress } from "../../app/src/solver/nodelock/engine/index";
import { createNodelockWorker, type WorkerScope } from "../../app/src/solver/nodelock/engine/worker";
import { FLOP_PROFILE } from "../../web/src/lib/analysis/flopLibrary";
import { solveNodelock, withRangeLocks } from "../../web/src/lib/analysis/nodelock";
import {
  decodeChunk,
  encodeChunk,
  lockHash,
  NUM_COMBOS,
  handsRange,
  parseCards,
  parseRange,
  rangeLocksOf,
  solveFlop,
  withLockRanges,
  type BetMenu,
  type FlopChunk,
  type FlopChunkHeader,
  type FlopSpot,
} from "../../web/src/lib/solver/index";

const HALF: BetMenu = { bet: [0.5], raise: [], allIn: false };
const BET_75: BetMenu = { bet: [0.75], raise: [], allIn: true, allInMaxPot: 3 };
const CHECK_ONLY: BetMenu = { bet: [], raise: [], allIn: false };
const SPOT: FlopSpot = {
  board: ["Ks", "8s", "2d"],
  ranges: ["KK,88,AKs,KQs,QJs,JTs,T9s,A5s,ATo", "AA,QQ,22,AQs,K8s,98s,76s,AJo,KJo"],
  pot: 10,
  stack: 20,
  menus: [{ bet: [0.5], raise: [1], allIn: false }, HALF],
  raiseCap: 1,
  turnMenus: [BET_75, BET_75],
  riverMenus: [CHECK_ONLY, CHECK_ONLY],
  rake: { percent: 0.05, cap: 3 },
  bigBlind: 1,
  isomorphism: true,
};

function baseline(): { chunk: FlopChunk; bytes: Uint8Array } {
  const solved = solveFlop(SPOT, { maxIterations: 40, targetExploitability: 0, checkEvery: 40, dcfr: FLOP_PROFILE.dcfr });
  const header: FlopChunkHeader = {
    version: "floplib/1",
    solver: solved.result.version,
    charts: { id: "test", version: "1", hash: "h" },
    tree: "small",
    line: "btn-bb",
    lineKey: "k",
    players: ["BB", "BTN"],
    flop: "Ks8s2d",
    pot: SPOT.pot,
    stack: SPOT.stack,
    rake: { name: "test", percent: 0.05, cap: 3 },
    targetPct: 1,
  };
  const bytes = encodeChunk(header, solved.result);
  return { chunk: decodeChunk(bytes), bytes };
}

/** A worker run in this thread: messages cross by structured clone on the next tick, as a real one's do. */
function fakeWorker(): Worker {
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => setTimeout(() => worker.onmessage?.({ data: structuredClone(message) } as MessageEvent)),
  };
  createNodelockWorker(scope);
  let alive = true;
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null,
    postMessage: (message: unknown) => setTimeout(() => alive && scope.onmessage?.({ data: structuredClone(message) } as MessageEvent)),
    terminate: () => {
      alive = false;
    },
  };
  return worker as unknown as Worker;
}

describe("the worker engine", () => {
  const { chunk, bytes } = baseline();
  const root = chunk.result.nodes[0];
  const ip = chunk.result.nodes[root.children[root.labels.indexOf("X")]];
  const facing = chunk.result.nodes[ip.children[ip.labels.findIndex((l) => l.startsWith("B"))]];
  const lock = (fold: number): LockSet => {
    const strategy = facing.labels.map((_, a) => new Array<number>(NUM_COMBOS).fill(a === fold ? 1 : 0));
    return {
      version: 1,
      spot: { set: "test", line: "btn-bb", flop: "Ks8s2d" },
      nodes: [{ street: "flop", path: facing.path, player: facing.player as 0 | 1, actions: facing.labels, strategy, locked: new Array<number>(NUM_COMBOS).fill(1) }],
      earlier: "player",
      targetPct: 1,
    };
  };
  const engine = createWorkerEngine({
    threads: 3,
    makeWorker: () => fakeWorker(),
    flopSpotOf: async () => ({ spot: SPOT, chartsHash: "h" }),
    now: () => Date.now(),
  });

  it("solves a flop lock split over its workers, as the sequential reference does", async () => {
    const set = lock(facing.labels.indexOf("F"));
    const seen: NodelockProgress[] = [];
    const out = await engine.solve({ lockSet: set, baseline: bytes, maxIterations: 8 }, (p) => seen.push(p), new AbortController().signal);
    const reference = solveNodelock({ street: "flop", spot: SPOT }, set, { baseline: chunk, maxIterations: 8 });
    const decoded = decodeChunk(out.chunk);
    expect(decoded.header.lockHash).toBe(lockHash(set));
    // The same solve: the chunks differ only in the memory they report.
    const expected = decodeChunk(reference.chunk);
    expect(decoded.result.exploitabilityPct).toBe(expected.result.exploitabilityPct);
    expected.result.nodes.forEach((node, k) => {
      expect(Array.from(decoded.result.nodes[k].strategy)).toEqual(Array.from(node.strategy));
      expect(Array.from(decoded.result.nodes[k].ev)).toEqual(Array.from(node.ev));
    });
    expect(out.stats).toMatchObject({ iterations: 8, threads: 3, engine: "workers", warm: false });
    expect(seen.map((p) => p.iteration)).toContain(8);
    expect(seen.every((p) => p.memoryMb > 0)).toBe(true);
  });

  it("goes on warm for the next lock on the spot, and keeps the parts through a cancel", async () => {
    const controller = new AbortController();
    const cancelled = engine.solve({ lockSet: lock(facing.labels.indexOf("C")), baseline: bytes, maxIterations: 40 }, (p) => {
      if (p.iteration >= 13) controller.abort();
    }, controller.signal);
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const out = await engine.solve({ lockSet: lock(facing.labels.indexOf("C")), baseline: bytes, maxIterations: 20 }, () => {}, new AbortController().signal);
    expect(out.stats.warm).toBe(true);
    expect(out.stats.iterations).toBe(20);
  });

  it("solves a turn lock in a worker of its own", async () => {
    const deal = chunk.result.nodes[ip.children[ip.labels.indexOf("X")]];
    const card = deal.labels[0];
    const set: LockSet = {
      version: 1,
      spot: { set: "test", line: "btn-bb", flop: "Ks8s2d", turn: card },
      nodes: [{ street: "turn", path: `${deal.path}~${card}/`, player: 0, actions: ["X", "B7.5", "A20"], strategy: [], locked: new Array<number>(NUM_COMBOS).fill(1) }],
      earlier: "player",
      targetPct: 1,
    };
    set.nodes[0].strategy = set.nodes[0].actions.map((_, a) => new Array<number>(NUM_COMBOS).fill(a === 0 ? 1 : 0));
    // The live turn's menu after a checked flop (pot 10, 20 behind): check, 75%, all-in.
    const out = await engine.solve({ lockSet: set, baseline: bytes, maxIterations: 30 }, () => {}, new AbortController().signal);
    const decoded = decodeChunk(out.chunk);
    expect(decoded.result.street).toBe("turn");
    expect(decoded.header.lockHash).toBe(lockHash(set));
    expect(decoded.result.nodes[0].frequency[0]).toBeCloseTo(1, 4);
    engine.release();
  });

  it("estimates the time to the target from the pace", () => {
    expect(etaOf([{ iteration: 40, pct: 4 }], 40, 1000, 1, 300)).toBeNull();
    // 4% at 40, 2% at 80: halving per doubling, so 1% at 160.
    expect(etaOf([{ iteration: 40, pct: 4 }, { iteration: 80, pct: 2 }], 80, 1000, 1, 300)).toBeCloseTo(80_000, 3);
    expect(etaOf([{ iteration: 40, pct: 4 }, { iteration: 80, pct: 0.5 }], 80, 1000, 1, 300)).toBe(0);
  });
});

describe("the worker engine with a range lock (§9.2)", () => {
  const { chunk, bytes } = baseline();
  const board = parseCards(["Ks", "8s", "2d"]);
  const gto: [Float64Array, Float64Array] = [handsRange(chunk.result.hands[0], chunk.result.weights[0]), handsRange(chunk.result.hands[1], chunk.result.weights[1])];
  const plain: LockSet = { version: 1, spot: { set: "test", line: "btn-bb", flop: "Ks8s2d" }, nodes: [], earlier: "player", targetPct: 1 };
  const wide = withLockRanges(plain, rangeLocksOf(gto, [gto[0], parseRange("AA,QQ,22,AQs,K8s,98s,76s,AJo,KJo,KTs,QTs")], board));
  const narrow = withLockRanges(plain, rangeLocksOf(gto, [gto[0], parseRange("AA,QQ,22,AQs,K8s")], board));
  const engine = createWorkerEngine({
    threads: 2,
    makeWorker: () => fakeWorker(),
    // As `nodelockFlopSpot`: the chart's spot with the set's ranges in place.
    flopSpotOf: async (set) => ({ spot: withRangeLocks(SPOT, set), chartsHash: "h" }),
    now: () => Date.now(),
  });

  it("solves split from the edited ranges, as the reference does, and never warm across ranges", async () => {
    const out = await engine.solve({ lockSet: wide, baseline: bytes, maxIterations: 6 }, () => {}, new AbortController().signal);
    const reference = solveNodelock({ street: "flop", spot: withRangeLocks(SPOT, wide) }, wide, { baseline: chunk, maxIterations: 6 });
    const decoded = decodeChunk(out.chunk);
    const expected = decodeChunk(reference.chunk);
    expect(decoded.header.lockHash).toBe(lockHash(wide));
    expect(Array.from(decoded.result.hands[1])).toEqual(Array.from(expected.result.hands[1]));
    expect(decoded.result.hands[1].length).toBeGreaterThan(chunk.result.hands[1].length);
    expected.result.nodes.forEach((node, k) => expect(Array.from(decoded.result.nodes[k].strategy)).toEqual(Array.from(node.strategy)));
    const other = await engine.solve({ lockSet: narrow, baseline: bytes, maxIterations: 6 }, () => {}, new AbortController().signal);
    expect(other.stats.warm).toBe(false);
    const again = await engine.solve({ lockSet: narrow, baseline: bytes, maxIterations: 12 }, () => {}, new AbortController().signal);
    expect(again.stats.warm).toBe(true);
    engine.release();
  });
});
