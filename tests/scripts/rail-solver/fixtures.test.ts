/**
 * Parity fixtures for the native solver (`core/rail-solver`, docs/NODELOCK.md
 * §2.5): the TypeScript solver is the reference, and these are its answers.
 *
 * - Toy games (Kuhn, Leduc, the clairvoyance game) as serialised games, so the
 *   Rust engine is checked apart from the builders.
 * - A river spot (float32 and 16-bit storage), a turn spot with suit
 *   isomorphism, a reduced flop spot: as spot inputs, so the builders are
 *   checked too, with the encoded solution / chunk bytes.
 * - With `RAIL_SOLVER_BIG=1`: the real flop-m1 spot (6-max 100bb, BTN vs BB,
 *   Ks5h3s) at a few iterations, to `target/rail-solver-fixtures` (never
 *   committed: minutes of solving and megabytes of JSON).
 *
 * Floats travel as base64 of their little-endian bytes: exact, where JSON
 * numbers need not parse back to the same bits.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { FLOP_PROFILE, FLOP_LINES, chartLineHash } from "../../../web/src/lib/analysis/flopLibrary.js";
import { rakeOf as chartRake } from "../../../web/src/lib/analysis/river.js";
import { loadCharts } from "../../../web/src/lib/charts/index.js";
import { Solver, type DcfrParams } from "../../../web/src/lib/solver/cfr.js";
import { parseRange } from "../../../web/src/lib/solver/combos.js";
import { solveFlop, type FlopSpot } from "../../../web/src/lib/solver/flop.js";
import { decodeChunk, encodeChunk, FLOPLIB_VERSION, type FlopChunk, type FlopChunkHeader } from "../../../web/src/lib/solver/flopLibrary.js";
import { LIVE_TURN, liveTurnSpot } from "../../../web/src/lib/solver/liveTurn.js";
import { lockHash, lockPathOf, lockSymmetries, nodelockHeader, type LockSet, type NodeLockSpec } from "../../../web/src/lib/solver/nodelock.js";
import { buildTurnGame } from "../../../web/src/lib/solver/subgame.js";
import { NUM_COMBOS } from "../../../web/src/lib/solver/combos.js";
import { nodelockFlopRun, nodelockTurnRun, nodelockTurnSpot, solveNodelock, type NodelockSpot, type NodelockWarm } from "../../../web/src/lib/analysis/nodelock.js";
import { createWorkerEngine } from "../../../app/src/solver/nodelock/engine/engine.js";
import { nativeRequestOf } from "../../../app/src/solver/nodelock/engine/request.js";
import { createNodelockWorker, type WorkerScope } from "../../../app/src/solver/nodelock/engine/worker.js";
import { encodeSolution, SOLVER_VERSION } from "../../../web/src/lib/solver/format.js";
import type { Game } from "../../../web/src/lib/solver/game.js";
import { solveRiver, solveTurn, type SolveResult } from "../../../web/src/lib/solver/solve.js";
import type { SpotInput, TurnSpot } from "../../../web/src/lib/solver/subgame.js";
import { clairvoyanceGame, kuhnGame, leducGame } from "../../../web/src/lib/solver/toys.js";
import { lineSpot } from "../flop-library/spots.js";
import { SMALL_R0, SMALL_R1, smallFlopSpot } from "./small.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SMALL = join(ROOT, "core/rail-solver/tests/fixtures");
const BIG = join(ROOT, "target/rail-solver-fixtures");
/** The app crate's nodelock command test (`app/src-tauri/src/nodelock_solve.rs`). */
const APP = join(ROOT, "app/src-tauri/tests/fixtures");

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const f64 = (xs: ArrayLike<number>) => b64(new Uint8Array(Float64Array.from(xs).buffer));
const f32 = (xs: ArrayLike<number>) => b64(new Uint8Array(Float32Array.from(xs).buffer));

