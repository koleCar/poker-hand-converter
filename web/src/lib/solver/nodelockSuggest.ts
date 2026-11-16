/**
 * Nodelock suggestions (`docs/NODELOCK.md` §4): what a given opponent type
 * would play at the node the user is locking, as a ready-made, editable lock.
 *
 * ```
 * the node: street, the locked player's role, node kind, actions,
 *           the baseline strategy [action][combo], reach,
 *           per-combo action EVs (from the chunk) or a strength per combo
 *   ─▶ an archetype's frequency rules (§4 table), stronger on the turn and
 *      river for "aggressive" and "overfolder"
 *   ─▶ the hands move whole in a stated order (`lockedStrategy`, the exploit
 *      lab's mover): by EV loss when the chunk has EVs, else by strength
 *   ─▶ one NodeLockSpec: every combo locked, every combo's row sums to 1
 * ```
 *
 * **Groups.** Every action is passive (check, call), a fold, or aggressive
 * (bet, raise, all-in). A rule moves the fold group's or the aggressive
 * group's share of the range (weighted by reach) to a target: "bets ×0.6"
 * is the aggressive group at 0.6 of its baseline share, "folds +15 pp" the
 * fold group at its baseline share plus 0.15. A rule only moves in its own
 * direction: when an earlier rule already went past its target, it leaves
 * the node alone.
 *
 * **Which hands move.** One order per group, the hands that join it first at
 * the front; they leave it from the back (`NodeLock.order`).
 * - With EVs: by the cost of joining the group, the EV of the hand's mix
 *   inside the group minus outside it (the range's mix where the hand plays
 *   none), cheapest first. Costs within `evTolerance` tie, and the tie goes to
 *   strength: the hand's EV under the baseline.
 * - Without: by the caller's strength. The fold group takes the weakest
 *   first; the aggressive group takes the strongest first, so the weakest
 *   bets and raises leave it first (bluffs go, value stays).
 *
 * A hand joining a group splits what it moves like its own mix there, else
 * like the range's (so the sizes keep the baseline's split). An aggressive
 * player on the turn or river then shifts part of every smaller size to the
 * biggest one (not all-in).
 *
 * Pure: no fetch, no React, no solver. The UI calls it for the node card's
 * Suggestions chips (`availableArchetypes`), then `suggestLocks` on a click.
 */

import type { ActionKind } from "./betting";
import { NUM_COMBOS } from "./combos";
import { lockedStrategy } from "./lock";

// TODO(nodelock): import `NodeLockSpec` from "./nodelock" once workstream E
// lands it on prestaging; this is §1's type, field for field.
/** One locked node (`docs/NODELOCK.md` §1). */
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
  /** 1,326 flags: 1 = this combo's strategy is fixed; 0 = it adapts in the solve. */
  locked: number[];
}

export type Street = NodeLockSpec["street"];

export const ARCHETYPES = ["tight", "aggressive", "station", "overfolder", "passive"] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** First to act (check or bet), facing a bet, or facing a raise. */
export type NodeKind = "first" | "facingBet" | "facingRaise";

export interface SuggestContext {
  street: Street;
  /** The node's address, copied into the lock (`NodeLockSpec.path`). */
  path: string;
  /** The locked player: 0 = out of position, as in the chunk. */
  player: 0 | 1;
  /** The locked player's seat for the title, e.g. `BTN`; "opponent" when absent. */
  position?: string;
  /** The locked player's role. The table's rules do not depend on it yet; it is here for the "from this player's stats" variant. */
  role: { preflop: "aggressor" | "caller"; inPosition: boolean };
  nodeKind: NodeKind;
  /**
   * The node's action labels: the tree's (`X`, `B1.82`, `F`, `C`, `R5.4`,
   * `A100`) or words (`Check`, `Bet 33%`, `Raise 2.5x`, `All-in`). The number
   * in a bet or raise label orders the sizes.
   */
  actions: string[];
  /** Overrides what the labels say, per action (`ExploreAction.kind`). */
  kinds?: ActionKind[];
  /** Overrides the size each label's number gives, per action (`ExploreAction.amount`); only the order matters. */
  amounts?: number[];
  /** Baseline strategy, [action][combo] over the 1,326 combos. */
  strategy: ArrayLike<number>[];
  /** The locked player's reach per combo at the node, 1,326. */
  reach: ArrayLike<number>;
  /** Per-action EV per combo, [action][combo], from the chunk where it has them. */
  ev?: ArrayLike<number>[];
  /** EV costs closer than this tie and fall back to strength; in the EV's unit (bb). Default 0.01. */
  evTolerance?: number;
  /** Strength per combo (higher = stronger, e.g. equity against the opponent's range), 1,326; used when `ev` is absent. */
  strength?: ArrayLike<number>;
}

