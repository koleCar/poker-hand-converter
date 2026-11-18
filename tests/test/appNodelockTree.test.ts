/**
 * My nodelocks' tree (`app/src/solver/nodelock/tree/model.ts`,
 * `docs/NODELOCK.md` §7.1): folders and locks built into one tree, child
 * locks under their parent, the user's order, search keeping ancestors,
 * selection ranges, delete arguments and the drop rules.
 */
import { describe, expect, it } from "vitest";

import {
  allKeys,
  boardCards,
  buildTree,
  canMove,
  deleteArgs,
  filterTree,
  folderChoices,
  folderHere,
  locksUnder,
  planDrop,
  rangeKeys,
  topmost,
  visibleRows,
  type FolderLike,
  type LockLike,
  type TreeNode,
} from "../../app/src/solver/nodelock/tree/model.js";

const folder = (id: string, sort: number, parent_id: string | null = null, name = id): FolderLike => ({ id, name, parent_id, sort });
const lock = (id: string, sort: number, extra: Partial<LockLike> = {}): LockLike => ({
  id,
  name: id,
  folder_id: null,
  parent_id: null,
  sort,
  ...extra,
});

/**
 * ```
 * A (folder)            sort 1
 *   A1 (folder)         sort 1
 *     x                 sort 1
 *   p                   sort 2
 *     c1 (child of p)   sort 2
 *       g (child of c1)
 *     c2 (child of p)   sort 1
 * r                     sort 0
 * s                     sort 2
 * ```
 */
const FOLDERS = [folder("A", 1), folder("A1", 1, "A")];
const LOCKS = [
  lock("r", 0),
  lock("s", 2),
  lock("p", 2, { folder_id: "A" }),
  lock("x", 1, { folder_id: "A1" }),
  lock("c1", 2, { parent_id: "p", folder_id: "elsewhere" }),
  lock("c2", 1, { parent_id: "p" }),
  lock("g", 0, { parent_id: "c1" }),
];
const tree = () => buildTree(FOLDERS, LOCKS);
const shape = (roots: readonly TreeNode[]): unknown => roots.map((node) => (node.children.length ? { [node.key]: shape(node.children) } : node.key));

describe("buildTree", () => {
  it("nests folders, root locks in folders and child locks under their parent, in sort order", () => {
    expect(shape(tree().roots)).toEqual([
      "l:r",
      { "f:A": [{ "f:A1": ["l:x"] }, { "l:p": ["l:c2", { "l:c1": ["l:g"] }] }] },
      "l:s",
    ]);
  });

  it("puts folders before locks on equal sort", () => {
    const t = buildTree([folder("F", 0, null, "zzz")], [lock("a", 0)]);
    expect(t.roots.map((node) => node.key)).toEqual(["f:F", "l:a"]);
  });

  it("sends orphans and cycles to the top level", () => {
    const t = buildTree(
      [folder("loop1", 0, "loop2"), folder("loop2", 1, "loop1"), folder("lost", 2, "gone")],
      [lock("a", 3, { parent_id: "missing" }), lock("b", 4, { folder_id: "gone" }), lock("c", 5, { parent_id: "d" }), lock("d", 6, { parent_id: "c" })],
    );
    expect(t.roots.map((node) => node.key)).toEqual(["f:loop1", "f:loop2", "f:lost", "l:a", "l:b", "l:c", "l:d"]);
  });
});

describe("visibleRows", () => {
  it("shows a node's children only while it is open, with depth", () => {
    const open = new Set(["f:A", "l:p"]);
    const rows = visibleRows(tree().roots, (key) => open.has(key));
    expect(rows.map((row) => `${row.depth}${row.node.key}${row.open ? "+" : ""}`)).toEqual([
      "0l:r",
      "0f:A+",
      "1f:A1",
      "1l:p+",
      "2l:c2",
      "2l:c1",
      "0l:s",
    ]);
  });
});

describe("filterTree", () => {
  const text = (node: TreeNode) => node.item.name;
  it("keeps the matches and their ancestors only", () => {
    expect(shape(filterTree(tree().roots, "g", text))).toEqual([{ "f:A": [{ "l:p": [{ "l:c1": ["l:g"] }] }] }]);
  });
  it("needs every word, any case", () => {
    const t = buildTree([], [lock("a", 0, { name: "Passive BB" }), lock("b", 1, { name: "Passive BTN" })]);
    expect(allKeys(filterTree(t.roots, "bb PASSIVE", text))).toEqual(["l:a"]);
  });
  it("keeps everything for an empty query", () => {
    expect(allKeys(filterTree(tree().roots, "  ", text))).toHaveLength(9);
  });
});

describe("selection", () => {
  it("rangeKeys spans the shown rows between the anchor and the click", () => {
    const rows = visibleRows(tree().roots, () => true);
    expect(rangeKeys(rows, "l:x", "l:c2")).toEqual(["l:x", "l:p", "l:c2"]);
    expect(rangeKeys(rows, "l:c2", "l:x")).toEqual(["l:x", "l:p", "l:c2"]);
    expect(rangeKeys(rows, null, "l:s")).toEqual(["l:s"]);
  });
  it("topmost drops what goes with a chosen ancestor", () => {
    expect(topmost(tree(), ["f:A", "l:x", "l:g", "l:s", "nope"]).sort()).toEqual(["f:A", "l:s"]);
  });
  it("deleteArgs splits the topmost into locks and folders", () => {
    expect(deleteArgs(tree(), ["f:A1", "l:x", "l:c1", "l:r"])).toEqual({ locks: ["l:c1", "l:r"].map((k) => k.slice(2)), folders: ["A1"] });
  });
  it("locksUnder lists every lock that goes, branches included", () => {
    expect(locksUnder(tree(), ["f:A"]).map((l) => l.id).sort()).toEqual(["c1", "c2", "g", "p", "x"]);
  });
});

