/**
 * My nodelocks' tree (`docs/NODELOCK.md` §7.1), pure: the folders and the
 * locks built into one tree, the rows it shows, search, selection and the
 * drop rules. No React, no store: `tests/test/appNodelockTree.test.ts`.
 *
 * ```
 * folder ─▶ subfolders and root locks (a lock made on the library), in `sort` order
 * lock   ─▶ the locks built on it (`parent_id`), always under it
 * ```
 *
 * A key names a row across both kinds: `f:<id>` a folder, `l:<id>` a lock.
 */

export type ItemKind = "lock" | "folder";

export interface ItemRef {
  kind: ItemKind;
  id: string;
}

export interface FolderLike {
  id: string;
  name: string;
  parent_id: string | null;
  sort: number;
}

export interface LockLike {
  id: string;
  name: string;
  folder_id: string | null;
  parent_id: string | null;
  sort: number;
}

export type TreeNode<L extends LockLike = LockLike, F extends FolderLike = FolderLike> =
  | { kind: "folder"; id: string; key: string; item: F; parent: string | null; children: TreeNode<L, F>[] }
  | { kind: "lock"; id: string; key: string; item: L; parent: string | null; children: TreeNode<L, F>[] };

export interface Tree<L extends LockLike = LockLike, F extends FolderLike = FolderLike> {
  roots: TreeNode<L, F>[];
  /** Every node by its key. */
  byKey: Map<string, TreeNode<L, F>>;
}

export function keyOf(ref: ItemRef): string {
  return `${ref.kind === "folder" ? "f" : "l"}:${ref.id}`;
}

export function refOf(key: string): ItemRef {
  return { kind: key.startsWith("f:") ? "folder" : "lock", id: key.slice(2) };
}

/** Siblings in the user's order: `sort`, then folders before locks, then the id (as the store orders them). */
function bySort<L extends LockLike, F extends FolderLike>(a: TreeNode<L, F>, b: TreeNode<L, F>): number {
  if (a.item.sort !== b.item.sort) return a.item.sort - b.item.sort;
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The tree. A folder whose parent is gone (or that would sit inside itself)
 * goes to the top level; so does a lock whose parent lock or folder is gone.
 * A lock with a parent ignores its own `folder_id`: it moves with its root.
 */
export function buildTree<L extends LockLike, F extends FolderLike>(folders: readonly F[], locks: readonly L[]): Tree<L, F> {
  const byKey = new Map<string, TreeNode<L, F>>();
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const lockById = new Map(locks.map((lock) => [lock.id, lock]));
  for (const item of folders) byKey.set(`f:${item.id}`, { kind: "folder", id: item.id, key: `f:${item.id}`, item, parent: null, children: [] });
  for (const item of locks) byKey.set(`l:${item.id}`, { kind: "lock", id: item.id, key: `l:${item.id}`, item, parent: null, children: [] });

  // A chain that comes back on itself is broken where it is entered.
  const folderParent = (folder: F): string | null => {
    const seen = new Set([folder.id]);
    let at = folder.parent_id;
    while (at !== null) {
      if (seen.has(at)) return null;
      const up = folderById.get(at);
      if (!up) return null;
      seen.add(at);
      at = up.parent_id;
    }
    return folder.parent_id;
  };
  const lockParent = (lock: L): string | null => {
    if (lock.parent_id !== null) {
      const seen = new Set([lock.id]);
      let at: string | null = lock.parent_id;
      let ok = true;
      while (at !== null) {
        const up = lockById.get(at);
        if (seen.has(at) || !up) {
          ok = false;
          break;
        }
        seen.add(at);
        at = up.parent_id;
      }
      if (ok) return `l:${lock.parent_id}`;
    }
    return lock.folder_id !== null && folderById.has(lock.folder_id) ? `f:${lock.folder_id}` : null;
  };

  const roots: TreeNode<L, F>[] = [];
  for (const node of byKey.values()) {
    const parent = node.kind === "folder" ? (folderParent(node.item) === null ? null : `f:${node.item.parent_id}`) : lockParent(node.item);
    node.parent = parent;
    if (parent === null) roots.push(node);
    else byKey.get(parent)!.children.push(node);
  }
  const order = (list: TreeNode<L, F>[]) => {
    list.sort(bySort);
    for (const node of list) order(node.children);
  };
  order(roots);
  return { roots, byKey };
}

/** A lock built on another lock: it stays under its parent. */
export function isChildLock<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, key: string): boolean {
  const node = tree.byKey.get(key);
  return node?.kind === "lock" && node.parent !== null && node.parent.startsWith("l:");
}

