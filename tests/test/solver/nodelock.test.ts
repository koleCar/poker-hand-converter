/**
 * Nodelock (`docs/NODELOCK.md` §1–2.4): frozen nodes in the engine, the lock
 * model, the locked solve and its split twin.
 *
 * - **Frozen nodes** (§2.1), both storages, on the toy games: a frozen node
 *   never moves; the unfrozen hands of a partly frozen node adapt; the
 *   opponent's best response to a frozen strategy is the exploit lab's
 *   (`lock.ts`); the locked game's exploitability goes to zero while the
 *   frozen player could still gain by deviating.
 * - **Earlier nodes** freeze at the baseline: "player" the locked player's,
 *   "all" both, "none" nothing.
 * - **The locked flop solve split over parts is bit-identical** to the
 *   sequential reference (`solveNodelock`).
 * - **Turn locks** re-solve the deal's turn game and come back as a chunk
 *   that decodes, with the lock's hash.
 * - **The hash** is SHA-256 of the canonical JSON.
 */

import { describe, expect, it } from "vitest";

import { checkBaseline, NODELOCK_WARM_ITERATION, nodelockFlopRun, nodelockTurnSpot, solveNodelock } from "../../../web/src/lib/analysis/nodelock.js";
import { FLOP_PROFILE } from "../../../web/src/lib/analysis/flopLibrary.js";
import {
  applyNodelock,
  buildTurnGame,
  canonicalJson,
  chunkBaseline,
  comboRowsToHands,
  combosToHands,
  decodeChunk,
  driveSync,
  exploitLab,
  handRowsToCombos,
  handsToCombos,
  kuhnGame,
  leducGame,
  lockedStrategy,
  lockHash,
  lockPathOf,
  lockSymmetries,
  NodelockError,
  NUM_COMBOS,
  ownReach,
  parseCombo,
  sha256Hex,
  solveFlop,
  Solver,
  SplitCoordinator,
  SplitPart,
  splitCards,
  splitLockPath,
  type BetMenu,
  type FlatTree,
  type FlopChunk,
  type FlopChunkHeader,
  type FlopSpot,
  type LockSet,
  type NodeLockSpec,
  type SolveResult,
} from "../../../web/src/lib/solver/index.js";

/** Node reached from the root by following edge labels. */
function nodeAt(tree: FlatTree, labels: string[]): number {
  let node = tree.root;
  for (const label of labels) {
    const start = tree.childStart[node];
    const edge = tree.edgeLabel.slice(start, start + tree.childCount[node]).indexOf(label);
    expect(edge, `edge ${label}`).toBeGreaterThanOrEqual(0);
    node = tree.children[start + edge];
  }
  return node;
}

describe("frozen nodes", () => {
  for (const storage of ["f32", "i16"] as const) {
    it(`never move a fully frozen node (${storage})`, () => {
      const game = kuhnGame();
      const solver = new Solver(game, {}, { storage });
      // Player 0 opens: J checks, Q bets half, K always bets.
      const fixed = [1, 0.5, 0, 0, 0.5, 1];
      solver.freeze(game.tree.root, fixed);
      solver.iterate(300);
      expect(Array.from(solver.averageStrategy(game.tree.root))).toEqual(Array.from(Float32Array.from(fixed)));
      // The rest re-solves against it: the locked game's exploitability goes to ~0 ...
      const locked = solver.exploitability();
      expect(locked.exploitability).toBeLessThan(5e-3);
      // ... while player 0, free to deviate, would gain (betting Q half the time is a mistake).
      const free = solver.exploitability({ unconstrained: true });
      expect(free.bestResponse[0]).toBeGreaterThan(locked.bestResponse[0] + 0.01);
      expect(free.bestResponse[1]).toBe(locked.bestResponse[1]);
    });
  }

  it("lets the unfrozen hands of a partly frozen node adapt", () => {
    const game = kuhnGame();
    const free = new Solver(game);
    free.iterate(2000);
    const solver = new Solver(game);
    // Only J is frozen, at an always-bet bluff; Q and K adapt.
    solver.freeze(game.tree.root, [0, 0, 0, 1, 0, 0], [1, 0, 0]);
    solver.iterate(2000);
    const root = solver.averageStrategy(game.tree.root);
    expect(root[3]).toBe(1);
    expect(root[0]).toBe(0);
    // Against a J that always bluffs, player 1 calls Q more; K's bet stays a value bet, Q's check stays.
    const facing = solver.averageStrategy(nodeAt(game.tree, ["b"]));
    const freeFacing = free.averageStrategy(nodeAt(game.tree, ["b"]));
    expect(facing[3 + 1]).toBeGreaterThan(freeFacing[3 + 1] + 0.3);
    expect(root[5]).toBeGreaterThan(0.99);
    expect(solver.exploitability().exploitability).toBeLessThan(2e-3);
  });

  it("gives the opponent the exploit lab's best response against a frozen strategy", () => {
    const game = leducGame();
    const solver = new Solver(game);
    solver.iterate(400);
    const node = nodeAt(game.tree, ["k"]);
    expect(game.tree.player[node]).toBe(1);
    const count = game.tree.childCount[node];
    const n = game.hands[1].size;
    const reach = ownReach(solver, 1).get(node) as Float64Array;
    const order = Array.from({ length: n }, (_, i) => i);
    const lock = { node, group: [1], share: 0.8, order, fallback: 0 };
    const lab = exploitLab(solver, 0, [lock]);
    // The same lock as a frozen node: player 0's best response to it.
    const strategy = lockedStrategy(solver.averageStrategy(node), count, n, reach, lock);
    solver.freeze(node, strategy);
    expect(solver.bestResponse(0).value).toBeCloseTo(lab.bestVsLock, 12);
    expect(solver.value(0)).toBeCloseTo(lab.equilibriumVsLock, 12);
    solver.unfreezeAll();
    expect(solver.frozenNodes).toEqual([]);
  });

  it("refuses a strategy of the wrong shape", () => {
    const game = kuhnGame();
    const solver = new Solver(game);
    expect(() => solver.freeze(game.tree.root, [1, 0])).toThrow(/expected 2 x 3/);
    expect(() => solver.freeze(nodeAt(game.tree, ["k", "k"]), [1])).toThrow(/not an action node/);
  });
});

