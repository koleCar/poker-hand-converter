/**
 * The nodelock model (`docs/NODELOCK.md` §1): what a user locked, as plain
 * data the desktop app stores and hashes, and how a lock becomes frozen
 * nodes in a solve (`Solver.freeze`, §2.1).
 *
 * ```
 * LockSet (1,326-combo rows per locked node, earlier-node option, target)
 *   ─ lockSymmetries ─▶ the suit relabellings the lock keeps (isomorphism stays exact)
 *   ─ applyNodelock ──▶ Solver.freeze at each locked node, and at its ancestors
 *                       (earlier: "player" / "all") at the baseline strategy
 *   ─ nodelockHeader ─▶ the result chunk's header, `lockHash` in it
 * ```
 *
 * **Addresses.** A flop node is named by its path in the flop chunk
 * (`SolvedNode.path`, `X-B1.82`). A turn or river node by the flop chunk's
 * deal path, the turn card and its path in the deal's turn game (the live
 * turn's result): `X-X~Kd/B2.5` is the turn decision after a bet on the
 * `Kd` turn of the checked-through flop, `X-X~Kd/X-X|7h|X` a river one
 * (`lockPathOf`, `splitLockPath`).
 *
 * Library code with no UI: the app imports it through `@rail/web-lib`, and
 * no web page imports it. Same import rule as the rest of `lib/solver`.
 */

import type { Solver } from "./cfr";
import { combosToHands, comboRowsToHands, NUM_COMBOS, parseCards } from "./combos";
import type { FlopChunk, FlopChunkHeader } from "./flopLibrary";
import { utf8Encode } from "./format";
import { boardSymmetries, permuteCard, permuteCombo } from "./isomorphism";
import type { BuiltSubgame } from "./subgame";
import { ACTION } from "./tree";
import { cardIndex } from "../equity";

/** GTOW's three "Apply" options for the nodes before a locked one; default `"player"`. */
export type LockEarlier = "none" | "player" | "all";

export interface NodeLockSpec {
  street: "flop" | "turn" | "river";
  /** The node's address as the Solver library's view names it: the same `node` (and `turn`/`river` cards) the route uses. */
  path: string;
  /** 0 = out of position, as in the chunk. */
  player: 0 | 1;
  /** The node's action labels, so a tree mismatch is caught. */
  actions: string[];
  /** [action][combo] over the 1,326 canonical combos (`combos.ts` order); rows sum to 1 where locked. */
  strategy: number[][];
  /** 1,326 flags: 1 = this combo's strategy is fixed; 0 = it adapts in the solve (GTOW: "unlocked hands adapt"). */
  locked: number[];
}

export interface LockSet {
  version: 1;
  spot: { set: string; line: string; flop: string; turn?: string; river?: string };
  /** One or more nodes, either player. */
  nodes: NodeLockSpec[];
  /** Freeze the ancestors' strategies at the baseline solve. */
  earlier: LockEarlier;
  /** 1 = standard, 2.5 = quick. */
  targetPct: number;
}

/** A lock that does not fit the game it is applied to (another tree, a node that is not there). */
export class NodelockError extends Error {}

/* -------------------------------------------------------------- hash - */

/** The canonical JSON of a value: object keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return `[${Array.from(value as ArrayLike<unknown>, (x) => canonicalJson(x)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 hex of a lock set's canonical JSON: the same lock always hashes the same. */
export function lockHash(set: LockSet): string {
  return sha256Hex(utf8Encode(canonicalJson(set)));
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of some bytes, hex. Synchronous: `crypto.subtle` is not. */
export function sha256Hex(data: Uint8Array): string {
  const bitLength = data.length * 8;
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6));
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(off + 4 * t);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K256[t] + w[t]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/* ------------------------------------------------------------- paths - */

const TURN = /^(.*?)~([2-9TJQKA][cdhs])\/(.*)$/;
const RIVER = /\|([2-9TJQKA][cdhs])\|/;

/**
 * A lock path cut at its deals: the flop part, then the turn card and the
 * path after it in the turn game (`inner`), then the river card (dealt
 * inside `inner`).
 */
export function splitLockPath(path: string): { flop: string; turn?: string; river?: string; inner: string } {
  const turn = TURN.exec(path);
  if (!turn) return { flop: path, inner: path };
  const inner = turn[3];
  const river = RIVER.exec(inner);
  return { flop: turn[1], turn: turn[2], ...(river ? { river: river[1] } : {}), inner };
}

/** The lock path of a turn-game node: the flop deal's path, the turn card, the node's path in the turn game (`X-X~Kd/B2.5`). */
export function lockPathOf(flopDeal: string, turn: string, turnPath: string): string {
  return `${flopDeal}~${turn}/${turnPath}`;
}