export interface NodelockSuggestion {
  /** The preset id stored with the lock (`node_locks.preset`): the archetype. */
  id: Archetype;
  title: string;
  explanation: string;
  nodes: NodeLockSpec[];
  /** Reach-weighted share of each action, baseline and suggested. */
  frequencies: { before: number[]; after: number[] };
}

export interface NodelockSuggestDict {
  /** Chip labels. */
  names: Record<Archetype, string>;
  /** "a tight BTN on the flop": the title for a node. `who` is the position, or null for "opponent". */
  title: (archetype: Archetype, who: string | null, street: Street) => string;
  /** One line: what the archetype does at this kind of node. */
  explanation: (archetype: Archetype, kind: NodeKind, street: Street) => string;
}

/* ------------------------------------------------------------ dictionaries - */

const EN_EXPLANATION: Record<Archetype, Record<NodeKind, string>> = {
  tight: {
    first: "Bets less often: his weakest bluffs go first, the value bets stay.",
    facingBet: "Folds more, weakest calls first, and raises only for value.",
    facingRaise: "Folds more to a raise, weakest hands first.",
  },
  aggressive: {
    first: "Bets more often, adding hands with equity first.",
    facingBet: "Raises more often, semi-bluffs first, and folds less.",
    facingRaise: "Re-raises and jams more often.",
  },
  station: {
    first: "Bets less, and only for value: the bluffs check.",
    facingBet: "Folds half as often and rarely raises: he calls instead.",
    facingRaise: "Folds half as often to a raise: he calls instead.",
  },
  overfolder: {
    first: "Plays this node as the solver does.",
    facingBet: "Folds too often to a bet, weakest hands first.",
    facingRaise: "Folds too often to a raise, weakest hands first.",
  },
  passive: {
    first: "Bets half as often: he checks instead.",
    facingBet: "Never raises: he calls instead.",
    facingRaise: "Never re-raises: he calls instead.",
  },
};

const EN_LATE: Partial<Record<Archetype, Partial<Record<NodeKind, string>>>> = {
  aggressive: {
    first: "Barrels more often and bigger, adding hands with equity first.",
    facingBet: "Raises more often and bigger, semi-bluffs first, and folds less.",
    facingRaise: "Re-raises and jams even more often.",
  },
  overfolder: {
    facingBet: "Gives up to a bet even more often, weakest hands first.",
    facingRaise: "Gives up to a raise even more often, weakest hands first.",
  },
};

export const nodelockSuggestEn: NodelockSuggestDict = {
  names: {
    tight: "Tight",
    aggressive: "Aggressive",
    station: "Calling station",
    overfolder: "Overfolder",
    passive: "Passive",
  },
  title: (archetype, who, street) => {
    switch (archetype) {
      case "tight":
        return `Tight ${who ?? "opponent"} on the ${street}`;
      case "aggressive":
        return `Aggressive ${who ?? "opponent"} on the ${street}`;
      case "station":
        return who ? `${who} calling station on the ${street}` : `Calling station on the ${street}`;
      case "overfolder":
        return `${who ?? "Opponent"} who folds too much on the ${street}`;
      case "passive":
        return `Passive ${who ?? "opponent"} on the ${street}`;
    }
  },
  explanation: (archetype, kind, street) =>
    (street !== "flop" && EN_LATE[archetype]?.[kind]) || EN_EXPLANATION[archetype][kind],
};

const HR_STREET: Record<Street, string> = { flop: "flopu", turn: "turnu", river: "riveru" };

