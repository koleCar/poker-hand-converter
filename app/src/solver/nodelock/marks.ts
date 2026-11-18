/**
 * The lock marks (`docs/NODELOCK.md` §7.3): which decisions of an open lock
 * are locked, which of their actions, and what the lock popover says about
 * one - GTO's share of each action against the lock's, how many combos are
 * fixed, the locked strategy over the 13×13 grid and where the lock came from.
 *
 * Pure: the numbers come from the row's `LockSet` node spec and the decision
 * as a chunk has it (its hands, their reach, GTO's strategy when it is at
 * hand), handed in by `slot.tsx`.
 */
import type { LockSet, NodeLockSpec } from "./contract";
import { lockPathOf } from "./engine/door";

/** Below this a frequency or a reach counts as nothing. */
const EPS = 1e-9;

/** A decision's lock address (`NodeLockSpec.path`): the flop's node path, or the deal's path, the turn card and the turn game's path. */
export function markPath(nodePath: string, turn: { dealPath: string; card: string } | null): string {
  return turn ? lockPathOf(turn.dealPath, turn.card, nodePath) : nodePath;
}

/** The lock a decision carries: its node spec, and the lock it was inherited from (null: the open lock's own). */
export interface MarkedNode {
  spec: NodeLockSpec;
  from: { id: string; name: string } | null;
}

/**
 * Every locked decision of the open lock by its path: its own nodes, then
 * those inherited from its ancestors (nearest first) on paths it does not
 * lock itself.
 */
export function markIndex(own: LockSet, ancestors: ReadonlyArray<{ id: string; name: string; set: LockSet }> = []): Map<string, MarkedNode> {
  const index = new Map<string, MarkedNode>();
  for (const spec of own.nodes) index.set(spec.path, { spec, from: null });
  for (const parent of ancestors) {
    for (const spec of parent.set.nodes) {
      if (!index.has(spec.path)) index.set(spec.path, { spec, from: { id: parent.id, name: parent.name } });
    }
  }
  return index;
}

/** The decision as a chunk has it, per hand of the acting player. */
export interface MarkSpot {
  /** Each hand's combo (`combos.ts` order, 0–1,325). */
  hands: ArrayLike<number>;
  /** Each hand's reach at the decision. */
  reach: ArrayLike<number>;
  /** Each hand's grid cell (row * 13 + col). */
  cell: ArrayLike<number>;
  /** GTO at the decision, [action][hand] (the library's or the base lock's), or null when it is not at hand. */
  gto: ReadonlyArray<ArrayLike<number>> | null;
  /** What a hand the lock leaves free plays, [action][hand]: GTO when known, else the locked solve's own. */
  rest: ReadonlyArray<ArrayLike<number>>;
}

export interface MarkCell {
  /** The cell's mix under the lock (reach-weighted; free hands at `rest`). */
  mix: number[];
  /** Share of the cell's reach the lock fixes, 0–1. */
  fixed: number;
}

export interface NodeMark {
  /** Per action: it carries a lock icon (a fixed combo plays it, or the lock took it to 0 %). */
  locked: boolean[];
  /** Per action: GTO's share of the range, or null when GTO is not at hand. */
  gto: number[] | null;
  /** Per action: the share under the lock (fixed combos at the lock, the rest at `rest`). */
  shares: number[];
  /** Combos reaching the decision, and how many the lock fixes. */
  fixed: number;
  reaching: number;
  /** "range": every reaching combo is fixed (Range mode, a preset); "painted": some hands were. */
  origin: "range" | "painted";
  /** The 169 grid cells; null where no hand reaches. */
  cells: Array<MarkCell | null>;
}

/** The lock's mix for one combo, normalised; null when the spec does not fix it. */
function lockedMix(spec: NodeLockSpec, combo: number): number[] | null {
  if (!spec.locked[combo]) return null;
  const mix = spec.strategy.map((row) => Math.max(0, row[combo] ?? 0));
  const sum = mix.reduce((s, x) => s + x, 0);
  return sum > EPS ? mix.map((x) => x / sum) : null;
}

/** A locked decision's numbers for the popover and its icons. */
export function nodeMark(spec: NodeLockSpec, spot: MarkSpot): NodeMark {
  const count = spec.actions.length;
  const shares = new Array<number>(count).fill(0);
  const gtoShares = spot.gto ? new Array<number>(count).fill(0) : null;
  /** What the fixed combos play under the lock, and what GTO (or the rest) has them play. */
  const fixedPlay = new Array<number>(count).fill(0);
  const fixedBefore = new Array<number>(count).fill(0);
  const cells: Array<{ mix: number[]; reach: number; fixed: number } | null> = Array.from({ length: 169 }, () => null);
  let total = 0;
  let fixed = 0;
  let reaching = 0;
  for (let i = 0; i < spot.hands.length; i += 1) {
    const r = spot.reach[i];
    if (!(r > EPS)) continue;
    reaching += 1;
    total += r;
    const combo = spot.hands[i];
    const mix = lockedMix(spec, combo);
    const free = Array.from({ length: count }, (_, a) => spot.rest[a]?.[i] ?? 0);
    const played = mix ?? free;
    const k = spot.cell[i];
    const cell = (cells[k] ??= { mix: new Array<number>(count).fill(0), reach: 0, fixed: 0 });
    cell.reach += r;
    if (mix) {
      fixed += 1;
      cell.fixed += r;
    }
    for (let a = 0; a < count; a += 1) {
      shares[a] += r * played[a];
      cell.mix[a] += r * played[a];
      if (gtoShares && spot.gto) gtoShares[a] += r * (spot.gto[a]?.[i] ?? 0);
      if (mix) {
        fixedPlay[a] += r * mix[a];
        fixedBefore[a] += r * ((spot.gto ?? spot.rest)[a]?.[i] ?? 0);
      }
    }
  }
  const norm = (x: number) => (total > 0 ? x / total : 0);
  return {
    locked: fixedPlay.map((x, a) => fixed > 0 && (x > EPS || fixedBefore[a] > EPS)),
    gto: gtoShares ? gtoShares.map(norm) : null,
    shares: shares.map(norm),
    fixed,
    reaching,
    origin: fixed >= reaching ? "range" : "painted",
    cells: cells.map((cell) =>
      cell ? { mix: cell.mix.map((x) => (cell.reach > 0 ? x / cell.reach : 0)), fixed: cell.reach > 0 ? cell.fixed / cell.reach : 0 } : null,
    ),
  };
}