describe("combos and hands", () => {
  it("map 1,326-combo rows onto a hand list and back", () => {
    const hands = Uint16Array.from([parseCombo("AsKs"), parseCombo("7h7d"), parseCombo("2c3c")]);
    const values = new Float64Array(NUM_COMBOS);
    hands.forEach((c, i) => (values[c] = i + 1));
    expect(Array.from(combosToHands(values, hands))).toEqual([1, 2, 3]);
    expect(Array.from(handsToCombos([1, 2, 3], hands))).toEqual(Array.from(values));
    const rows = [values, Float64Array.from(values, (x) => x * 10)];
    const block = comboRowsToHands(rows, hands);
    expect(Array.from(block)).toEqual([1, 2, 3, 10, 20, 30]);
    expect(handRowsToCombos(block, 2, hands)).toEqual(rows.map((r) => Array.from(r)));
  });
});

describe("the lock model", () => {
  const set: LockSet = {
    version: 1,
    spot: { set: "s", line: "btn-bb", flop: "Ks8s2d" },
    nodes: [],
    earlier: "player",
    targetPct: 1,
  };

  it("hashes the canonical JSON with SHA-256", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("a".repeat(1000)))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: null }] })).toBe('{"a":[1,{"c":null,"d":2}],"b":1}');
    const reordered = { targetPct: 1, earlier: "player", nodes: [], spot: { flop: "Ks8s2d", line: "btn-bb", set: "s" }, version: 1 } as LockSet;
    expect(lockHash(reordered)).toBe(lockHash(set));
    expect(lockHash({ ...set, targetPct: 2.5 })).not.toBe(lockHash(set));
    expect(lockHash(set)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cuts a path at its deals", () => {
    expect(splitLockPath("X-B5")).toEqual({ flop: "X-B5", inner: "X-B5" });
    expect(splitLockPath("X-X~Kd/B2.5")).toEqual({ flop: "X-X", turn: "Kd", inner: "B2.5" });
    expect(splitLockPath("~Kd/")).toEqual({ flop: "", turn: "Kd", inner: "" });
    expect(splitLockPath("X-X~Kd/X-X|7h|X")).toEqual({ flop: "X-X", turn: "Kd", river: "7h", inner: "X-X|7h|X" });
    expect(lockPathOf("X-X", "Kd", "B2.5")).toBe("X-X~Kd/B2.5");
  });

  it("keeps the suit relabellings a lock is invariant under", () => {
    const uniform = (count: number) => Array.from({ length: count }, () => new Array<number>(NUM_COMBOS).fill(1 / count));
    const node = (strategy: number[][], locked: number[]): NodeLockSpec => ({ street: "flop", path: "", player: 0, actions: ["X", "B5"], strategy, locked });
    const all = new Array<number>(NUM_COMBOS).fill(1);
    // Ks 8s 2d: hearts and clubs swap.
    expect(lockSymmetries({ ...set, nodes: [node(uniform(2), all)] }, ["Ks", "8s", "2d"])).toHaveLength(2);
    const one = new Array<number>(NUM_COMBOS).fill(0);
    one[parseCombo("AhQh")] = 1;
    expect(lockSymmetries({ ...set, nodes: [node(uniform(2), one)] }, ["Ks", "8s", "2d"])).toEqual([[0, 1, 2, 3]]);
    // A turn lock below a heart turn card keeps nothing a heart moves under.
    expect(lockSymmetries({ ...set, nodes: [{ ...node(uniform(2), all), street: "turn", path: "X-X~7h/" }] }, ["Ks", "8s", "2d"])).toEqual([[0, 1, 2, 3]]);
  });
});

