/**
 * The nodelock editor's state (`docs/NODELOCK.md` §5.2), as a pure reducer:
 * the strategy being set at one decision and which hands are locked, with
 * undo and redo. No React, no solver: the editor (`Editor.tsx`) keeps it in
 * `useReducer`, and the tests drive it directly.
 *
 * ```
 * the decision (EditorSpot: the actor's hands, their reach, GTO's mix and each action's EV)
 *   ─▶ Range / Hand classes mode: an action's share of the range (or of a class) set to a target;
 *      the hands closest to indifference move first, and the range is locked
 *   ─▶ Hands mode: paint a mix onto hands; painted hands are locked
 *   ─▶ Lock all / Unlock all / Invert, a lock badge per cell, Reset, a suggestion loaded whole
 *   ─▶ lockSpec: the lock of this node, over the 1,326 canonical combos
 * ```
 *
 * As in GTO Wizard, locked hands keep the strategy set here and unlocked
 * hands adapt in the solve. An unlocked hand therefore shows GTO's mix: that
 * is where it starts from.
 *
 * Hands are the chunk's own (`result.hands[player]`, in the chunk's suits),
 * indexed `i`; a strategy is `[action][i]`.
 */

import type { LockAction } from "../spot";

/** Combos in a hold'em deck: the length of a lock's per-combo arrays. */
export const LOCK_COMBOS = 1326;

/** One decision, as the editor needs it. */
export interface EditorSpot {
  /** Combo index (0..1325, `combos.ts`) of each of the actor's hands. */
  hands: ArrayLike<number>;
  /** Each hand's reach at the decision, 0..1. */
  reach: ArrayLike<number>;
  /** GTO's (the library's) strategy, `[action][i]`. */
  gto: ArrayLike<number>[];
  /** Each action's EV per hand, `[action][i]`, bb. */
  ev: ArrayLike<number>[];
}

export interface Strategy {
  /** `[action][i]`; each hand's column sums to 1. */
  strategy: number[][];
  /** Per hand: 1 = locked (fixed in the solve), 0 = adapts. */
  locked: number[];
  /**
   * The node's actions when the lock changed them (`editor/sizes.ts`): the
   * strategy's rows are these. Absent: the library's. Kept in every undo
   * step, so a size added or taken away is undone like a change of mix.
   */
  actions?: readonly LockAction[];
}

export interface EditorState extends Strategy {
  /** The suggestion the lock started from (`node_locks.preset`), if any. */
  preset: string | null;
  past: Strategy[];
  future: Strategy[];
}

export type EditorAction =
  /** Range and Hand classes modes: `action`'s share of the hands in `mask` (all reaching hands without one) becomes `target`. */
  | { type: "frequency"; action: number; target: number; mask?: ArrayLike<number> | null; held?: readonly boolean[]; merge?: boolean }
  /** Hands mode: these hands play `mix` and are locked. */
  | { type: "paint"; hands: readonly number[]; mix: readonly number[]; merge?: boolean }
  /** A lock badge: these hands' lock flips together (all locked → unlocked, else locked). */
  | { type: "toggleLock"; hands: readonly number[] }
  | { type: "lockAll" }
  | { type: "unlockAll" }
  | { type: "invert" }
  | { type: "reset" }
  /** A suggestion (or a saved lock being edited), whole. */
  | { type: "load"; strategy: number[][]; locked: number[]; preset: string | null }
  /** The node's actions changed (`withActions`), the strategy carried over to them (`carryStrategy`). */
  | { type: "actions"; actions: readonly LockAction[] | undefined; strategy: number[][]; locked: number[] }
  | { type: "undo" }
  | { type: "redo" };

/** Steps kept for undo. */
const HISTORY = 100;
const EPS = 1e-12;

function gtoOf(spot: EditorSpot): number[][] {
  return spot.gto.map((row) => Array.from(row));
}

/** The editor at GTO with nothing locked. */
export function initialState(spot: EditorSpot): EditorState {
  return { strategy: gtoOf(spot), locked: new Array<number>(spot.hands.length).fill(0), preset: null, past: [], future: [] };
}

function reaching(spot: EditorSpot, i: number): boolean {
  return spot.reach[i] > 0;
}

/**
 * A new present, with the old one on the undo stack (and the redo stack
 * cleared). `merge` folds it into the last step instead: one drag of the
 * brush or a slider is one step to undo.
 */
function commit(state: EditorState, next: Strategy, preset = state.preset, merge = false): EditorState {
  if (merge && state.past.length) return { ...state, ...next, preset, future: [] };
  const past = [...state.past, snapshot(state)];
  if (past.length > HISTORY) past.shift();
  return { actions: state.actions, ...next, preset, past, future: [] };
}

/** The present as an undo step. */
function snapshot(state: Strategy): Strategy {
  return { strategy: state.strategy, locked: state.locked, actions: state.actions };
}

