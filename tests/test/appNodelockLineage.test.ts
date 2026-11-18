/**
 * Locks on locks (`app/src/solver/nodelock/lineage.ts`, `docs/NODELOCK.md`
 * §7.4): what a lock made inside an open one solves, where its row goes, and
 * the siblings Edit lock and Remove this lock make.
 */
import { describe, expect, it } from "vitest";

import type { NodeLockRow } from "../../app/src/lib/ipc";
import { lockChain, lockOwner, nodeGame, planChildLock, planEditLock, planRemoveLock, siblingName, type LockRef } from "../../app/src/solver/nodelock/lineage";
import { lockHash, NUM_COMBOS, type LockSet, type NodeLockSpec } from "../../web/src/lib/solver/index";

const SPOT = { set: "nlhe-cash-6max-100bb", line: "btn-bb", flop: "Qs6h3d" };

function node(street: NodeLockSpec["street"], path: string, action = 0): NodeLockSpec {
  const strategy = [0, 1].map((a) => new Array<number>(NUM_COMBOS).fill(a === action ? 1 : 0));
  return { street, path, player: 0, actions: ["X", "B2.5"], strategy, locked: new Array<number>(NUM_COMBOS).fill(1) };
}

let next = 0;
function lock(name: string, set: LockSet, parent: LockRef | null = null, folder: string | null = null): LockRef {
  next += 1;
  const row = {
    id: `row-${next}`,
    name,
    lock_hash: lockHash(set),
    lock_json: set,
    parent_id: parent?.row.id ?? null,
    folder_id: folder,
    status: "solved",
  } as unknown as NodeLockRow;
  return { row, set };
}

const flopSet = (nodes: NodeLockSpec[], base?: LockSet["base"]): LockSet => ({ version: 1, spot: SPOT, nodes, earlier: "player", targetPct: 1, ...(base ? { base } : {}) });
const turnSet = (nodes: NodeLockSpec[], base?: LockSet["base"], river?: string): LockSet => ({
  version: 1,
  spot: { ...SPOT, turn: "Kd", ...(river ? { river } : {}) },
  nodes,
  earlier: "player",
  targetPct: 1,
  ...(base ? { base } : {}),
});

const FLOP_A = node("flop", "X-B1.82");
const FLOP_B = node("flop", "X");
const TURN_A = node("turn", "X-X~Kd/X");
const TURN_B = node("turn", "X-X~Kd/X-B2.5");
const RIVER = node("river", "X-X~Kd/X-X|7h|X");
const OTHER_TURN = node("turn", "X-X~Qh/X");

