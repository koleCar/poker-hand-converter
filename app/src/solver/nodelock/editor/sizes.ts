/**
 * The lock's own sizes (owner, 2026-11-19): at the decision being locked,
 * any action can be taken away (Check and Fold too) and any bet or raise
 * size added by its % of the pot. The node then offers exactly these
 * actions (`NodeLockSpec.custom`), and the solve builds its tree with them
 * (`BettingRules.nodeActions`). Only this node changes: the rest of the tree
 * is the library's.
 *
 * Pure: the editor (`Editor.tsx`) keeps the actions in its reducer's state,
 * and `tests/test/appNodelockSizes.test.ts` drives this directly.
 *
 * A size the library never solved has no GTO and no EVs. Its GTO share is 0
 * (unlocked hands start from the library's mix of the actions that are
 * left), and its EVs are drawn between the nearest library sizes (`evOf`),
 * which is all Range mode needs to order the hands.
 */
import type { LockAction, LockTarget } from "../spot";
import type { EditorSpot } from "./state";

const EPS = 1e-9;

/** At most two decimals, no trailing zeros: the tree's labels (`formatAmount`). */
const amountText = (x: number) => String(Math.round(x * 100) / 100);

/** Names an action the way the library does (`SolverDict.action`). */
export type ActionName = (kind: string, sizePot: number, amount: number) => string;

const RANK: Record<LockAction["kind"], number> = { fold: 0, check: 0, call: 1, bet: 2, raise: 2, allin: 2 };

/** The tree's order: check or fold, call, then the sizes from the smallest. */
export function sortActions(actions: readonly LockAction[]): LockAction[] {
  return [...actions].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.amount - b.amount);
}

/** True when the node offers the library's own actions. */
export function isLibrary(target: Pick<LockTarget, "actions" | "library">): boolean {
  return target.actions.length === target.library.length && target.actions.every((a, k) => a.label === target.library[k].label);
}

export type SizeError = "tooSmall" | "there" | "noBet";

/**
 * A bet (no bet to answer) or a raise (facing one) of `pct` % of the pot: a
 * raise's % is of the pot after the call, as the library sizes raises. A raise
 * is at least the minimum (twice the bet faced); a size that reaches the
 * stack is all-in. `pct` null: all-in.
 */
export function sizeAction(target: LockTarget, pct: number | null, name: ActionName): LockAction | SizeError {
  const facing = target.toCall > EPS;
  if (target.behind <= (facing ? target.toCall : 0) + EPS) return "noBet";
  let amount: number;
  if (pct === null) amount = target.behind;
  else {
    if (!(pct > 0) || !Number.isFinite(pct)) return "tooSmall";
    amount = facing ? target.toCall + (pct / 100) * (target.pot + target.toCall) : (pct / 100) * target.pot;
    if (facing) amount = Math.max(amount, 2 * target.toCall);
  }
  const allIn = amount >= target.behind - EPS;
  if (allIn) amount = target.behind;
  const to = target.streetIn + amount;
  const kind: LockAction["kind"] = allIn ? "allin" : facing ? "raise" : "bet";
  const label = `${allIn ? "A" : facing ? "R" : "B"}${amountText(to)}`;
  // The label is what the tree reads: its amount, rounded as the tree rounds it.
  if (!allIn) amount = Number(amountText(to)) - target.streetIn;
  if (!(amount > (facing ? target.toCall : 0) + EPS)) return "tooSmall";
  if (target.actions.some((a) => a.label === label)) return "there";
  const library = target.library.find((a) => a.label === label);
  if (library) return library;
  const sizePot = facing ? (amount - target.toCall) / (target.pot + target.toCall) : amount / target.pot;
  return { label, name: name(kind, sizePot, amount), kind, amount, sizePot, gto: null };
}

/** The library's check, fold or call, which the lock took away, back. */
export function passiveActions(target: LockTarget): LockAction[] {
  return target.library.filter((a) => (a.kind === "check" || a.kind === "fold" || a.kind === "call") && !target.actions.some((b) => b.label === a.label));
}

/**
 * A saved lock's labels as actions: the library node's where it has them,
 * else read off the label (`B8.25` bets to 8.25), as the tree reads them.
 * Null when a label does not fit the node.
 */
export function actionsFromLabels(target: LockTarget, labels: readonly string[], name: ActionName): LockAction[] | null {
  const facing = target.toCall > EPS;
  const out: LockAction[] = [];
  for (const label of labels) {
    const library = target.library.find((a) => a.label === label);
    if (library) {
      out.push(library);
      continue;
    }
    const letter = label[0];
    const to = Number(label.slice(1));
    if (!"BRA".includes(letter) || !label.slice(1) || !Number.isFinite(to)) {
      if (letter === "X" && !facing && label === "X") out.push({ label, name: name("check", 0, 0), kind: "check", amount: 0, sizePot: 0, gto: null });
      else if ((label === "F" || label === "C") && facing) {
        const kind = label === "F" ? "fold" : "call";
        const amount = kind === "call" ? Math.min(target.toCall, target.behind) : 0;
        out.push({ label, name: name(kind, 0, amount), kind, amount, sizePot: 0, gto: null });
      } else return null;
      continue;
    }
    const amount = letter === "A" ? target.behind : to - target.streetIn;
    if (!(amount > 0)) return null;
    const kind: LockAction["kind"] = letter === "A" ? "allin" : facing ? "raise" : "bet";
    const sizePot = facing ? (amount - target.toCall) / (target.pot + target.toCall) : amount / target.pot;
    out.push({ label, name: name(kind, sizePot, amount), kind, amount, sizePot, gto: null });
  }
  return out.length ? out : null;
}

