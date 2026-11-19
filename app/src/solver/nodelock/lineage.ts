/**
 * Locks on locks (`docs/NODELOCK.md` §7.4): what a new lock made inside an
 * open one solves, and where its row goes. Pure: no store, no engine.
 *
 * ```
 * the node's game (the flop, or one turn card with its rivers)
 *   same game as a lock in the chain ─▶ that lock's nodes + the new one, on its base; its child
 *   a turn under a flop lock          ─▶ only the new node, `base` = that flop lock; its child
 *   neither                           ─▶ only the new node, on the library; a new root
 * ```
 *
 * The chain is the open lock, then its ancestors to the root. The first lock
 * in it that fits wins, so the open lock's own game comes first, then a flop
 * ancestor's. Edit lock and Remove this lock make a **sibling** of the lock
 * that owns the node (same parent, same base).
 *
 * The editor's footer line is a value (`LockFooter`); its words are the
 * app's i18n.
 *
 * **Range locks** (§9.3) are the flop game's: a flop lock made in the chain
 * carries its owner's ranges unless the editor sets its own
 * (`LockSettings.ranges`). New ranges under a turn node need the flop solved
 * first: `planRangeLock` plans that flop, and the turn lock is then planned
 * on it (`pendingRef`).
 */
import type { LockEarlier, LockSet, NodeLockSpec } from "./contract";
import type { NodeLockRow } from "./data";
import { lockGameStreet, readLockSet, splitLockPath, withLockRanges, type LockBase, type RangeLock } from "./engine/door";

/** A stored lock with its lock set read. */
export interface LockRef {
  row: NodeLockRow;
  set: LockSet;
}

/**
 * How the plan relates to the open lock (the §7.4 table's rows):
 * - `same`: the new node is in the open lock's game; its nodes + the new one;
 * - `later`: a turn under the open flop lock, solved from its result;
 * - `earlier`: the plan goes back up the chain (a flop node under a turn lock,
 *   or a turn card other than the open turn lock's): to the ancestor of that
 *   game, the flop ancestor's result, or the library;
 * - `root`: no lock open, a lock on the library;
 * - `sibling`: Edit lock / Remove this lock, beside the lock that owns the node.
 */
export type LockPlanKind = "same" | "later" | "earlier" | "root" | "sibling";

/** The game a solve re-solves: "flop", or "turn" (one turn card and its rivers). */
export type LockGame = "flop" | "turn";

/** What the editor's footer says the solve will be, one quiet line. */
export type LockFooter =
  /** "Adds to *parent*'s flop locks: the flop is solved again." */
  | { kind: "adds"; parent: string; street: LockGame }
  /** "Builds on *parent*: the turn is solved from its result." */
  | { kind: "builds"; parent: string }
  /** A new lock on the library's solve. */
  | { kind: "library"; street: LockGame }
  /** Edit lock / Remove this lock: a new lock beside *of*, the game solved again. */
  | { kind: "sibling"; of: string; street: LockGame };

export interface LockPlan {
  /** The new row's `parent_id`: null on the library (a root). */
  parentId: string | null;
  /** The row whose result chunk the set is solved on (`set.base`); null: the library chunk. */
  baseRowId: string | null;
  /** The new row's `folder_id`: a root's folder, null for a child. */
  folderId: string | null;
  set: LockSet;
  kind: LockPlanKind;
  footer: LockFooter;
}

/** The editor's run settings; default: the lock the plan adds to, else "player" and 1 %. */
export interface LockSettings {
  earlier: LockEarlier;
  targetPct: number;
  /**
   * A flop lock's starting ranges (§9): undefined keeps the owner's, null or
   * empty clears them. Ignored for a turn game (its ranges are its base's).
   */
  ranges?: RangeLock[] | null;
}

/** A node's game: `flop`, or `turn:<flop deal path>~<turn card>`. */
export function nodeGame(spec: Pick<NodeLockSpec, "street" | "path">): string {
  if (spec.street === "flop") return "flop";
  const { flop, turn } = splitLockPath(spec.path);
  return `turn:${flop}~${turn ?? ""}`;
}

/** A lock set's game (`nodeGame` of its nodes; `lockGameStreet` checks they share it). A ranges-only set is the flop's. */
export function setGame(set: LockSet): string {
  lockGameStreet(set);
  return set.nodes.length ? nodeGame(set.nodes[0]) : "flop";
}