/** The keys above `key`, nearest first. */
export function ancestors<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, key: string): string[] {
  const out: string[] = [];
  let at = tree.byKey.get(key)?.parent ?? null;
  while (at !== null) {
    out.push(at);
    at = tree.byKey.get(at)?.parent ?? null;
  }
  return out;
}

/** Whether `key` is `of` or anywhere under it. */
export function within<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, key: string, of: string): boolean {
  return key === of || ancestors(tree, key).includes(of);
}

export interface Visible<L extends LockLike = LockLike, F extends FolderLike = FolderLike> {
  node: TreeNode<L, F>;
  depth: number;
  open: boolean;
}

/** The rows shown, top to bottom: a node's children only while it is open. */
export function visibleRows<L extends LockLike, F extends FolderLike>(
  roots: readonly TreeNode<L, F>[],
  isOpen: (key: string) => boolean,
): Visible<L, F>[] {
  const out: Visible<L, F>[] = [];
  const walk = (list: readonly TreeNode<L, F>[], depth: number) => {
    for (const node of list) {
      const open = node.children.length > 0 && isOpen(node.key);
      out.push({ node, depth, open });
      if (open) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/**
 * Search: the nodes whose text holds every word of `query` (any case), with
 * their ancestors so each match keeps its place. A match's own children show
 * only when they match too. An empty query keeps everything.
 */
export function filterTree<L extends LockLike, F extends FolderLike>(
  roots: readonly TreeNode<L, F>[],
  query: string,
  text: (node: TreeNode<L, F>) => string,
): TreeNode<L, F>[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...roots];
  const keep = (list: readonly TreeNode<L, F>[]): TreeNode<L, F>[] => {
    const out: TreeNode<L, F>[] = [];
    for (const node of list) {
      const children = keep(node.children);
      const own = text(node).toLowerCase();
      if (children.length || words.every((word) => own.includes(word))) out.push({ ...node, children });
    }
    return out;
  };
  return keep(roots);
}

/** Every key in the trees given (for a filtered tree: all open). */
export function allKeys<L extends LockLike, F extends FolderLike>(roots: readonly TreeNode<L, F>[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeNode<L, F>[]) => {
    for (const node of list) {
      out.push(node.key);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** Shift-click: the shown rows from `anchor` to `key`, both included (just `key` when the anchor is not shown). */
export function rangeKeys(rows: readonly { node: { key: string } }[], anchor: string | null, key: string): string[] {
  const keys = rows.map((row) => row.node.key);
  const to = keys.indexOf(key);
  const from = anchor === null ? -1 : keys.indexOf(anchor);
  if (to < 0) return [];
  if (from < 0) return [key];
  return keys.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** The chosen keys without those under another chosen key (they go with it). */
export function topmost<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, keys: Iterable<string>): string[] {
  const chosen = new Set([...keys].filter((key) => tree.byKey.has(key)));
  return [...chosen].filter((key) => !ancestors(tree, key).some((up) => chosen.has(up)));
}

/** What a delete of these keys sends to the store: the topmost locks and folders. */
export function deleteArgs<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, keys: Iterable<string>): { locks: string[]; folders: string[] } {
  const top = topmost(tree, keys).map(refOf);
  return { locks: top.filter((ref) => ref.kind === "lock").map((ref) => ref.id), folders: top.filter((ref) => ref.kind === "folder").map((ref) => ref.id) };
}

/** Every lock that goes with these keys: theirs and all under them. */
export function locksUnder<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, keys: Iterable<string>): L[] {
  const out: L[] = [];
  const walk = (node: TreeNode<L, F>) => {
    if (node.kind === "lock") out.push(node.item);
    node.children.forEach(walk);
  };
  for (const key of topmost(tree, keys)) {
    const node = tree.byKey.get(key);
    if (node) walk(node);
  }
  return out;
}

/** Where a dragged row is let go: on a row's upper or lower edge, into a folder, or the empty area (the top level). */
export type DropAt = { kind: "before" | "after" | "into"; key: string } | { kind: "top" };

/**
 * Where the moved items land: a folder (null: the top level) and the item
 * they go before; `before` null is the top of that folder, `atEnd` its
 * bottom (after the last item not being moved).
 */
export interface Landing {
  folder_id: string | null;
  before: ItemRef | null;
  atEnd: boolean;
}

/**
 * Whether these keys can move at all: nothing unknown, and no child lock
 * (it stays under its parent) unless its parent's branch moves too.
 */
export function canMove<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => tree.byKey.has(key)) && topmost(tree, keys).every((key) => !isChildLock(tree, key));
}

/** The children of a folder (null: the top level). */
function childrenOf<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, folder: string | null): TreeNode<L, F>[] {
  if (folder === null) return tree.roots;
  return tree.byKey.get(`f:${folder}`)?.children ?? [];
}