/** The street a lock set re-solves from: "flop" (the flop game) or "turn" (the turn game of one deal). */
export function lockGameStreet(set: LockSet): "flop" | "turn" {
  if (!set.nodes.length) throw new NodelockError("a lock set locks at least one node");
  const streets = new Set(set.nodes.map((n) => (n.street === "flop" ? "flop" : "turn")));
  if (streets.size > 1) throw new NodelockError("a lock set locks one street's game: the flop, or one turn and its rivers");
  const street = [...streets][0] as "flop" | "turn";
  if (street === "turn") {
    const deals = new Set(set.nodes.map((n) => {
      const parts = splitLockPath(n.path);
      if (!parts.turn) throw new NodelockError(`${n.street} lock ${n.path} names no turn card`);
      return `${parts.flop}|${parts.turn}`;
    }));
    if (deals.size > 1) throw new NodelockError("turn and river locks share one flop line and turn card");
  }
  return street;
}

/* -------------------------------------------------------- isomorphism - */

const TOLERANCE = 1e-9;

/**
 * The suit relabellings of the board a lock set is invariant under: each
 * fixes the cards dealt on the way to every locked node, and maps every
 * locked node's strategy and flags onto themselves. A game built with only
 * these (`FlopSpot.symmetry`, `TurnSpot.symmetry`) stays exact with the
 * locks in it; a lock on one specific suited combo just costs the
 * isomorphism's saving.
 */
export function lockSymmetries(set: LockSet, board: readonly (string | number)[]): number[][] {
  const group = boardSymmetries(board);
  return group.filter((perm) =>
    set.nodes.every((node) => {
      const { turn, river } = splitLockPath(node.path);
      for (const card of [turn, river]) {
        if (card && permuteCard(cardIndex(card), perm) !== cardIndex(card)) return false;
      }
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        const d = permuteCombo(c, perm);
        if ((node.locked[c] ? 1 : 0) !== (node.locked[d] ? 1 : 0)) return false;
        if (!node.locked[c]) continue;
        for (const row of node.strategy) {
          if (Math.abs(row[c] - row[d]) > TOLERANCE) return false;
        }
      }
      return true;
    }),
  );
}

/* ------------------------------------------------------------ freezing - */

/** What `applyNodelock` froze: tree node ids. */
export interface AppliedLocks {
  /** The locked nodes, in `set.nodes` order. */
  locked: number[];
  /** The earlier nodes frozen at the baseline, ascending. */
  earlier: number[];
}

/** An earlier node's baseline strategy, `[action][hand]` over the game's hands; null when there is none. */
export type BaselineStrategy = (node: number) => ArrayLike<number> | null;

/** Action nodes by path (`BuiltSubgame.info`). */
function nodesByPath(built: BuiltSubgame): Map<string, number> {
  const out = new Map<string, number>();
  built.info.forEach((info, node) => {
    if (info && built.game.tree.type[node] === ACTION) out.set(info.path, node);
  });
  return out;
}

/** Each node's parent (-1 at the root). */
function parents(built: BuiltSubgame): Int32Array {
  const tree = built.game.tree;
  const out = new Int32Array(tree.size).fill(-1);
  for (let node = 0; node < tree.size; node += 1) {
    const start = tree.childStart[node];
    for (let e = start; e < start + tree.childCount[node]; e += 1) out[tree.children[e]] = node;
  }
  return out;
}

/**
 * Freezes a lock set in a solver of `built` (the flop game for flop locks,
 * the deal's turn game for turn and river locks): each locked node's locked
 * hands at their strategy, and per `set.earlier` the decisions on the way to
 * it at `baseline`. `pathOf` gives a lock's path in this game (identity for
 * the flop game, `splitLockPath(...).inner` for a turn game).
 *
 * Throws `NodelockError` when a node is not in the game or its actions are
 * not the lock's. An earlier node without a baseline throws too: freezing it
 * at anything else would change the range that reaches the lock.
 */