const HALF: BetMenu = { bet: [0.5], raise: [], allIn: false };
const BET_75: BetMenu = { bet: [0.75], raise: [], allIn: true, allInMaxPot: 3 };
const CHECK_ONLY: BetMenu = { bet: [], raise: [], allIn: false };

/** A small flop game for locked solves: flop bets of half the pot, a raise, turn bets, a checked river. */
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

/** The small spot's "library chunk": its unlocked solve. */
function baselineChunk(): FlopChunk {
  const solved = solveFlop(SPOT, { maxIterations: 60, targetExploitability: 0, checkEvery: 60, dcfr: FLOP_PROFILE.dcfr });
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
  return { header, result: solved.result };
}

/** A lock of a chunk node at a fixed per-combo strategy (`pick` decides each combo's action), every combo locked. */
function lockOf(chunk: FlopChunk, path: string, pick: (combo: number) => number): NodeLockSpec {
  const node = chunk.result.nodes.find((n) => n.kind === "action" && n.path === path);
  if (!node) throw new Error(`no node ${path}`);
  const strategy = node.labels.map(() => new Array<number>(NUM_COMBOS).fill(0));
  for (let c = 0; c < NUM_COMBOS; c += 1) strategy[pick(c)][c] = 1;
  return { street: "flop", path, player: node.player as 0 | 1, actions: node.labels, strategy, locked: new Array<number>(NUM_COMBOS).fill(1) };
}

function nodeOf(result: SolveResult, path: string) {
  const node = result.nodes.find((n) => n.kind === "action" && n.path === path);
  if (!node) throw new Error(`no node ${path}`);
  return node;
}