/** A hand's locks set, unlocked hands back on GTO's mix. */
function withLocks(spot: EditorSpot, state: Strategy, locked: number[]): Strategy {
  const strategy = state.strategy.map((row, a) => row.map((x, i) => (locked[i] ? x : spot.gto[a][i])));
  return { strategy, locked };
}

export function editorReducer(spot: EditorSpot, state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "undo": {
      if (!state.past.length) return state;
      const prev = state.past[state.past.length - 1];
      return {
        ...state,
        ...prev,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
      };
    }
    case "redo": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { ...state, ...next, past: [...state.past, snapshot(state)], future: rest };
    }
    case "reset":
      if (!state.locked.some(Boolean)) return state;
      return commit(state, { strategy: gtoOf(spot), locked: new Array<number>(spot.hands.length).fill(0) }, null);
    case "actions":
      return commit(state, { strategy: action.strategy, locked: action.locked, actions: action.actions });
    case "load":
      return commit(state, { strategy: action.strategy.map((row) => row.slice()), locked: action.locked.slice() }, action.preset);
    case "lockAll":
      return commit(state, withLocks(spot, state, state.locked.map((x, i) => (reaching(spot, i) ? 1 : x))));
    case "unlockAll":
      return commit(state, withLocks(spot, state, state.locked.map(() => 0)));
    case "invert":
      return commit(state, withLocks(spot, state, state.locked.map((x, i) => (reaching(spot, i) ? 1 - x : 0))));
    case "toggleLock": {
      const all = action.hands.length > 0 && action.hands.every((i) => state.locked[i]);
      const locked = state.locked.slice();
      for (const i of action.hands) locked[i] = all ? 0 : 1;
      return commit(state, withLocks(spot, state, locked));
    }
    case "paint": {
      if (!action.hands.length) return state;
      const mix = normalised(action.mix);
      const strategy = state.strategy.map((row) => row.slice());
      const locked = state.locked.slice();
      for (const i of action.hands) {
        mix.forEach((x, a) => {
          strategy[a][i] = x;
        });
        locked[i] = 1;
      }
      return commit(state, { strategy, locked }, state.preset, action.merge);
    }
    case "frequency":
      return commit(state, moveFrequency(spot, state, action.action, action.target, action.mask ?? null, action.held ?? []), state.preset, action.merge);
  }
}

function normalised(mix: readonly number[]): number[] {
  const sum = mix.reduce((s, x) => s + Math.max(0, x), 0);
  return sum > EPS ? mix.map((x) => Math.max(0, x) / sum) : mix.map((_, a) => (a === 0 ? 1 : 0));
}

/** Reach-weighted share of `action` over the hands in `mask` (every reaching hand without one). */
export function shareOf(spot: EditorSpot, strategy: number[][], action: number, mask: ArrayLike<number> | null = null): number {
  let all = 0;
  let taking = 0;
  for (let i = 0; i < spot.hands.length; i += 1) {
    if (!reaching(spot, i) || (mask && !mask[i])) continue;
    all += spot.reach[i];
    taking += spot.reach[i] * strategy[action][i];
  }
  return all > 0 ? taking / all : 0;
}

/** Every action's reach-weighted share over the hands in `mask`. */
export function sharesOf(spot: EditorSpot, strategy: number[][], mask: ArrayLike<number> | null = null): number[] {
  return strategy.map((_, a) => shareOf(spot, strategy, a, mask));
}

/**
 * `action`'s share of the hands in `mask` set to `target`, as GTO Wizard's
 * Range mode does it: the hands that lose least by changing move first, and
 * every hand of the pool is locked after (the node's frequency is the lock).
 *
 * - Up: hands ordered by how far `action` is below their best action's EV;
 *   each gives `action` what its free actions hold (not the `held` ones).
 * - Down: hands ordered by how little `action` beats their best free
 *   alternative; what leaves goes to the free actions in the hand's own
 *   proportions, else to its best alternative.
 *
 * A target out of reach (every other action held) moves what it can.
 */