function serialiseGame(game: Game) {
  const t = game.tree;
  const mirrors = (list: readonly { card: number; map: readonly [Int32Array, Int32Array] }[] | undefined) =>
    list?.map((m) => ({ card: m.card, map: [Array.from(m.map[0]), Array.from(m.map[1])] }));
  return {
    tree: {
      root: t.root,
      type: Array.from(t.type),
      player: Array.from(t.player),
      childStart: Array.from(t.childStart),
      childCount: Array.from(t.childCount),
      children: Array.from(t.children),
      edgeLabel: t.edgeLabel,
      edgeCard: Array.from(t.edgeCard),
      payoff: f64(t.payoff),
      board: Array.from(t.board),
      chanceWeight: f64(t.chanceWeight),
      maxDepth: t.maxDepth,
    },
    numCards: game.numCards,
    hands: game.hands.map((h) => ({ c1: Array.from(h.c1), c2: Array.from(h.c2), weight: f64(h.weight) })),
    boards: game.boards.map((b) => ({
      order: [Array.from(b.order[0]), Array.from(b.order[1])],
      strength: [f64(b.strength[0]), f64(b.strength[1])],
    })),
    pot: game.pot,
    bigBlind: game.bigBlind ?? null,
    mirrors: game.mirrors ? game.mirrors.map((m) => mirrors(m) ?? null) : null,
  };
}

function exploitabilityOf(solver: Solver) {
  const e = solver.exploitability();
  return f64([e.bestResponse[0], e.bestResponse[1], e.value[0], e.value[1], e.nashConv, e.exploitability, e.percentPot, e.mbb]);
}

function gameFixture(name: string, game: Game, iterations: number, storage: "f32" | "i16", dcfr?: Partial<DcfrParams>) {
  const solver = new Solver(game, dcfr, { storage });
  solver.iterate(iterations);
  const strategies: Record<string, string> = {};
  for (let node = 0; node < game.tree.size; node += 1) {
    if (game.tree.type[node] === 0) strategies[node] = f32(solver.averageStrategy(node));
  }
  return {
    name,
    game: serialiseGame(game),
    options: { iterations, storage, dcfr: { alpha: 1.5, beta: 0, gamma: 2, ...dcfr } },
    expect: { strategies, exploitability: exploitabilityOf(solver) },
  };
}

function rangeB64(text: string) {
  return f64(parseRange(text));
}

/** FNV-1a 64 of bytes, as hex: what a fixture keeps of bytes too big to commit. */
function fnv64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Keeps every `keep(path)` node; the bytes in full under 300 KB, else their length and hash. */
function resultExpect(result: SolveResult, bytes: Uint8Array, keep: (path: string) => boolean = () => true) {
  return {
    iterations: result.iterations,
    stoppedBy: result.stoppedBy,
    exploitability: f64([result.exploitability, result.exploitabilityPct, result.exploitabilityMbb]),
    value: f64(result.value),
    hands: [Array.from(result.hands[0]), Array.from(result.hands[1])],
    nodes: result.nodes
      .filter((node) => node.kind === "action" && keep(node.path))
      .map((node) => ({ path: node.path, player: node.player, labels: node.labels, strategy: f32(node.strategy), ev: f32(node.ev), frequency: f64(node.frequency) })),
    ...(bytes.length < 300_000 ? { bytes: b64(bytes) } : {}),
    bytesLength: bytes.length,
    bytesFnv: fnv64(bytes),
  };
}

interface SpotOptions {
  maxIterations: number;
  checkEvery: number;
  checkFrom?: number;
  targetExploitability: number;
  dcfr: DcfrParams;
  storage: "f32" | "i16";
}

function spotJson(spot: SpotInput | TurnSpot | FlopSpot, ranges: [string, string]) {
  return { ...spot, ranges };
}

const menu = (bet: number[], raise: number[], allIn = true, allInMaxPot?: number) => ({ bet, raise, allIn, ...(allInMaxPot ? { allInMaxPot } : {}) });

function riverFixture(name: string, storage: "f32" | "i16") {
  const r0 = "22+, A2s+, K9s+, QTs+, JTs, T9s, ATo+, KJo+";
  const r1 = "TT+, AQs+, AKo, 76s, 65s, KQs, QJs";
  const spot: SpotInput = {
    board: ["Ks", "5h", "3s", "7d", "2c"],
    ranges: [parseRange(r0), parseRange(r1)],
    pot: 10,
    stack: 50,
    firstToAct: 0,
    menus: [menu([0.5, 1], [1]), menu([0.33, 0.75], [0.5])],
    raiseCap: 2,
    allInThreshold: 0.1,
    minBet: 1,
    rake: { percent: 0.05, cap: 3 },
    bigBlind: 1,
  };
  const options: SpotOptions = { maxIterations: 120, checkEvery: 25, targetExploitability: 0, dcfr: { alpha: 1.5, beta: 0, gamma: 2 }, storage };
  const result = solveRiver(spot, options);
  return { name, spot: spotJson(spot, [rangeB64(r0), rangeB64(r1)]), options: { ...options, scope: "all" }, expect: resultExpect(result, encodeSolution(result)) };
}