describe("planChildLock (§7.4)", () => {
  it("on the library: a root with the node alone", () => {
    const plan = planChildLock(null, [], SPOT, FLOP_A);
    expect(plan).toEqual({
      parentId: null,
      baseRowId: null,
      folderId: null,
      set: flopSet([FLOP_A]),
      kind: "root",
      footer: { kind: "library", street: "flop" },
    });
    expect(planChildLock(null, [], { ...SPOT, turn: "Kd" }, TURN_A, { earlier: "all", targetPct: 2.5 }).set).toEqual({ ...turnSet([TURN_A]), earlier: "all", targetPct: 2.5 });
  });

  it("same game: the open lock's nodes and the new one, its child, on the same base", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]));
    const plan = planChildLock(passive, [], SPOT, FLOP_B);
    expect(plan.kind).toBe("same");
    expect(plan.parentId).toBe(passive.row.id);
    expect(plan.baseRowId).toBeNull();
    expect(plan.folderId).toBeNull();
    expect(plan.set).toEqual(flopSet([FLOP_A, FLOP_B]));
    expect(plan.set.base).toBeUndefined();
    expect(plan.footer).toEqual({ kind: "adds", parent: "Passive BB", street: "flop" });
  });

  it("same game: re-locking a node replaces its spec in place", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A, FLOP_B]));
    const edited = node("flop", FLOP_A.path, 1);
    expect(planChildLock(passive, [], SPOT, edited).set.nodes).toEqual([edited, FLOP_B]);
  });

  it("later game: a turn under a flop lock is built on its result", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]));
    const plan = planChildLock(passive, [], { ...SPOT, turn: "Kd" }, TURN_A);
    expect(plan.kind).toBe("later");
    expect(plan.parentId).toBe(passive.row.id);
    expect(plan.baseRowId).toBe(passive.row.id);
    expect(plan.set).toEqual(turnSet([TURN_A], { lockHash: passive.row.lock_hash, street: "flop" }));
    expect(plan.footer).toEqual({ kind: "builds", parent: "Passive BB" });
    // A river counts as the turn's game: built on the flop lock too.
    expect(planChildLock(passive, [], { ...SPOT, turn: "Kd", river: "7h" }, RIVER).set).toEqual(turnSet([RIVER], { lockHash: passive.row.lock_hash, street: "flop" }, "7h"));
  });

  it("same game under a based turn lock: its nodes, the same base (the flop ancestor)", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]));
    const on = { lockHash: passive.row.lock_hash, street: "flop" as const };
    const turn = lock("Turn stab", turnSet([TURN_A], on), passive);
    const plan = planChildLock(turn, [passive], { ...SPOT, turn: "Kd" }, TURN_B);
    expect(plan.kind).toBe("same");
    expect(plan.parentId).toBe(turn.row.id);
    expect(plan.baseRowId).toBe(passive.row.id);
    expect(plan.set).toEqual(turnSet([TURN_A, TURN_B], on));
    expect(plan.footer).toEqual({ kind: "adds", parent: "Turn stab", street: "turn" });
    // A river of that turn: the same game, the river dropped from the spot (two streets locked).
    const river = planChildLock(turn, [passive], { ...SPOT, turn: "Kd", river: "7h" }, RIVER);
    expect(river.set.nodes).toEqual([TURN_A, RIVER]);
    expect(river.set.spot).toEqual({ ...SPOT, turn: "Kd" });
  });

  it("earlier game: the flop ancestor's nodes and the new one, its child", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]), null, "folder-1");
    const on = { lockHash: passive.row.lock_hash, street: "flop" as const };
    const turn = lock("Turn stab", turnSet([TURN_A], on), passive);
    const plan = planChildLock(turn, [passive], SPOT, FLOP_B);
    expect(plan.kind).toBe("earlier");
    expect(plan.parentId).toBe(passive.row.id);
    expect(plan.baseRowId).toBeNull();
    expect(plan.folderId).toBeNull();
    expect(plan.set).toEqual(flopSet([FLOP_A, FLOP_B]));
    expect(plan.footer).toEqual({ kind: "adds", parent: "Passive BB", street: "flop" });
  });

  it("earlier game on the library: a new root, in the chain's folder", () => {
    const turn = lock("Turn stab", turnSet([TURN_A]), null, "folder-1");
    const plan = planChildLock(turn, [], SPOT, FLOP_A);
    expect(plan).toEqual({ parentId: null, baseRowId: null, folderId: "folder-1", set: flopSet([FLOP_A]), kind: "earlier", footer: { kind: "library", street: "flop" } });
  });

  it("another turn card under a turn lock: built on the flop ancestor, or on the library", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]));
    const on = { lockHash: passive.row.lock_hash, street: "flop" as const };
    const turn = lock("Turn stab", turnSet([TURN_A], on), passive);
    const plan = planChildLock(turn, [passive], { ...SPOT, turn: "Qh" }, OTHER_TURN);
    expect(plan.kind).toBe("earlier");
    expect(plan.parentId).toBe(passive.row.id);
    expect(plan.baseRowId).toBe(passive.row.id);
    expect(plan.set).toEqual({ ...turnSet([OTHER_TURN], on), spot: { ...SPOT, turn: "Qh" } });
    expect(plan.footer).toEqual({ kind: "builds", parent: "Passive BB" });

    const plain = lock("Turn stab", turnSet([TURN_A]));
    const root = planChildLock(plain, [], { ...SPOT, turn: "Qh" }, OTHER_TURN);
    expect(root.parentId).toBeNull();
    expect(root.set.base).toBeUndefined();
    expect(root.footer).toEqual({ kind: "library", street: "turn" });
  });

  it("deeper chains: a flop lock on a flop lock, a turn on it, a flop node from there", () => {
    const one = lock("One", flopSet([FLOP_A]));
    const two = lock("Two", flopSet([FLOP_A, FLOP_B]), one);
    const turn = planChildLock(two, [one], { ...SPOT, turn: "Kd" }, TURN_A);
    expect(turn.baseRowId).toBe(two.row.id);
    expect(turn.set.base).toEqual({ lockHash: two.row.lock_hash, street: "flop" });
    const t = lock("Turn", turn.set, two);
    const back = planChildLock(t, [two, one], SPOT, node("flop", "X-B1.82-R5"));
    expect(back.parentId).toBe(two.row.id);
    expect(back.set.nodes.map((n) => n.path)).toEqual(["X-B1.82", "X", "X-B1.82-R5"]);
  });

  it("the run settings: given, else the lock it adds to, else player and 1 %", () => {
    const passive = lock("Passive BB", { ...flopSet([FLOP_A]), earlier: "all", targetPct: 2.5 });
    expect(planChildLock(passive, [], SPOT, FLOP_B).set).toMatchObject({ earlier: "all", targetPct: 2.5 });
    expect(planChildLock(passive, [], SPOT, FLOP_B, { earlier: "none" }).set).toMatchObject({ earlier: "none", targetPct: 2.5 });
    expect(planChildLock(passive, [], { ...SPOT, turn: "Kd" }, TURN_A).set).toMatchObject({ earlier: "player", targetPct: 1 });
  });

  it("refuses a base that is not in the chain", () => {
    const orphan = lock("Orphan", turnSet([TURN_A], { lockHash: "f".repeat(64), street: "flop" }));
    expect(() => planChildLock(orphan, [], { ...SPOT, turn: "Kd" }, TURN_B)).toThrow(/not in the lock's chain/);
  });
});