const streetOf = (game: string): LockGame => (game === "flop" ? "flop" : "turn");

/** `nodes` with `spec` in place of the node at its path, or added after them. */
export function withNode(nodes: readonly NodeLockSpec[], spec: NodeLockSpec): NodeLockSpec[] {
  const at = nodes.findIndex((node) => node.path === spec.path);
  return at < 0 ? [...nodes, spec] : nodes.map((node, k) => (k === at ? spec : node));
}

/**
 * The spot of a set of `nodes` near `at` (the new node's spot as the editor
 * builds it): the flop for a flop game; the turn card for a turn game, and
 * the river only when every node is on that river.
 */
function spotOf(at: LockSet["spot"], nodes: readonly NodeLockSpec[]): LockSet["spot"] {
  const spot: LockSet["spot"] = { set: at.set, line: at.line, flop: at.flop };
  if (!nodes.length) return spot;
  const first = splitLockPath(nodes[0].path);
  if (nodes[0].street === "flop" || !first.turn) return spot;
  spot.turn = first.turn;
  const rivers = new Set(nodes.map((node) => splitLockPath(node.path).river ?? ""));
  const river = rivers.size === 1 ? [...rivers][0] : "";
  if (river) spot.river = river;
  return spot;
}

function lockSetOf(at: LockSet["spot"], nodes: NodeLockSpec[], settings: LockSettings, base: LockBase | undefined, ranges?: readonly RangeLock[] | null): LockSet {
  const set: LockSet = { version: 1, spot: spotOf(at, nodes), nodes, earlier: settings.earlier, targetPct: settings.targetPct };
  if (base) set.base = base;
  // Ranges are the flop game's (§9): a turn game's come from its base.
  const flop = !nodes.length || nodes.every((node) => node.street === "flop");
  return flop ? withLockRanges(set, ranges) : set;
}

/** The ranges a flop lock gets: the editor's (`settings.ranges`, null clears), else the owner's. */
function rangesFor(settings: Partial<LockSettings> | undefined, owner: LockSet | null): RangeLock[] | undefined {
  if (settings?.ranges !== undefined) return settings.ranges ?? undefined;
  return owner?.ranges;
}

/** The row holding a base's chunk: the first in `chain` with its hash. */
function baseRowOf(base: LockBase | undefined, chain: readonly LockRef[]): string | null {
  if (!base) return null;
  const row = chain.find((lock) => lock.row.lock_hash === base.lockHash);
  if (!row) throw new Error(`the base ${base.lockHash.slice(0, 12)} is not in the lock's chain`);
  return row.row.id;
}

/** The folder a new root made from inside `chain` goes to: its root's. */
function rootFolder(chain: readonly LockRef[]): string | null {
  return chain.length ? (chain[chain.length - 1].row.folder_id ?? null) : null;
}

/**
 * The lock a new node makes inside the open lock (§7.4's table). `open` null:
 * the library (a root). `ancestors`: the open lock's chain to the root,
 * nearest first (`lockChain`). `at`: the new node's spot, as the editor
 * builds it. `spec`: the new node (one already in the set replaces it).
 */
export function planChildLock(
  open: LockRef | null,
  ancestors: readonly LockRef[],
  at: LockSet["spot"],
  spec: NodeLockSpec,
  settings?: Partial<LockSettings>,
): LockPlan {
  const chain = open ? [open, ...ancestors] : [];
  const game = nodeGame(spec);
  const street = streetOf(game);

  const owner = chain.findIndex((lock) => setGame(lock.set) === game);
  if (owner >= 0) {
    const lock = chain[owner];
    const run = { earlier: settings?.earlier ?? lock.set.earlier, targetPct: settings?.targetPct ?? lock.set.targetPct };
    return {
      parentId: lock.row.id,
      baseRowId: baseRowOf(lock.set.base, chain.slice(owner + 1)),
      folderId: null,
      set: lockSetOf(at, withNode(lock.set.nodes, spec), run, lock.set.base, rangesFor(settings, lock.set)),
      kind: owner === 0 ? "same" : "earlier",
      footer: { kind: "adds", parent: lock.row.name, street },
    };
  }
  const run = { earlier: settings?.earlier ?? "player", targetPct: settings?.targetPct ?? 1 };
  if (street === "turn") {
    const flop = chain.findIndex((lock) => setGame(lock.set) === "flop");
    if (flop >= 0) {
      const lock = chain[flop];
      return {
        parentId: lock.row.id,
        baseRowId: lock.row.id,
        folderId: null,
        set: lockSetOf(at, [spec], run, { lockHash: lock.row.lock_hash, street: "flop" }),
        kind: flop === 0 ? "later" : "earlier",
        footer: { kind: "builds", parent: lock.row.name },
      };
    }
  }
  return {
    parentId: null,
    baseRowId: null,
    folderId: rootFolder(chain),
    set: lockSetOf(at, [spec], run, undefined, rangesFor(settings, null)),
    kind: open ? "earlier" : "root",
    footer: { kind: "library", street },
  };
}