const HR_EXPLANATION: Record<Archetype, Record<NodeKind, string>> = {
  tight: {
    first: "Beta rjeđe: prvo odustaje od najslabijih blefova, value betovi ostaju.",
    facingBet: "Folda češće, prvo najslabije callove, a raisea samo za value.",
    facingRaise: "Na raise folda češće, prvo najslabije ruke.",
  },
  aggressive: {
    first: "Beta češće i prvo dodaje ruke s equityjem.",
    facingBet: "Raisea češće, prvo semi-blefove, a folda rjeđe.",
    facingRaise: "Češće reraisea i ide all-in.",
  },
  station: {
    first: "Beta rjeđe i samo za value: blefove checka.",
    facingBet: "Folda upola rjeđe i rijetko raisea: umjesto toga calla.",
    facingRaise: "Na raise folda upola rjeđe: umjesto toga calla.",
  },
  overfolder: {
    first: "Ovdje igra kao solver.",
    facingBet: "Na bet folda prečesto, prvo najslabije ruke.",
    facingRaise: "Na raise folda prečesto, prvo najslabije ruke.",
  },
  passive: {
    first: "Beta upola rjeđe: umjesto toga checka.",
    facingBet: "Nikad ne raisea: umjesto toga calla.",
    facingRaise: "Nikad ne reraisea: umjesto toga calla.",
  },
};

const HR_LATE: Partial<Record<Archetype, Partial<Record<NodeKind, string>>>> = {
  aggressive: {
    first: "Češće barrela i većim betom, prvo ruke s equityjem.",
    facingBet: "Raisea češće i veće, prvo semi-blefove, a folda rjeđe.",
    facingRaise: "Još češće reraisea i ide all-in.",
  },
  overfolder: {
    facingBet: "Na bet odustaje još češće, prvo najslabije ruke.",
    facingRaise: "Na raise odustaje još češće, prvo najslabije ruke.",
  },
};

export const nodelockSuggestHr: NodelockSuggestDict = {
  names: {
    tight: "Tight",
    aggressive: "Agresivan",
    station: "Previše calla",
    overfolder: "Previše folda",
    passive: "Pasivan",
  },
  title: (archetype, who, street) => {
    const on = `na ${HR_STREET[street]}`;
    switch (archetype) {
      case "tight":
        return `Tight ${who ?? "protivnik"} ${on}`;
      case "aggressive":
        return `Agresivan ${who ?? "protivnik"} ${on}`;
      case "station":
        return `${who ?? "Protivnik"} koji previše calla ${on}`;
      case "overfolder":
        return `${who ?? "Protivnik"} koji previše folda ${on}`;
      case "passive":
        return `Pasivan ${who ?? "protivnik"} ${on}`;
    }
  },
  explanation: (archetype, kind, street) =>
    (street !== "flop" && HR_LATE[archetype]?.[kind]) || HR_EXPLANATION[archetype][kind],
};

/* ------------------------------------------------------------------ rules - */

type Group = "fold" | "agg";

interface Rule {
  group: Group;
  /** The group's target share from its baseline share. */
  target: (base: number) => number;
  /** Which way the rule moves the share; it never moves the other way. */
  dir: "up" | "down";
  /** Where a hand leaving the group goes when it plays nothing outside it. */
  fallback: "fold" | "passive";
}

/** How much stronger "aggressive" and "overfolder" get later in the hand (pp shifts ×, multipliers' excess ×). */
const LATE_STREET: Record<Street, number> = { flop: 1, turn: 1.25, river: 1.5 };
/** Share of every smaller size an aggressive player moves to the biggest one, by street. */
const BIGGER_SIZE: Record<Street, number> = { flop: 0, turn: 0.4, river: 0.6 };

const times = (m: number) => (base: number) => base * m;
const plus = (pp: number) => (base: number) => base + pp;

function rulesFor(archetype: Archetype, kind: NodeKind, street: Street): Rule[] {
  const s = archetype === "aggressive" || archetype === "overfolder" ? LATE_STREET[street] : 1;
  const mult = (m: number) => times(1 + (m - 1) * s);
  const pp = (x: number) => plus(x * s);
  const down = (group: Group, target: Rule["target"], fallback: Rule["fallback"] = "passive"): Rule => ({ group, target, dir: "down", fallback });
  const up = (group: Group, target: Rule["target"]): Rule => ({ group, target, dir: "up", fallback: "passive" });
  const never = () => 0;
  // The §4 table. Fold rules come first, so the aggressive group's target is checked after the folds moved.
  const table: Record<NodeKind, Record<Archetype, Rule[]>> = {
    first: {
      tight: [down("agg", times(0.6))],
      aggressive: [up("agg", pp(0.2))],
      station: [down("agg", times(0.7))],
      overfolder: [],
      passive: [down("agg", times(0.5))],
    },
    facingBet: {
      tight: [up("fold", plus(0.15)), down("agg", times(0.5), "fold")],
      aggressive: [down("fold", pp(-0.1)), up("agg", mult(2))],
      station: [down("fold", times(0.5)), down("agg", times(0.3))],
      overfolder: [up("fold", pp(0.2))],
      passive: [down("agg", never)],
    },
    facingRaise: {
      tight: [up("fold", plus(0.2))],
      aggressive: [up("agg", mult(1.5))],
      station: [down("fold", times(0.5))],
      overfolder: [up("fold", pp(0.25))],
      passive: [down("agg", never)],
    },
  };
  return table[kind][archetype];
}