describe("Edit lock and Remove this lock: siblings (§7.3–7.4)", () => {
  it("edit: the open lock's set with the node replaced, beside it", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]), null, "folder-1");
    const on = { lockHash: passive.row.lock_hash, street: "flop" as const };
    const turn = lock("Turn stab", turnSet([TURN_A, TURN_B], on), passive);
    const edited = node("turn", TURN_A.path, 1);
    const plan = planEditLock(turn, [passive], { ...SPOT, turn: "Kd" }, edited);
    expect(plan).toEqual({
      parentId: passive.row.id,
      baseRowId: passive.row.id,
      folderId: null,
      set: turnSet([edited, TURN_B], on),
      kind: "sibling",
      footer: { kind: "sibling", of: "Turn stab", street: "turn" },
    });
  });

  it("edit an inherited lock: a sibling of the lock that owns it", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A]), null, "folder-1");
    const turn = lock("Turn stab", turnSet([TURN_A], { lockHash: passive.row.lock_hash, street: "flop" }), passive);
    const edited = node("flop", FLOP_A.path, 1);
    const plan = planEditLock(turn, [passive], SPOT, edited);
    expect(plan).toMatchObject({ parentId: null, baseRowId: null, folderId: "folder-1", set: flopSet([edited]), footer: { kind: "sibling", of: "Passive BB", street: "flop" } });
    expect(lockOwner(turn, [passive], FLOP_A.path)).toBe(passive);
    expect(planEditLock(lock("Flop", flopSet([FLOP_A])), [], { ...SPOT, turn: "Kd" }, TURN_A)).toBeNull();
  });

  it("remove: the owner without the node, beside it; none when it is the only node", () => {
    const passive = lock("Passive BB", flopSet([FLOP_A, FLOP_B]));
    const plan = planRemoveLock(passive, [], FLOP_A.path);
    expect(plan?.set).toEqual(flopSet([FLOP_B]));
    expect(plan?.parentId).toBeNull();
    expect(plan?.kind).toBe("sibling");
    expect(planRemoveLock(lock("One", flopSet([FLOP_A])), [], FLOP_A.path)).toBeNull();
    expect(planRemoveLock(passive, [], "X-B9")).toBeNull();
    // A child's sibling keeps its parent.
    const child = lock("Child", flopSet([FLOP_A, FLOP_B]), lock("Root", flopSet([FLOP_A])));
    const root = lock("Root", flopSet([FLOP_A]));
    expect(planRemoveLock(child, [root], FLOP_B.path)?.parentId).toBe(root.row.id);
  });

  it("names a sibling <name> (2), or the next free number", () => {
    expect(siblingName("Passive BB")).toBe("Passive BB (2)");
    expect(siblingName("Passive BB", ["Passive BB (2)"])).toBe("Passive BB (3)");
    expect(siblingName("Passive BB (2)", ["Passive BB (2)"])).toBe("Passive BB (3)");
  });
});

describe("lockChain and nodeGame", () => {
  it("walks parent_id from the open lock to the root", () => {
    const a = lock("A", flopSet([FLOP_A]));
    const b = lock("B", flopSet([FLOP_A, FLOP_B]), a);
    const c = lock("C", turnSet([TURN_A], { lockHash: b.row.lock_hash, street: "flop" }), b);
    const rows = [c.row, a.row, b.row];
    expect(lockChain(rows, c.row.id)?.map((l) => l.row.name)).toEqual(["C", "B", "A"]);
    expect(lockChain(rows, a.row.id)?.map((l) => l.row.name)).toEqual(["A"]);
    expect(lockChain(rows, "missing")).toBeNull();
    // A cycle ends.
    const loop = [{ ...a.row, parent_id: b.row.id }, b.row];
    expect(lockChain(loop, a.row.id)?.map((l) => l.row.name)).toEqual(["A", "B"]);
  });

  it("names a node's game: the flop, or one deal's turn with its rivers", () => {
    expect(nodeGame(FLOP_A)).toBe("flop");
    expect(nodeGame(TURN_A)).toBe("turn:X-X~Kd");
    expect(nodeGame(RIVER)).toBe("turn:X-X~Kd");
    expect(nodeGame(OTHER_TURN)).not.toBe(nodeGame(TURN_A));
  });
});