export function applyNodelock(
  built: BuiltSubgame,
  solver: Solver,
  set: LockSet,
  options: { pathOf?: (spec: NodeLockSpec) => string; baseline?: BaselineStrategy } = {},
): AppliedLocks {
  const tree = built.game.tree;
  const byPath = nodesByPath(built);
  const pathOf = options.pathOf ?? ((spec: NodeLockSpec) => spec.path);
  const locked: number[] = [];
  for (const spec of set.nodes) {
    const path = pathOf(spec);
    const node = byPath.get(path);
    if (node === undefined) throw new NodelockError(`no decision at ${spec.path} in this game`);
    if (tree.player[node] !== spec.player) throw new NodelockError(`${spec.path}: player ${tree.player[node]} acts here, not ${spec.player}`);
    const start = tree.childStart[node];
    const labels = tree.edgeLabel.slice(start, start + tree.childCount[node]);
    if (labels.length !== spec.actions.length || labels.some((label, a) => label !== spec.actions[a])) {
      throw new NodelockError(`${spec.path}: the tree has ${labels.join(" ")}, the lock ${spec.actions.join(" ")}`);
    }
    if (spec.strategy.length !== labels.length || spec.locked.length !== NUM_COMBOS || spec.strategy.some((row) => row.length !== NUM_COMBOS)) {
      throw new NodelockError(`${spec.path}: a lock is ${labels.length} rows of ${NUM_COMBOS} combos and ${NUM_COMBOS} flags`);
    }
    const hands = built.combos[spec.player];
    solver.freeze(node, comboRowsToHands(spec.strategy, hands), combosToHands(spec.locked, hands));
    locked.push(node);
  }

  const earlier = earlierNodes(built, set, locked);
  for (const node of earlier) {
    const strategy = options.baseline?.(node) ?? null;
    if (!strategy) throw new NodelockError(`no baseline strategy for the earlier node ${built.info[node]?.path ?? node}`);
    solver.freeze(node, strategy);
  }
  return { locked, earlier };
}

/** The tree nodes of a lock set's locked nodes in `built` (`applyNodelock`'s addresses), without freezing anything. */
export function lockedNodes(built: BuiltSubgame, set: LockSet, pathOf: (spec: NodeLockSpec) => string = (spec) => spec.path): number[] {
  const byPath = nodesByPath(built);
  return set.nodes.map((spec) => {
    const node = byPath.get(pathOf(spec));
    if (node === undefined) throw new NodelockError(`no decision at ${spec.path} in this game`);
    return node;
  });
}

/**
 * The decisions `set.earlier` freezes on the way to the locked nodes
 * (`locked`, tree ids in `set.nodes` order): "player" the locked player's
 * own, "all" both players'; never a locked node itself. Ascending.
 */
export function earlierNodes(built: BuiltSubgame, set: LockSet, locked: readonly number[]): number[] {
  const tree = built.game.tree;
  const earlier = new Set<number>();
  if (set.earlier !== "none") {
    const parent = parents(built);
    locked.forEach((node, k) => {
      const player = set.nodes[k].player;
      for (let at = parent[node]; at >= 0; at = parent[at]) {
        if (tree.type[at] !== ACTION || locked.includes(at)) continue;
        if (set.earlier === "all" || tree.player[at] === player) earlier.add(at);
      }
    });
  }
  return [...earlier].sort((a, b) => a - b);
}

/**
 * A flop chunk's strategies as a flop game's baseline (`applyNodelock`): the
 * chunk's node of the same path, read onto the game's hands by combo. A
 * combo the chunk does not hold (none, when the game is the chunk's spot)
 * plays its first action.
 */
export function chunkBaseline(chunk: FlopChunk, built: BuiltSubgame): BaselineStrategy {
  const byPath = new Map(chunk.result.nodes.map((node, k) => [node.path, k] as const).filter(([, k]) => chunk.result.nodes[k].kind === "action"));
  return (node) => {
    const path = built.info[node]?.path;
    const at = path === undefined ? undefined : byPath.get(path);
    if (at === undefined) return null;
    const solved = chunk.result.nodes[at];
    const p = solved.player as 0 | 1;
    const count = solved.labels.length;
    const from = chunk.result.hands[p];
    const n = from.length;
    const index = new Int32Array(NUM_COMBOS).fill(-1);
    from.forEach((combo, i) => {
      index[combo] = i;
    });
    const hands = built.combos[p];
    const out = new Float64Array(count * hands.length);
    hands.forEach((combo, i) => {
      const j = index[combo];
      for (let a = 0; a < count; a += 1) out[a * hands.length + i] = j >= 0 ? solved.strategy[a * n + j] : a === 0 ? 1 : 0;
    });
    return out;
  };
}

/**
 * The header of a nodelock's result chunk: the library chunk's, with the
 * lock's hash and target. A reader tells a locked chunk by `lockHash`.
 */
export function nodelockHeader(baseline: FlopChunkHeader, set: LockSet): FlopChunkHeader {
  return { ...baseline, targetPct: set.targetPct, lockHash: lockHash(set) };
}

/** The flop of a lock set's spot as card indices (`spot.flop` is a flop key, e.g. `Ks5h3s`). */
export function lockFlopCards(set: LockSet): number[] {
  return parseCards(set.spot.flop.match(/../g) ?? []);
}