/* ---------------------------------------------------------------- actions - */

interface ParsedAction {
  kind: ActionKind;
  size: number;
}

function parseLabel(label: string): ParsedAction {
  const text = label.trim().toLowerCase();
  const number = /(\d+(?:\.\d+)?)/.exec(text);
  const size = number ? Number(number[1]) : Number.NaN;
  if (text === "f" || text.startsWith("fold")) return { kind: "fold", size: 0 };
  if (text === "x" || text.startsWith("check")) return { kind: "check", size: 0 };
  if (text === "c" || text.startsWith("call")) return { kind: "call", size: 0 };
  if (/^(a[\d.]|all|jam|shove)/.test(text) || text === "a") return { kind: "allin", size: Number.isNaN(size) ? Infinity : size };
  if (/^(b[\d.]|bet)/.test(text) || text === "b") return { kind: "bet", size };
  if (/^(r[\d.]|raise|3-?bet|4-?bet)/.test(text) || text === "r") return { kind: "raise", size };
  throw new Error(`nodelock suggestion: unknown action label "${label}"`);
}

interface Node {
  count: number;
  /** Action indices per group. */
  fold: number[];
  agg: number[];
  passive: number[];
  /** Aggressive actions that are not all-in, smallest first. */
  sizes: number[];
}

function nodeOf(ctx: SuggestContext): Node {
  const count = ctx.actions.length;
  const parsed = ctx.actions.map((label, a) => {
    const kind = ctx.kinds?.[a];
    const p = kind ? { kind, size: Number.NaN } : parseLabel(label);
    const amount = ctx.amounts?.[a];
    return { ...p, size: amount ?? p.size, a };
  });
  const fold = parsed.filter((p) => p.kind === "fold").map((p) => p.a);
  const passive = parsed.filter((p) => p.kind === "check" || p.kind === "call").map((p) => p.a);
  const agg = parsed.filter((p) => p.kind === "bet" || p.kind === "raise" || p.kind === "allin").map((p) => p.a);
  const sizes = parsed
    .filter((p) => p.kind === "bet" || p.kind === "raise")
    .sort((x, y) => (Number.isNaN(x.size) || Number.isNaN(y.size) ? x.a - y.a : x.size - y.size || x.a - y.a))
    .map((p) => p.a);
  return { count, fold, agg, passive, sizes };
}

/* ------------------------------------------------------------------ order - */