/** A sibling of `chain[owner]` (same parent, same base, root: same folder) locking `nodes`. */
function siblingOf(chain: readonly LockRef[], owner: number, at: LockSet["spot"], nodes: NodeLockSpec[], settings?: Partial<LockSettings>): LockPlan {
  const lock = chain[owner];
  const parent = chain[owner + 1] ?? null;
  const run = { earlier: settings?.earlier ?? lock.set.earlier, targetPct: settings?.targetPct ?? lock.set.targetPct };
  return {
    parentId: parent?.row.id ?? null,
    baseRowId: baseRowOf(lock.set.base, chain.slice(owner + 1)),
    folderId: parent ? null : (lock.row.folder_id ?? null),
    set: lockSetOf(at, nodes, run, lock.set.base, rangesFor(settings, lock.set)),
    kind: "sibling",
    footer: { kind: "sibling", of: lock.row.name, street: streetOf(setGame(lock.set)) },
  };
}

/**
 * Edit lock (§7.3–7.4): the lock that owns `spec`'s node (the open one, or
 * an ancestor for an inherited lock) again with `spec` in place of its
 * node, as a sibling of that lock. Null when no lock in the chain is in
 * that game.
 */
export function planEditLock(
  open: LockRef,
  ancestors: readonly LockRef[],
  at: LockSet["spot"],
  spec: NodeLockSpec,
  settings?: Partial<LockSettings>,
): LockPlan | null {
  const chain = [open, ...ancestors];
  const game = nodeGame(spec);
  const owner = chain.findIndex((lock) => setGame(lock.set) === game);
  return owner < 0 ? null : siblingOf(chain, owner, at, withNode(chain[owner].set.nodes, spec), settings);
}

/**
 * Remove this lock (§7.3–7.4): the lock that owns the node at `path` without
 * it, as a sibling of that lock. Null when no lock in the chain locks it, or
 * it is that lock's only node (the action is disabled).
 */
export function planRemoveLock(open: LockRef, ancestors: readonly LockRef[], path: string): LockPlan | null {
  const chain = [open, ...ancestors];
  const owner = chain.findIndex((lock) => lock.set.nodes.some((node) => node.path === path));
  if (owner < 0) return null;
  const nodes = chain[owner].set.nodes.filter((node) => node.path !== path);
  // With ranges of its own, the lock without its last node is a ranges-only lock (§9.3).
  return nodes.length || chain[owner].set.ranges?.length ? siblingOf(chain, owner, chain[owner].set.spot, nodes) : null;
}

/**
 * The starting ranges of the flop the open view shows (§9.3): the first
 * flop-game lock in the chain's (`open`, then its ancestors), or undefined
 * (the chart's: the library, or a lock without range locks).
 */
export function chainRanges(open: LockRef | null, ancestors: readonly LockRef[]): RangeLock[] | undefined {
  if (!open) return undefined;
  for (const lock of [open, ...ancestors]) {
    if (setGame(lock.set) === "flop") return lock.set.ranges;
  }
  return undefined;
}

/**
 * New starting ranges on their own (§9.3): the chain's flop owner's nodes
 * with `ranges`, as its child (`same` when it is the open lock, else
 * `earlier`); with no flop lock in the chain, a ranges-only lock on the
 * library (`root`, or `earlier` from inside a lock: the root's folder). Null
 * when it would change nothing (the same ranges, nothing locked).
 */