describe("a locked flop solve", () => {
  const chunk = baselineChunk();
  const root = chunk.result.nodes[0];
  const check = root.labels.indexOf("X");
  const ipAfterCheck = chunk.result.nodes[root.children[check]];
  const bet = ipAfterCheck.labels.findIndex((l) => l.startsWith("B"));
  const facing = chunk.result.nodes[ipAfterCheck.children[bet]];
  // OOP facing a bet after checking: OOP always folds.
  const fold = facing.labels.indexOf("F");
  const lockSet = (earlier: LockSet["earlier"]): LockSet => ({
    version: 1,
    spot: { set: "test", line: "btn-bb", flop: "Ks8s2d" },
    nodes: [lockOf(chunk, facing.path, () => fold)],
    earlier,
    targetPct: 1,
  });

  it("freezes the earlier nodes at the baseline: the locked player's, both, or none", () => {
    for (const [earlier, frozen] of [["none", []], ["player", [""]], ["all", ["", ipAfterCheck.path]]] as const) {
      const solved = solveNodelock({ street: "flop", spot: SPOT }, lockSet(earlier), { baseline: chunk, maxIterations: 30 });
      const result = solved.result;
      for (const path of ["", ipAfterCheck.path]) {
        const was = nodeOf(chunk.result, path).strategy;
        const now = nodeOf(result, path).strategy;
        let diff = 0;
        for (let k = 0; k < was.length; k += 1) diff = Math.max(diff, Math.abs(was[k] - now[k]));
        if ((frozen as readonly string[]).includes(path)) expect(diff, `${earlier}: ${path || "root"} frozen`).toBeLessThan(1e-6);
        else expect(diff, `${earlier}: ${path || "root"} adapts`).toBeGreaterThan(0.05);
      }
      // The lock itself holds exactly.
      const locked = nodeOf(result, facing.path);
      const n = result.hands[locked.player].length;
      for (let i = 0; i < n; i += 1) expect(locked.strategy[fold * n + i]).toBe(1);
      expect(decodeChunk(solved.chunk).header.lockHash).toBe(lockHash(lockSet(earlier)));
    }
  });

  it("split over parts is bit-identical to the sequential reference", () => {
    const set = lockSet("all");
    const sequential = solveNodelock({ street: "flop", spot: SPOT }, set, { baseline: chunk, maxIterations: 9 });
    const how = nodelockFlopRun(set, 9);
    const spec = { spot: SPOT, dcfr: how.dcfr, storage: "i16" as const };
    const probe = new SplitCoordinator(spec, []);
    for (const count of [2, 5]) {
      const parts = splitCards(probe.built, count).map((cards) => new SplitPart(spec, cards));
      const coordinator = new SplitCoordinator(spec, parts.map((p) => p.valueSum));
      checkBaseline(coordinator.built, chunk);
      applyNodelock(coordinator.built, coordinator.solver, set, { baseline: chunkBaseline(chunk, coordinator.built) });
      const run = driveSync(coordinator.run(how), parts);
      const result = driveSync(coordinator.result(run, 0), parts);
      expect(result.exploitability).toBe(sequential.result.exploitability);
      sequential.result.nodes.forEach((node, k) => {
        expect(Array.from(result.nodes[k].strategy)).toEqual(Array.from(node.strategy));
        expect(Array.from(result.nodes[k].ev)).toEqual(Array.from(node.ev));
      });
    }
  });

  it("goes on from a warm solver", () => {
    const first = solveNodelock({ street: "flop", spot: SPOT }, lockSet("player"), { baseline: chunk, maxIterations: 30 });
    const warm = solveNodelock({ street: "flop", spot: SPOT }, lockSet("all"), { baseline: chunk, maxIterations: NODELOCK_WARM_ITERATION + 20, warm: first.warm });
    expect(warm.stats.iterations).toBe(NODELOCK_WARM_ITERATION + 20);
    expect(warm.solver).toBe(first.solver);
    // The warm solve's own locks: "all" now freezes the IP check node too.
    const was = nodeOf(chunk.result, ipAfterCheck.path).strategy;
    const now = nodeOf(warm.result, ipAfterCheck.path).strategy;
    for (let k = 0; k < was.length; k += 1) expect(Math.abs(was[k] - now[k])).toBeLessThan(1e-6);
  });

  it("refuses a lock whose actions are not the tree's", () => {
    const set = lockSet("none");
    set.nodes[0] = { ...set.nodes[0], actions: ["F", "C", "R9"] };
    expect(() => solveNodelock({ street: "flop", spot: SPOT }, set, { baseline: chunk, maxIterations: 2 })).toThrow(NodelockError);
  });
});

describe("a locked turn solve", () => {
  it("re-solves the deal's turn game with the lock and returns a turn chunk", () => {
    const chunk = baselineChunk();
    const root = chunk.result.nodes[0];
    const xx = chunk.result.nodes[chunk.result.nodes[root.children[root.labels.indexOf("X")]].children[0]];
    expect(xx.kind).toBe("chance");
    const card = xx.labels[0];
    // The turn game's root (OOP first) after the flop checked through: OOP always bets.
    const probe: LockSet = { version: 1, spot: { set: "test", line: "btn-bb", flop: "Ks8s2d", turn: card }, nodes: [], earlier: "player", targetPct: 1 };
    const turnSpot = nodelockTurnSpot(chunk, { ...probe, nodes: [{ street: "turn", path: `${xx.path}~${card}/`, player: 0, actions: [], strategy: [], locked: [] }] });
    const tree = buildTurnGame(turnSpot.spot).game.tree;
    const actions = tree.edgeLabel.slice(tree.childStart[tree.root], tree.childStart[tree.root] + tree.childCount[tree.root]);
    const betAt = actions.findIndex((l) => l.startsWith("B"));
    const strategy = actions.map((_, a) => new Array<number>(NUM_COMBOS).fill(a === betAt ? 1 : 0));
    const set: LockSet = {
      ...probe,
      nodes: [{ street: "turn", path: `${xx.path}~${card}/`, player: 0, actions, strategy, locked: new Array<number>(NUM_COMBOS).fill(1) }],
    };
    const solved = solveNodelock(turnSpot, set, { baseline: chunk, maxIterations: 40 });
    const decoded = decodeChunk(solved.chunk);
    expect(decoded.header.lockHash).toBe(lockHash(set));
    expect(decoded.result.street).toBe("turn");
    expect(decoded.result.scope).toBe("all");
    const turnRoot = decoded.result.nodes[0];
    const bet = turnRoot.labels.findIndex((l) => l.startsWith("B"));
    expect(turnRoot.frequency[bet]).toBeCloseTo(1, 4);
    // River decisions are there for the view.
    expect(decoded.result.nodes.some((n) => n.street === "river" && n.kind === "action")).toBe(true);
  });
});