/** Combos in the order they join `group` (they leave from the back). */
function orderFor(ctx: SuggestContext, node: Node, base: Float64Array, group: number[], weakestFirst: boolean): Int32Array {
  const n = NUM_COMBOS;
  const { count } = node;
  const strength = new Float64Array(n);
  const cost = new Float64Array(n);
  const ev = ctx.ev;
  if (ev) {
    const inGroup = new Uint8Array(count);
    for (const a of group) inGroup[a] = 1;
    // The range's mix inside and outside the group, for hands that play none of one side.
    const rangeIn = new Float64Array(count);
    const rangeOut = new Float64Array(count);
    for (let i = 0; i < n; i += 1) {
      const w = Math.max(0, Number(ctx.reach[i]) || 0);
      if (!(w > 0)) continue;
      for (let a = 0; a < count; a += 1) (inGroup[a] ? rangeIn : rangeOut)[a] += w * base[a * n + i];
    }
    const mixEv = (i: number, side: 1 | 0, range: Float64Array) => {
      let own = 0;
      let value = 0;
      for (let a = 0; a < count; a += 1) {
        if (inGroup[a] !== side) continue;
        own += base[a * n + i];
        value += base[a * n + i] * (Number(ev[a][i]) || 0);
      }
      if (own > 1e-9) return value / own;
      let total = 0;
      value = 0;
      for (let a = 0; a < count; a += 1) {
        if (inGroup[a] !== side) continue;
        total += range[a];
        value += range[a] * (Number(ev[a][i]) || 0);
      }
      if (total > 0) return value / total;
      // Nothing in the range plays that side either: the side's plain average.
      let k = 0;
      for (let a = 0; a < count; a += 1) if (inGroup[a] === side) { value += Number(ev[a][i]) || 0; k += 1; }
      return k ? value / k : 0;
    };
    const tolerance = ctx.evTolerance ?? 0.01;
    for (let i = 0; i < n; i += 1) {
      let v = 0;
      for (let a = 0; a < count; a += 1) v += base[a * n + i] * (Number(ev[a][i]) || 0);
      strength[i] = v;
      cost[i] = tolerance > 0 ? Math.round((mixEv(i, 0, rangeOut) - mixEv(i, 1, rangeIn)) / tolerance) : mixEv(i, 0, rangeOut) - mixEv(i, 1, rangeIn);
    }
  } else {
    const given = ctx.strength;
    for (let i = 0; i < n; i += 1) strength[i] = Number(given?.[i]) || 0;
  }
  const ids = Array.from({ length: n }, (_, i) => i);
  ids.sort((x, y) => {
    if (ev && cost[x] !== cost[y]) return cost[x] - cost[y];
    if (strength[x] !== strength[y]) return weakestFirst ? strength[x] - strength[y] : strength[y] - strength[x];
    return x - y;
  });
  return Int32Array.from(ids);
}

/* ------------------------------------------------------------- the mover - */

function shareOf(strategy: Float64Array, reach: ArrayLike<number>, group: number[]): number {
  const n = NUM_COMBOS;
  let total = 0;
  let inside = 0;
  for (let i = 0; i < n; i += 1) {
    const w = Math.max(0, Number(reach[i]) || 0);
    if (!(w > 0)) continue;
    total += w;
    for (const a of group) inside += w * strategy[a * n + i];
  }
  return total > 0 ? inside / total : 0;
}

/** Each combo's row normalised; an empty row goes to the passive action (else the first). */
function normalised(ctx: SuggestContext, node: Node): Float64Array {
  const n = NUM_COMBOS;
  const { count } = node;
  const out = new Float64Array(count * n);
  const rest = node.passive[0] ?? 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let a = 0; a < count; a += 1) {
      const p = Math.max(0, Number(ctx.strategy[a][i]) || 0);
      out[a * n + i] = p;
      sum += p;
    }
    if (sum > 0) for (let a = 0; a < count; a += 1) out[a * n + i] /= sum;
    else out[rest * n + i] = 1;
  }
  return out;
}

function check(ctx: SuggestContext): void {
  const count = ctx.actions.length;
  if (count < 1) throw new Error("nodelock suggestion: the node has no actions");
  if (ctx.strategy.length !== count) throw new Error(`nodelock suggestion: ${ctx.strategy.length} strategy rows for ${count} actions`);
  for (const row of ctx.strategy) if (row.length !== NUM_COMBOS) throw new Error(`nodelock suggestion: a strategy row has ${row.length} combos, not ${NUM_COMBOS}`);
  if (ctx.reach.length !== NUM_COMBOS) throw new Error(`nodelock suggestion: reach has ${ctx.reach.length} combos, not ${NUM_COMBOS}`);
  if (ctx.ev) {
    if (ctx.ev.length !== count) throw new Error(`nodelock suggestion: ${ctx.ev.length} EV rows for ${count} actions`);
    for (const row of ctx.ev) if (row.length !== NUM_COMBOS) throw new Error(`nodelock suggestion: an EV row has ${row.length} combos, not ${NUM_COMBOS}`);
  } else if (!ctx.strength) {
    throw new Error("nodelock suggestion: needs per-action EVs or a strength per combo");
  } else if (ctx.strength.length !== NUM_COMBOS) {
    throw new Error(`nodelock suggestion: strength has ${ctx.strength.length} combos, not ${NUM_COMBOS}`);
  }
}