/**
 * The drop rules (§7.1): a lock or folder onto a folder moves it in (to the
 * top); onto a row's edge, beside that row; onto the empty area, to the end
 * of the top level. Refused (null): a child lock dragged anywhere, a folder
 * into itself or under itself, a drop among a lock's children, a drop that
 * changes nothing.
 */
export function planDrop<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, keys: readonly string[], at: DropAt): Landing | null {
  if (!canMove(tree, keys)) return null;
  const moving = topmost(tree, keys);
  const movingSet = new Set(moving);
  const insideMoving = (key: string) => moving.some((top) => within(tree, key, top));

  const landing = (folder: string | null, before: ItemRef | null, atEnd: boolean): Landing | null => {
    if (folder !== null && insideMoving(`f:${folder}`)) return null;
    // Nothing would change: the moved items already sit there, in this order.
    const siblings = childrenOf(tree, folder).map((node) => node.key);
    const rest = siblings.filter((key) => !movingSet.has(key));
    const index = before === null ? (atEnd ? rest.length : 0) : rest.indexOf(keyOf(before));
    const after = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
    if (after.length === siblings.length && after.every((key, i) => key === siblings[i])) return null;
    return { folder_id: folder, before, atEnd: before === null && atEnd };
  };

  if (at.kind === "top") return landing(null, null, true);
  const target = tree.byKey.get(at.key);
  if (!target) return null;
  if (at.kind === "into") {
    if (target.kind !== "folder") return null;
    return landing(target.id, null, false);
  }
  // Beside a row: only among a folder's (or the top level's) items.
  if (isChildLock(tree, target.key)) return null;
  if (insideMoving(target.key) && !movingSet.has(target.key)) return null;
  const folder = target.parent === null ? null : refOf(target.parent).id;
  const siblings = childrenOf(tree, folder);
  if (at.kind === "before") {
    // Before a moved row: before the next one that stays.
    const from = siblings.findIndex((node) => node.key === target.key);
    const next = siblings.slice(from).find((node) => !movingSet.has(node.key));
    return next ? landing(folder, refOf(next.key), false) : landing(folder, null, true);
  }
  const from = siblings.findIndex((node) => node.key === target.key);
  const next = siblings.slice(from + 1).find((node) => !movingSet.has(node.key));
  return next ? landing(folder, refOf(next.key), false) : landing(folder, null, true);
}

/** The folder a new folder made "here" goes into: the folder itself, a lock's folder, or the top level. */
export function folderHere<L extends LockLike, F extends FolderLike>(tree: Tree<L, F>, key: string | null): string | null {
  if (key === null) return null;
  const node = tree.byKey.get(key);
  if (!node) return null;
  if (node.kind === "folder") return node.id;
  const up = [node.key, ...ancestors(tree, node.key)].find((k) => k.startsWith("f:"));
  return up ? refOf(up).id : null;
}

/** Move to…'s choices: the top level, then every folder (indented by depth) the items may go into. */
export function folderChoices<L extends LockLike, F extends FolderLike>(
  tree: Tree<L, F>,
  keys: readonly string[],
): { id: string | null; name: string; depth: number }[] {
  const moving = topmost(tree, keys);
  const out: { id: string | null; name: string; depth: number }[] = [{ id: null, name: "", depth: 0 }];
  const walk = (list: readonly TreeNode<L, F>[], depth: number) => {
    for (const node of list) {
      if (node.kind !== "folder" || moving.includes(node.key)) continue;
      out.push({ id: node.id, name: node.item.name, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(tree.roots, 1);
  return out;
}

/**
 * A lock's board as cards: the flop, and the turn (and river) of a lock made
 * there. `Qs6h3d` + `Kd` → `["Qs", "6h", "3d", "Kd"]`.
 */
export function boardCards(row: { flop: string; turn: string | null; river: string | null; street: string }): string[] {
  const cards: string[] = [];
  for (let i = 0; i + 1 < row.flop.length; i += 2) cards.push(row.flop.slice(i, i + 2));
  if (row.street !== "flop" && row.turn) cards.push(row.turn);
  if (row.street === "river" && row.river) cards.push(row.river);
  return cards;
}