function turnFixture(name: string) {
  const r0 = "88+, A9s+, KTs+, QJs, AJo+, KQo, 98s, 65s";
  const r1 = "TT+, AQs+, AKo, 76s, KQs, T9s";
  const spot: TurnSpot = {
    board: ["Ks", "9s", "4h", "2h"],
    ranges: [parseRange(r0), parseRange(r1)],
    pot: 20,
    stack: 80,
    firstToAct: 0,
    menus: [menu([0.75], [0.75], true, 3), menu([0.75], [0.75], true, 3)],
    raiseCap: 1,
    riverMenus: [menu([0.75], []), menu([0.75], [])],
    riverRaiseCap: 0,
    allInThreshold: 0.1,
    minBet: 1,
    rake: { percent: 0.05, cap: 3 },
    bigBlind: 1,
    isomorphism: true,
  };
  const options: SpotOptions = { maxIterations: 40, checkEvery: 20, targetExploitability: 0, dcfr: { alpha: 1.5, beta: 0, gamma: 3 }, storage: "f32" };
  const result = solveTurn(spot, options);
  return { name, spot: spotJson(spot, [rangeB64(r0), rangeB64(r1)]), options: { ...options, scope: "all" }, expect: resultExpect(result, encodeSolution(result), (path) => !path.includes("|") || /\|[2-5]/.test(path)) };
}

function header(flop: string, pot: number, stack: number, rake: { name: string; percent: number; cap: number }, tree: string, targetPct: number): FlopChunkHeader {
  return {
    version: FLOPLIB_VERSION,
    solver: SOLVER_VERSION,
    charts: { id: "fixture", version: "0", hash: "0" },
    tree,
    line: "btn-bb",
    lineKey: "fffrfc",
    players: ["BB", "BTN"],
    flop,
    pot,
    stack,
    rake,
    targetPct,
  };
}

/** A lock: the first action for every other combo (by index), so it is not suit-symmetric. */
function halfLock(street: "flop" | "turn" | "river", path: string, player: 0 | 1, actions: string[], symmetric: boolean, action = 0): NodeLockSpec {
  const strategy = actions.map((_, a) => new Array<number>(NUM_COMBOS).fill(a === action ? 1 : 0));
  const locked = Array.from({ length: NUM_COMBOS }, (_, c) => (symmetric ? 1 : c % 2));
  return { street, path, player, actions, strategy, locked };
}

/** The small flop's library chunk: 12 iterations, 16-bit, as the library solves. */
function smallLibrary() {
  const p = FLOP_PROFILE;
  const library = solveFlop(smallFlopSpot(), { maxIterations: 12, checkEvery: 6, checkFrom: 6, targetExploitability: 0, dcfr: { ...p.dcfr }, storage: "i16" });
  const baselineBytes = encodeChunk(header("Ks5h3s", 5.5, 97.5, { name: "fixture", percent: 0.05, cap: 3 }, p.tree, p.targetPct), library.result);
  return { baselineBytes, chunk: decodeChunk(baselineBytes) };
}

/**
 * Nodelock solves by the TypeScript reference (`solveNodelock`) on the small
 * flop: a flop lock and a turn lock, each with "player" earlier nodes. The
 * fixture is the native request (`NodelockRequest`) and the chunk it must give.
 */