function suggestedStrategy(ctx: SuggestContext, node: Node, archetype: Archetype): { base: Float64Array; out: Float64Array } {
  const n = NUM_COMBOS;
  const { count } = node;
  const base = normalised(ctx, node);
  let out = Float64Array.from(base);
  const passive = node.passive[0];

  for (const rule of rulesFor(archetype, ctx.nodeKind, ctx.street)) {
    const group = rule.group === "fold" ? node.fold : node.agg;
    if (!group.length) continue;
    const target = Math.min(1, Math.max(0, rule.target(shareOf(base, ctx.reach, group))));
    const current = shareOf(out, ctx.reach, group);
    if (rule.dir === "up" ? target <= current : target >= current) continue;
    const fallback = rule.fallback === "fold" ? (node.fold[0] ?? passive) : passive;
    if (fallback === undefined) continue;
    if (target === 0) {
      // "Never raises": all of it to the fallback, whatever else the hand mixes.
      for (let i = 0; i < n; i += 1) {
        for (const a of group) {
          out[fallback * n + i] += out[a * n + i];
          out[a * n + i] = 0;
        }
      }
      continue;
    }
    const order = orderFor(ctx, node, base, group, rule.group === "fold");
    out = Float64Array.from(lockedStrategy(out, count, n, ctx.reach, { group, share: target, order, fallback }));
  }

  // Aggressive later in the hand: part of every smaller size goes to the biggest.
  const shift = archetype === "aggressive" ? BIGGER_SIZE[ctx.street] : 0;
  if (shift > 0 && node.sizes.length >= 2) {
    const biggest = node.sizes[node.sizes.length - 1];
    for (let i = 0; i < n; i += 1) {
      for (const a of node.sizes) {
        if (a === biggest) continue;
        const m = out[a * n + i] * shift;
        out[a * n + i] -= m;
        out[biggest * n + i] += m;
      }
    }
  }

  // Rows to exactly 1 (the mover works in f32).
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let a = 0; a < count; a += 1) {
      if (out[a * n + i] < 1e-7) out[a * n + i] = 0;
      sum += out[a * n + i];
    }
    if (sum > 0) for (let a = 0; a < count; a += 1) out[a * n + i] /= sum;
    else out[(passive ?? 0) * n + i] = 1;
  }
  return { base, out };
}

function frequencies(strategy: Float64Array, reach: ArrayLike<number>, count: number): number[] {
  return Array.from({ length: count }, (_, a) => shareOf(strategy, reach, [a]));
}

/* ----------------------------------------------------------------- public - */

/**
 * What `archetype` would play at the node, as a lock of every combo. `dict`
 * picks the language of the title and explanation (English by default).
 */
export function suggestLocks(
  ctx: SuggestContext,
  archetype: Archetype,
  dict: NodelockSuggestDict = nodelockSuggestEn,
): NodelockSuggestion {
  check(ctx);
  const node = nodeOf(ctx);
  const { base, out } = suggestedStrategy(ctx, node, archetype);
  const n = NUM_COMBOS;
  const strategy = Array.from({ length: node.count }, (_, a) => Array.from(out.subarray(a * n, (a + 1) * n)));
  return {
    id: archetype,
    title: dict.title(archetype, ctx.position?.trim() || null, ctx.street),
    explanation: dict.explanation(archetype, ctx.nodeKind, ctx.street),
    nodes: [
      {
        street: ctx.street,
        path: ctx.path,
        player: ctx.player,
        actions: [...ctx.actions],
        strategy,
        locked: new Array<number>(n).fill(1),
      },
    ],
    frequencies: { before: frequencies(base, ctx.reach, node.count), after: frequencies(out, ctx.reach, node.count) },
  };
}

/** Largest change any combo's row sees under `archetype`, 0 for a no-op. */
function change(ctx: SuggestContext, node: Node, archetype: Archetype): number {
  const { base, out } = suggestedStrategy(ctx, node, archetype);
  let most = 0;
  for (let k = 0; k < out.length; k += 1) most = Math.max(most, Math.abs(out[k] - base[k]));
  return most;
}

/** The archetypes that change something at this node, in `ARCHETYPES` order (the chips to show). */
export function availableArchetypes(ctx: SuggestContext): Archetype[] {
  check(ctx);
  const node = nodeOf(ctx);
  return ARCHETYPES.filter((archetype) => change(ctx, node, archetype) > 1e-6);
}