/**
 * Per hand, the EV of a size the library never solved: drawn between the
 * library's nearest sizes by % of the pot (the nearest one beyond the
 * last), else the library's passive action's (a node whose raises the cap
 * took away).
 */
function evOf(target: LockTarget, action: LockAction): ArrayLike<number> {
  const sizes = target.library
    .map((a, k) => ({ a, k }))
    .filter(({ a }) => a.kind === "bet" || a.kind === "raise" || a.kind === "allin")
    .sort((x, y) => x.a.sizePot - y.a.sizePot);
  const ev = target.spot.ev;
  if (!sizes.length) {
    const passive = target.library.findIndex((a) => a.kind === "call" || a.kind === "check");
    return ev[Math.max(0, passive)];
  }
  const x = action.sizePot;
  if (x <= sizes[0].a.sizePot) return ev[sizes[0].k];
  const last = sizes[sizes.length - 1];
  if (x >= last.a.sizePot) return ev[last.k];
  const hi = sizes.findIndex(({ a }) => a.sizePot >= x);
  const lo = sizes[hi - 1];
  const up = sizes[hi];
  const w = (x - lo.a.sizePot) / (up.a.sizePot - lo.a.sizePot || 1);
  return Float64Array.from(ev[lo.k], (v, i) => v * (1 - w) + ev[up.k][i] * w);
}

const cache = new WeakMap<LockTarget, Map<string, LockTarget>>();

/**
 * The decision offering `actions` in place of the library's: GTO's mix of
 * the actions left, scaled up per hand (a hand that only played what was
 * taken away goes to its best action left), 0 for a new size; the EVs, a new
 * size's drawn (`evOf`). The library's own actions give `target` back.
 */
export function withActions(target: LockTarget, actions: readonly LockAction[]): LockTarget {
  const key = actions.map((a) => a.label).join(" ");
  if (key === target.library.map((a) => a.label).join(" ")) return target.actions === target.library ? target : { ...target, actions: target.library };
  const known = cache.get(target)?.get(key);
  if (known) return known;
  const n = target.spot.hands.length;
  const ev = actions.map((a) => (a.gto !== null ? target.spot.ev[a.gto] : evOf(target, a)));
  const gto = actions.map((a) => (a.gto !== null ? Float64Array.from(target.spot.gto[a.gto]) : new Float64Array(n)));
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (const row of gto) sum += row[i];
    if (sum > EPS) {
      for (const row of gto) row[i] /= sum;
    } else {
      let best = 0;
      for (let a = 1; a < actions.length; a += 1) if (ev[a][i] > ev[best][i]) best = a;
      gto[best][i] = 1;
    }
  }
  const spot: EditorSpot = { hands: target.spot.hands, reach: target.spot.reach, gto, ev };
  const out: LockTarget = { ...target, actions: [...actions], spot };
  let byKey = cache.get(target);
  if (!byKey) cache.set(target, (byKey = new Map()));
  byKey.set(key, out);
  return out;
}

/**
 * A strategy carried over to another set of actions: an action that stays
 * keeps its row, a new one starts at 0, and what a taken-away action held
 * goes to the others in the hand's own proportions (to its best action left
 * when it held nothing else). Unlocked hands take the new GTO mix.
 */
export function carryStrategy(
  from: LockTarget,
  state: { strategy: number[][]; locked: number[] },
  to: LockTarget,
): { strategy: number[][]; locked: number[] } {
  const n = to.spot.hands.length;
  const strategy = to.actions.map((a) => {
    const k = from.actions.findIndex((b) => b.label === a.label);
    return k >= 0 ? state.strategy[k].slice() : new Array<number>(n).fill(0);
  });
  for (let i = 0; i < n; i += 1) {
    if (!state.locked[i]) {
      to.spot.gto.forEach((row, a) => {
        strategy[a][i] = row[i];
      });
      continue;
    }
    const sum = strategy.reduce((s, row) => s + row[i], 0);
    if (sum > EPS) {
      for (const row of strategy) row[i] /= sum;
    } else {
      let best = 0;
      for (let a = 1; a < strategy.length; a += 1) if (to.spot.ev[a][i] > to.spot.ev[best][i]) best = a;
      strategy[best][i] = 1;
    }
  }
  return { strategy, locked: state.locked.slice() };
}