function nodelockFixtures() {
  const spot = smallFlopSpot();
  const { chunk, baselineBytes } = smallLibrary();
  const out: Record<string, unknown> = {};

  // Flop: player 0's node after check-bet, half its combos locked; its earlier node is the root.
  const node = chunk.result.nodes.find((n) => n.kind === "action" && n.player === 0 && n.path.startsWith("X-B"));
  if (!node) throw new Error("no X-B node");
  const flopSet: LockSet = {
    version: 1,
    spot: { set: "fixture", line: "btn-bb", flop: "Ks5h3s" },
    nodes: [halfLock("flop", node.path, 0, node.labels, false)],
    earlier: "player",
    targetPct: 1,
  };
  const flopSpot: FlopSpot = { ...spot, symmetry: lockSymmetries(flopSet, spot.board) };
  const flopSolve = solveNodelock({ street: "flop", spot: flopSpot }, flopSet, { baseline: chunk, maxIterations: 12 });
  const flopRun = nodelockFlopRun(flopSet, 12);
  out.flop = {
    request: {
      spot: { ...flopSpot, ranges: [rangeB64(SMALL_R0), rangeB64(SMALL_R1)] },
      lockSet: flopSet,
      baseline: b64(baselineBytes),
      header: JSON.stringify(nodelockHeader(chunk.header, flopSet)),
      options: { maxIterations: flopRun.maxIterations, targetPct: flopRun.targetExploitability, checkFrom: flopRun.checkFrom, checkEvery: flopRun.checkEvery, dcfr: flopRun.dcfr },
    },
    expect: { chunk: b64(flopSolve.chunk), iterations: flopSolve.stats.iterations, exploitabilityPct: f64([flopSolve.stats.exploitabilityPct]) },
  };

  // Turn: the check-check deal, its first turn card, player 0's node after check-bet in the turn game.
  const deal = chunk.result.nodes.findIndex((n) => n.kind === "chance" && n.path === "X-X");
  const card = chunk.result.nodes[deal].labels[0];
  const turnGame = buildTurnGame(liveTurnSpot(chunk, deal, card));
  const turnInfo = turnGame.info.find((info, k) => info && info.street === "turn" && info.path.startsWith("X-B") && turnGame.game.tree.player[k] === 0);
  if (!turnInfo) throw new Error("no turn X-B node");
  const turnSet: LockSet = {
    version: 1,
    spot: { set: "fixture", line: "btn-bb", flop: "Ks5h3s", turn: card },
    nodes: [halfLock("turn", lockPathOf("X-X", card, turnInfo.path), 0, turnInfo.actions.map((a) => a.label), false)],
    earlier: "player",
    targetPct: 1,
  };
  const turnSpot = nodelockTurnSpot(chunk, turnSet);
  const turnSolve = solveNodelock(turnSpot, turnSet, { baseline: chunk, maxIterations: 30 });
  const turnRun = nodelockTurnRun(turnSet, 30);
  out.turn = {
    request: {
      spot: { ...turnSpot.spot, ranges: [f64(turnSpot.spot.ranges[0] as Float64Array), f64(turnSpot.spot.ranges[1] as Float64Array)] },
      lockSet: turnSet,
      baseline: null,
      header: JSON.stringify(nodelockHeader(chunk.header, turnSet)),
      options: { maxIterations: turnRun.maxIterations, targetPct: turnRun.targetExploitability, checkFrom: turnRun.checkFrom, checkEvery: turnRun.checkEvery, dcfr: LIVE_TURN.dcfr },
    },
    expect: { chunkLength: turnSolve.chunk.length, chunkFnv: fnv64(turnSolve.chunk), rootStrategy: f32(turnSolve.result.nodes[0].strategy), iterations: turnSolve.stats.iterations, exploitabilityPct: f64([turnSolve.stats.exploitabilityPct]) },
  };
  return out;
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

/** The two chunks are one solve: the same strategies, values and exploitability (the worker's reports its own memory). */
function sameSolve(what: string, a: Uint8Array, b: Uint8Array) {
  const x = decodeChunk(a).result;
  const y = decodeChunk(b).result;
  const same = (p: ArrayLike<number>, q: ArrayLike<number>) => p.length === q.length && Array.from(p).every((v, i) => Object.is(v, q[i]));
  if (x.exploitabilityPct !== y.exploitabilityPct || x.nodes.length !== y.nodes.length || x.nodes.some((n, k) => !same(n.strategy, y.nodes[k].strategy) || !same(n.ev, y.nodes[k].ev))) {
    throw new Error(`${what}: the worker engine and the reference differ`);
  }
}

/**
 * Warm starts (`docs/NODELOCK.md` §2.5): a lock, then another on the same
 * spot, solved by the TypeScript worker engine (`createWorkerEngine`, its
 * workers in this thread) and held to the reference (`solveNodelock` with
 * `warm`). The requests are the native ones (`nativeRequestOf`, as the app
 * sends them); the Rust engine must answer the second lock warm with the
 * reference's chunk. The turn runs three locks on one deal: "none" (no
 * unlocked baseline solved), "player" (so it starts cold: the warm solver
 * lacks the baseline), "player" again (warm). `based` (§7.4) runs a turn lock
 * on the library, then on the first flop lock's result (cold: other ranges at
 * the same deal), then another on that result (warm); `base` is that chunk.
 */
async function nodelockWarmFixtures() {
  const spot = smallFlopSpot();
  const { chunk, baselineBytes } = smallLibrary();
  const engine = createWorkerEngine({
    threads: 3,
    makeWorker: () => fakeWorker(),
    flopSpotOf: async (set) => ({ spot: { ...spot, symmetry: lockSymmetries(set, spot.board) }, chartsHash: "0" }),
    now: () => Date.now(),
  });
  const signal = new AbortController().signal;
  // A turn lock's chunk holds the whole turn game (megabytes): its hash is kept, and the worker's is the reference's byte for byte.
  // `on`: the chunk each lock is solved on (default the library's; a based lock's base, §7.4).
  const solveAll = async (sets: LockSet[], spotOf: (set: LockSet) => NodelockSpot, iterations: number[], keepChunk: boolean, on: (set: LockSet) => { bytes: Uint8Array; chunk: FlopChunk } = () => ({ bytes: baselineBytes, chunk })) => {
    const steps = [];
    let warm: NodelockWarm | undefined;
    let solvedOn: Uint8Array | null = null;
    for (const [k, set] of sets.entries()) {
      const { bytes: baseBytes, chunk: baseChunk } = on(set);
      // The reference's warm start is the caller's to keep to one game: another base is another game.
      if (solvedOn !== baseBytes) warm = undefined;
      solvedOn = baseBytes;
      const worker = await engine.solve({ lockSet: set, baseline: baseBytes, maxIterations: iterations[k] }, () => {}, signal);
      const reference = solveNodelock(spotOf(set), set, { baseline: baseChunk, maxIterations: iterations[k], warm });
      warm = reference.warm;
      if (worker.stats.warm !== reference.stats.warm) throw new Error(`step ${k}: warm ${worker.stats.warm} vs ${reference.stats.warm}`);
      sameSolve(`step ${k}`, worker.chunk, reference.chunk);
      if (!keepChunk && fnv64(worker.chunk) !== fnv64(reference.chunk)) throw new Error(`step ${k}: the worker's turn chunk differs`);
      steps.push({
        request: nativeRequestOf(set, baseBytes, baseChunk, spotOf(set), iterations[k]),
        expect: {
          warm: reference.stats.warm,
          chunkFnv: fnv64(reference.chunk),
          workerChunk: keepChunk ? b64(worker.chunk) : null,
          rootStrategy: f32(reference.result.nodes[0].strategy),
          iterations: reference.stats.iterations,
          exploitabilityPct: f64([reference.stats.exploitabilityPct]),
        },
      });
    }
    return steps;
  };

  const node = chunk.result.nodes.find((n) => n.kind === "action" && n.player === 0 && n.path.startsWith("X-B"));
  if (!node) throw new Error("no X-B node");
  const flopLock = (action: number): LockSet => ({
    version: 1,
    spot: { set: "fixture", line: "btn-bb", flop: "Ks5h3s" },
    nodes: [halfLock("flop", node.path, 0, node.labels, false, action)],
    earlier: "player",
    targetPct: 1,
  });
  const flopSets = [flopLock(0), flopLock(1)];
  const flopSpotOf = (set: LockSet): NodelockSpot => ({ street: "flop", spot: { ...spot, symmetry: lockSymmetries(set, spot.board) } });
  const flop = await solveAll(flopSets, flopSpotOf, [12, 20], true);
  if (!flop[1].expect.warm) throw new Error("the second flop lock did not go on warm");

  const deal = chunk.result.nodes.findIndex((n) => n.kind === "chance" && n.path === "X-X");
  const card = chunk.result.nodes[deal].labels[0];
  const turnGame = buildTurnGame(liveTurnSpot(chunk, deal, card));
  const turnInfo = turnGame.info.find((info, k) => info && info.street === "turn" && info.path.startsWith("X-B") && turnGame.game.tree.player[k] === 0);
  if (!turnInfo) throw new Error("no turn X-B node");
  const turnLock = (action: number, earlier: LockSet["earlier"]): LockSet => ({
    version: 1,
    spot: { set: "fixture", line: "btn-bb", flop: "Ks5h3s", turn: card },
    nodes: [halfLock("turn", lockPathOf("X-X", card, turnInfo.path), 0, turnInfo.actions.map((a) => a.label), false, action)],
    earlier,
    targetPct: 1,
  });
  const turnSets = [turnLock(1, "none"), turnLock(0, "player"), turnLock(1, "player")];
  const turn = await solveAll(turnSets, (set) => nodelockTurnSpot(chunk, set), [30, 30, 40], false);
  if (turn.map((step) => step.expect.warm).join() !== "false,false,true") {
    throw new Error(`turn warm starts: ${turn.map((step) => step.expect.warm).join()}`);
  }

  // Locks on locks (§7.4): the same turn lock on the library, then built on the first flop lock's
  // result (its ranges at the deal differ: a cold start, though the deal and card are the same),
  // then another built on it (warm). From a fresh engine, as the reference starts.
  engine.release();
  const flopBase = solveNodelock(flopSpotOf(flopSets[0]), flopSets[0], { baseline: chunk, maxIterations: 12 });
  const base = { bytes: flopBase.chunk, chunk: decodeChunk(flopBase.chunk) };
  const on = { lockHash: lockHash(flopSets[0]), street: "flop" as const };
  const basedSets = [turnLock(0, "player"), { ...turnLock(0, "player"), base: on }, { ...turnLock(1, "player"), base: on }];
  const onBase = (set: LockSet) => (set.base ? base : { bytes: baselineBytes, chunk });
  const based = await solveAll(basedSets, (set) => nodelockTurnSpot(onBase(set).chunk, set), [30, 30, 40], false, onBase);
  if (based.map((step) => step.expect.warm).join() !== "false,false,true") {
    throw new Error(`based warm starts: ${based.map((step) => step.expect.warm).join()}`);
  }
  engine.release();

  // The app crate's command test: the first flop lock, as `native.ts` sends it.
  const app = { request: flop[0].request, lockHash: lockHash(flopSets[0]), next: flop[1].request, nextLockHash: lockHash(flopSets[1]) };
  return { parity: { flop, turn, based, base: b64(flopBase.chunk) }, app };
}

function flopFixture(name: string, storage: "f32" | "i16") {
  const r0 = SMALL_R0;
  const r1 = SMALL_R1;
  const p = FLOP_PROFILE;
  const spot: FlopSpot = {
    board: ["Ks", "5h", "3s"],
    ranges: [parseRange(r0), parseRange(r1)],
    pot: 5.5,
    stack: 97.5,
    firstToAct: 0,
    menus: [p.flopMenu, p.flopMenu],
    raiseCap: p.flopRaiseCap,
    turnMenus: [p.turnMenu, p.turnMenu],
    turnRaiseCap: p.turnRaiseCap,
    riverMenus: [p.riverMenu, p.riverMenu],
    riverRaiseCap: p.riverRaiseCap,
    allInThreshold: p.allInThreshold,
    minBet: p.minBet,
    rake: { percent: 0.05, cap: 3 },
    bigBlind: 1,
    isomorphism: true,
  };
  const options: SpotOptions = { maxIterations: 12, checkEvery: 6, checkFrom: 6, targetExploitability: 0, dcfr: { ...p.dcfr }, storage };
  const solved = solveFlop(spot, options);
  const h = header("Ks5h3s", 5.5, 97.5, { name: "fixture", percent: 0.05, cap: 3 }, p.tree, p.targetPct);
  return {
    name,
    spot: spotJson(spot, [rangeB64(r0), rangeB64(r1)]),
    options: { ...options, scope: "flop" },
    header: JSON.stringify(h),
    expect: { ...resultExpect(solved.result, encodeChunk(h, solved.result)), nodesInTree: solved.stats.nodes, boards: solved.stats.boards },
  };
}

function realFlopSpot() {
  const setId = "nlhe-cash-6max-100bb";
  const charts = loadCharts(JSON.parse(readFileSync(join(ROOT, "web/src/lib/charts/data", `${setId}.json`), "utf8")));
  const line = FLOP_LINES.find((l) => l.id === "btn-bb");
  if (!line) throw new Error("no btn-bb line");
  const ls = lineSpot(charts, line);
  const rake = chartRake(charts);
  const p = FLOP_PROFILE;
  const spot: FlopSpot = {
    board: ["Ks", "5h", "3s"],
    ranges: [Float64Array.from(ls.ranges[0]), Float64Array.from(ls.ranges[1])],
    pot: ls.pot,
    stack: ls.stack,
    firstToAct: 0,
    menus: [p.flopMenu, p.flopMenu],
    raiseCap: p.flopRaiseCap,
    turnMenus: [p.turnMenu, p.turnMenu],
    turnRaiseCap: p.turnRaiseCap,
    riverMenus: [p.riverMenu, p.riverMenu],
    riverRaiseCap: p.riverRaiseCap,
    allInThreshold: p.allInThreshold,
    minBet: p.minBet,
    rake: { percent: rake.percent, cap: rake.cap },
    bigBlind: 1,
    isomorphism: true,
  };
  const h: FlopChunkHeader = {
    ...header("Ks5h3s", ls.pot, ls.stack, { name: rake.name, percent: rake.percent, cap: rake.cap }, p.tree, p.targetPct),
    charts: { id: charts.id, version: charts.version, hash: charts.model.hash },
    lineHash: chartLineHash(charts, line.key) ?? undefined,
    players: ls.players,
  };
  return { spot, ranges: [f64(ls.ranges[0]), f64(ls.ranges[1])] as [string, string], header: h };
}

/** The real spot's input alone (no solve): what the native benchmark reads. */
function realSpotInput() {
  const { spot, ranges, header: h } = realFlopSpot();
  const p = FLOP_PROFILE;
  return {
    name: "flop-m1-btn-bb-Ks5h3s",
    spot: { ...spot, ranges },
    options: { maxIterations: p.maxIterations, checkEvery: p.checkEvery, checkFrom: p.checkFrom, targetExploitability: p.targetPct, dcfr: { ...p.dcfr }, storage: "i16", scope: "flop" },
    header: JSON.stringify(h),
  };
}

function realFlopFixture(iterations: number) {
  const { spot, ranges, header: h } = realFlopSpot();
  const p = FLOP_PROFILE;
  const options: SpotOptions = { maxIterations: iterations, checkEvery: iterations, checkFrom: iterations, targetExploitability: 0, dcfr: { ...p.dcfr }, storage: "i16" };
  const started = performance.now();
  const solved = solveFlop(spot, options);
  const seconds = (performance.now() - started) / 1000;
  return {
    name: "flop-m1-btn-bb-Ks5h3s",
    spot: { ...spot, ranges },
    options: { ...options, scope: "flop" },
    header: JSON.stringify(h),
    tsSeconds: seconds,
    expect: { ...resultExpect(solved.result, encodeChunk(h, solved.result)), nodesInTree: solved.stats.nodes, boards: solved.stats.boards },
  };
}

function write(dir: string, name: string, data: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(data)}\n`);
}

describe("rail-solver fixtures", () => {
  it("writes the small fixtures", async () => {
    write(SMALL, "kuhn", gameFixture("kuhn", kuhnGame(), 300, "f32"));
    write(SMALL, "kuhn-i16", gameFixture("kuhn-i16", kuhnGame(), 300, "i16"));
    write(SMALL, "leduc", gameFixture("leduc", leducGame(), 150, "f32"));
    write(SMALL, "leduc-i16", gameFixture("leduc-i16", leducGame(), 150, "i16", { gamma: 3 }));
    write(SMALL, "clairvoyance", gameFixture("clairvoyance", clairvoyanceGame(0.75, 0.3), 200, "f32"));
    write(SMALL, "river", riverFixture("river", "f32"));
    write(SMALL, "river-i16", riverFixture("river-i16", "i16"));
    write(SMALL, "turn-iso", turnFixture("turn-iso"));
    write(SMALL, "flop-small", flopFixture("flop-small", "i16"));
    write(SMALL, "flop-small-f32", flopFixture("flop-small-f32", "f32"));
    write(SMALL, "nodelock", nodelockFixtures());
    const warm = await nodelockWarmFixtures();
    write(SMALL, "nodelock-warm", warm.parity);
    write(APP, "nodelock-request", warm.app);
    // V8's Math.pow for the discounts, to compare with Rust's powf.
    const pows: number[] = [];
    for (let t = 1; t <= 400; t += 1) pows.push(Math.pow(t - 1, 1.5), Math.pow(t, 2), Math.pow(t, 3));
    write(SMALL, "pow", { pows: f64(pows) });
  });

  it("writes the real flop-m1 spot's input", () => {
    write(BIG, "flop-m1-spot", realSpotInput());
  });

  it.runIf(process.env.RAIL_SOLVER_BIG === "1")("writes the real flop-m1 spot", () => {
    write(BIG, "flop-m1-btn-bb-Ks5h3s", realFlopFixture(Number(process.env.RAIL_SOLVER_ITERATIONS ?? 4)));
  });
});