function moveFrequency(
  spot: EditorSpot,
  state: Strategy,
  action: number,
  rawTarget: number,
  mask: ArrayLike<number> | null,
  held: readonly boolean[],
): Strategy {
  const count = state.strategy.length;
  const target = Math.min(1, Math.max(0, rawTarget));
  const strategy = state.strategy.map((row) => row.slice());
  const locked = state.locked.slice();
  const pool: number[] = [];
  let total = 0;
  let current = 0;
  for (let i = 0; i < spot.hands.length; i += 1) {
    if (!reaching(spot, i) || (mask && !mask[i])) continue;
    pool.push(i);
    total += spot.reach[i];
    current += spot.reach[i] * strategy[action][i];
  }
  if (total <= 0) return state;
  const free = (b: number) => b !== action && !held[b];
  const freeActions = Array.from({ length: count }, (_, b) => b).filter(free);
  const best = (i: number, among: number[]) => among.reduce((m, b) => Math.max(m, spot.ev[b][i]), Number.NEGATIVE_INFINITY);
  let need = target * total - current;

  if (need > EPS) {
    const all = Array.from({ length: count }, (_, b) => b);
    // Cheapest first: the EV given up by playing `action` instead of the hand's best; then the hands already leaning to it.
    const order = pool
      .map((i) => ({ i, cost: best(i, all) - spot.ev[action][i] }))
      .sort((x, y) => x.cost - y.cost || strategy[action][y.i] - strategy[action][x.i] || x.i - y.i);
    for (const { i } of order) {
      if (need <= EPS) break;
      const room = spot.reach[i] * freeActions.reduce((s, b) => s + strategy[b][i], 0);
      if (room <= EPS) continue;
      const f = Math.min(1, need / room);
      for (const b of freeActions) {
        const moved = strategy[b][i] * f;
        strategy[b][i] -= moved;
        strategy[action][i] += moved;
      }
      need -= room * f;
    }
  } else if (need < -EPS && freeActions.length) {
    need = -need;
    // Cheapest first: how little `action` beats the hand's best free alternative.
    const order = pool
      .map((i) => ({ i, cost: spot.ev[action][i] - best(i, freeActions) }))
      .sort((x, y) => x.cost - y.cost || strategy[action][x.i] - strategy[action][y.i] || x.i - y.i);
    for (const { i } of order) {
      if (need <= EPS) break;
      const room = spot.reach[i] * strategy[action][i];
      if (room <= EPS) continue;
      const f = Math.min(1, need / room);
      const moved = strategy[action][i] * f;
      strategy[action][i] -= moved;
      const others = freeActions.reduce((s, b) => s + strategy[b][i], 0);
      if (others > EPS) {
        const shares = freeActions.map((b) => strategy[b][i] / others);
        freeActions.forEach((b, k) => {
          strategy[b][i] += moved * shares[k];
        });
      } else {
        const to = freeActions.reduce((m, b) => (spot.ev[b][i] > spot.ev[m][i] ? b : m), freeActions[0]);
        strategy[to][i] += moved;
      }
      need -= room * f;
    }
  }
  for (const i of pool) locked[i] = 1;
  return { strategy, locked };
}

/** The node's lock over the 1,326 canonical combos: a combo outside the actor's hands is unlocked, all zeros. */
export function lockArrays(spot: EditorSpot, state: Strategy): { strategy: number[][]; locked: number[] } {
  const strategy = state.strategy.map(() => new Array<number>(LOCK_COMBOS).fill(0));
  const locked = new Array<number>(LOCK_COMBOS).fill(0);
  for (let i = 0; i < spot.hands.length; i += 1) {
    const combo = spot.hands[i];
    if (!state.locked[i]) continue;
    locked[combo] = 1;
    state.strategy.forEach((row, a) => {
      strategy[a][combo] = row[i];
    });
  }
  return { strategy, locked };
}

/** A lock over the 1,326 combos (a suggestion, a saved lock) as the editor's per-hand arrays. */
export function fromLockArrays(spot: EditorSpot, lock: { strategy: ArrayLike<number>[]; locked: ArrayLike<number> }): Strategy {
  const strategy = spot.gto.map((row) => Array.from(row));
  const locked = new Array<number>(spot.hands.length).fill(0);
  for (let i = 0; i < spot.hands.length; i += 1) {
    const combo = spot.hands[i];
    if (!lock.locked[combo] || !reaching(spot, i)) continue;
    locked[i] = 1;
    const column = strategy.map((_, a) => lock.strategy[a]?.[combo] ?? 0);
    const sum = column.reduce((s, x) => s + x, 0);
    column.forEach((x, a) => {
      strategy[a][i] = sum > EPS ? x / sum : spot.gto[a][i];
    });
  }
  return { strategy, locked };
}

/** Reaching hands locked, and all reaching hands. */
export function lockedCount(spot: EditorSpot, state: Strategy): { locked: number; reaching: number } {
  let locked = 0;
  let all = 0;
  for (let i = 0; i < spot.hands.length; i += 1) {
    if (!reaching(spot, i)) continue;
    all += 1;
    if (state.locked[i]) locked += 1;
  }
  return { locked, reaching: all };
}

/**
 * The strategy Solve locks (#410). Hands locked: the state as it is. None
 * locked: a node whose actions the lock changed (`ownActions`, sizes added or
 * taken away) is still a lock, since the tree changes. With one action left
 * every reaching hand plays it, so all are fixed at it (the lock marks show
 * it); with more, every hand adapts on the new actions. Null: nothing would
 * change.
 */
export function strategyToSolve(spot: EditorSpot, state: Strategy, ownActions: boolean): Strategy | null {
  if (lockedCount(spot, state).locked > 0) return state;
  if (!ownActions) return null;
  if (state.strategy.length !== 1) return state;
  const locked = state.locked.map((_, i) => (reaching(spot, i) ? 1 : 0));
  return { ...state, strategy: [state.strategy[0].map(() => 1)], locked };
}