describe("planDrop", () => {
  it("moves a lock or folder into a folder, to its top", () => {
    expect(planDrop(tree(), ["l:r"], { kind: "into", key: "f:A1" })).toEqual({ folder_id: "A1", before: null, atEnd: false });
    expect(planDrop(tree(), ["f:A1"], { kind: "top" })).toEqual({ folder_id: null, before: null, atEnd: true });
  });
  it("reorders beside a row", () => {
    expect(planDrop(tree(), ["l:s"], { kind: "before", key: "l:r" })).toEqual({ folder_id: null, before: { kind: "lock", id: "r" }, atEnd: false });
    expect(planDrop(tree(), ["l:r"], { kind: "after", key: "f:A" })).toEqual({ folder_id: null, before: { kind: "lock", id: "s" }, atEnd: false });
    expect(planDrop(tree(), ["l:r"], { kind: "after", key: "l:s" })).toEqual({ folder_id: null, before: null, atEnd: true });
    // Beside a row in a folder: into that folder.
    expect(planDrop(tree(), ["l:s"], { kind: "after", key: "f:A1" })).toEqual({ folder_id: "A", before: { kind: "lock", id: "p" }, atEnd: false });
  });
  it("refuses a child lock, wherever it goes", () => {
    expect(canMove(tree(), ["l:c1"])).toBe(false);
    expect(planDrop(tree(), ["l:c1"], { kind: "top" })).toBeNull();
    expect(planDrop(tree(), ["l:r", "l:g"], { kind: "into", key: "f:A" })).toBeNull();
  });
  it("moves a child lock chosen along with its root (it goes with the branch)", () => {
    expect(canMove(tree(), ["l:p", "l:c1", "l:g"])).toBe(true);
    expect(planDrop(tree(), ["l:p", "l:c1"], { kind: "top" })).toEqual({ folder_id: null, before: null, atEnd: true });
  });
  it("refuses a folder into itself or under itself, and a drop among a lock's children", () => {
    expect(planDrop(tree(), ["f:A"], { kind: "into", key: "f:A" })).toBeNull();
    expect(planDrop(tree(), ["f:A"], { kind: "into", key: "f:A1" })).toBeNull();
    expect(planDrop(tree(), ["f:A"], { kind: "before", key: "l:x" })).toBeNull();
    expect(planDrop(tree(), ["l:r"], { kind: "before", key: "l:c2" })).toBeNull();
    expect(planDrop(tree(), ["l:r"], { kind: "into", key: "l:p" })).toBeNull();
  });
  it("refuses a drop that changes nothing", () => {
    expect(planDrop(tree(), ["l:r"], { kind: "before", key: "f:A" })).toBeNull();
    expect(planDrop(tree(), ["l:s"], { kind: "top" })).toBeNull();
    expect(planDrop(tree(), ["f:A1"], { kind: "into", key: "f:A" })).toBeNull();
    expect(planDrop(tree(), ["l:r"], { kind: "before", key: "l:r" })).toBeNull();
  });
  it("moves several rows together, those under a moved folder with it", () => {
    expect(planDrop(tree(), ["l:r", "l:s", "f:A1", "l:x"], { kind: "into", key: "f:A" })).toEqual({ folder_id: "A", before: null, atEnd: false });
  });
});

describe("folders for New folder here and Move to…", () => {
  it("folderHere: the folder, a lock's nearest folder, or the top level", () => {
    expect(folderHere(tree(), "f:A1")).toBe("A1");
    expect(folderHere(tree(), "l:g")).toBe("A");
    expect(folderHere(tree(), "l:r")).toBeNull();
    expect(folderHere(tree(), null)).toBeNull();
  });
  it("folderChoices leaves out the moved folders and their subfolders", () => {
    expect(folderChoices(tree(), ["l:r"]).map((c) => `${c.depth}${c.id}`)).toEqual(["0null", "1A", "2A1"]);
    expect(folderChoices(tree(), ["f:A1"]).map((c) => c.id)).toEqual([null, "A"]);
    expect(folderChoices(tree(), ["f:A"]).map((c) => c.id)).toEqual([null]);
  });
});

describe("boardCards", () => {
  it("is the flop, plus the turn and river of a lock made there", () => {
    expect(boardCards({ flop: "Qs6h3d", turn: null, river: null, street: "flop" })).toEqual(["Qs", "6h", "3d"]);
    expect(boardCards({ flop: "Qs6h3d", turn: "Kd", river: null, street: "turn" })).toEqual(["Qs", "6h", "3d", "Kd"]);
    expect(boardCards({ flop: "Qs6h3d", turn: "Kd", river: "2c", street: "river" })).toEqual(["Qs", "6h", "3d", "Kd", "2c"]);
  });
});
