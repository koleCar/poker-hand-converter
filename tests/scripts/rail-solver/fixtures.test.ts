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
import { encodeChunk, FLOPLIB_VERSION, type FlopChunkHeader } from "../../../web/src/lib/solver/flopLibrary.js";
import { encodeSolution, SOLVER_VERSION } from "../../../web/src/lib/solver/format.js";
import type { Game } from "../../../web/src/lib/solver/game.js";
import { solveRiver, solveTurn, type SolveResult } from "../../../web/src/lib/solver/solve.js";
import type { SpotInput, TurnSpot } from "../../../web/src/lib/solver/subgame.js";
import { clairvoyanceGame, kuhnGame, leducGame } from "../../../web/src/lib/solver/toys.js";
import { lineSpot } from "../flop-library/spots.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SMALL = join(ROOT, "core/rail-solver/tests/fixtures");
const BIG = join(ROOT, "target/rail-solver-fixtures");

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

function flopFixture(name: string, storage: "f32" | "i16") {
  const r0 = "99-55, A5s-A2s, KTs+, QJs, T9s, 87s, 76s, KQo";
  const r1 = "TT+, AQs+, AKo, K9s, 65s, 54s";
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
  it("writes the small fixtures", () => {
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