export function planRangeLock(
  open: LockRef | null,
  ancestors: readonly LockRef[],
  at: LockSet["spot"],
  ranges: RangeLock[] | null,
  settings?: Partial<Omit<LockSettings, "ranges">>,
): LockPlan | null {
  const chain = open ? [open, ...ancestors] : [];
  const flop: LockSet["spot"] = { set: at.set, line: at.line, flop: at.flop };
  const owner = chain.findIndex((lock) => setGame(lock.set) === "flop");
  if (owner >= 0) {
    const lock = chain[owner];
    const run = { earlier: settings?.earlier ?? lock.set.earlier, targetPct: settings?.targetPct ?? lock.set.targetPct };
    const set = lockSetOf(flop, lock.set.nodes, run, lock.set.base, ranges);
    if (!set.nodes.length && !set.ranges) return null;
    return {
      parentId: lock.row.id,
      baseRowId: baseRowOf(lock.set.base, chain.slice(owner + 1)),
      folderId: null,
      set,
      kind: owner === 0 ? "same" : "earlier",
      footer: { kind: "adds", parent: lock.row.name, street: "flop" },
    };
  }
  if (!ranges?.length) return null;
  const run = { earlier: settings?.earlier ?? "player", targetPct: settings?.targetPct ?? 1 };
  return {
    parentId: null,
    baseRowId: null,
    folderId: rootFolder(chain),
    set: lockSetOf(flop, [], run, undefined, ranges),
    kind: open ? "earlier" : "root",
    footer: { kind: "library", street: "flop" },
  };
}

/** The `parentId` / `baseRowId` of a row not saved yet: the session swaps it for the row's id once saved (`SolveRequest.chainKey`). */
export const PENDING = "pending:";

/** A plan's ids with `pending:<key>` swapped for the saved row's id (`saved`: key → id); null when one is not saved (its solve could not start). */
export function resolvePlan<T extends Pick<LockPlan, "parentId" | "baseRowId" | "folderId">>(plan: T, saved: ReadonlyMap<string, string>): T | null {
  const resolve = (id: string | null): string | null | undefined => (id?.startsWith(PENDING) ? saved.get(id.slice(PENDING.length)) : id);
  const parentId = resolve(plan.parentId);
  const baseRowId = resolve(plan.baseRowId);
  if (parentId === undefined || baseRowId === undefined) return null;
  return { ...plan, parentId, baseRowId };
}

/**
 * A planned lock that is not saved yet, as a `LockRef` for planning the lock
 * that builds on it (a turn lock on new ranges, §9.3): its row id is
 * `pending:<key>`, its hash the plan's set's.
 */
export function pendingRef(plan: LockPlan, key: string, name: string, lockHash: string): LockRef {
  const row = { id: `${PENDING}${key}`, name, lock_hash: lockHash, lock_json: plan.set, parent_id: plan.parentId, folder_id: plan.folderId, status: "solving" } as unknown as NodeLockRow;
  return { row, set: plan.set };
}

/** The lock in the chain that locks the node at `path` (an inherited lock's owner), or null. */
export function lockOwner(open: LockRef, ancestors: readonly LockRef[], path: string): LockRef | null {
  return [open, ...ancestors].find((lock) => lock.set.nodes.some((node) => node.path === path)) ?? null;
}

/** A sibling's name: `<name> (2)`, or the next number free among `taken`. */
export function siblingName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const stem = name.replace(/ \(\d+\)$/, "");
  for (let n = 2; ; n += 1) {
    const next = `${stem} (${n})`;
    if (!used.has(next)) return next;
  }
}

/**
 * A lock and its ancestors from the store's rows (`nodelockList`), nearest
 * first, by `parent_id`: `[open, parent, …, root]`. A row whose lock does
 * not read ends the chain; null when `id` is not among them.
 */
export function lockChain(rows: readonly NodeLockRow[], id: string): LockRef[] | null {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const chain: LockRef[] = [];
  const seen = new Set<string>();
  for (let at: string | null | undefined = id; at && !seen.has(at); at = byId.get(at)?.parent_id) {
    seen.add(at);
    const row = byId.get(at);
    const set = row ? readLockSet(row.lock_json) : null;
    if (!row || !set) break;
    chain.push({ row, set });
  }
  return chain.length && chain[0].row.id === id ? chain : null;
}
