/**
 * No-limit betting trees from a bet-size menu.
 *
 * **The abstraction is the menu.** No-limit has a continuum of sizes; a solver
 * has a handful. Each player gets bet sizes as fractions of the pot, raise
 * sizes as fractions of the pot *after calling* (the convention every solver
 * shares, so "a pot-sized raise" means the same thing here as anywhere), and
 * an all-in switch. Real sizes are mapped onto these by `translation.ts`.
 *
 * **Rules applied while building**, in this order, so the tree contains only
 * legal and distinct actions:
 *
 *  1. A bet is at least `minBet`; a raise adds at least the previous bet or
 *     raise increment (no-limit's minimum raise).
 *  2. A size at or above what the player has behind becomes all-in.
 *  3. A size that would leave less than `allInThreshold x` the pot-after-call
 *     behind becomes all-in too: a bet that leaves 3bb behind into a 60bb pot
 *     is an all-in in all but name, and solving both wastes a branch.
 *  4. Sizes that land on the same amount are merged.
 *  5. After `raiseCap` raises on a street only fold and call remain.
 *
 * **Labels** are the action letters the stats engine already uses - `X` check,
 * `F` fold, `C` call, `B` bet, `R` raise, `A` all-in - with the street total
 * the player is putting in after the action (`B6.5` bets 6.5; `R20` raises to
 * 20). A node's path is its labels joined by `-`, with `|card|` where a card
 * is dealt, so `X-B6.5-C|7h|X` names a river node on its own.
 */

import { cardCode } from "../equity";
import { SolverInputError } from "./combos";
import { TreeBuilder, type Edge, type Rake } from "./tree";

export interface BetMenu {
  /** Bets as fractions of the pot, offered when no bet faces the player. */
  bet: readonly number[];
  /** Raises as fractions of the pot after the call, offered against a bet. */
  raise: readonly number[];
  /** Whether all-in is offered as a bet and as a raise. */
  allIn: boolean;
  /**
   * Offer the all-in only while it is at most this many pots (a bet's amount
   * over the pot; a raise's increment over the pot after the call). A 9x-pot
   * turn shove with 90bb behind is a branch the tree pays for on every
   * iteration and nobody takes; with a lower stack the same shove is an
   * ordinary size and stays. A menu size that reaches the stack is an all-in
   * either way. Unset: always offered.
   */
  allInMaxPot?: number;
}

export interface BettingRules {
  /** Per player index (the index of the player's range, not their position). */
  menus: readonly [BetMenu, BetMenu];
  /** Raises allowed per street after the first bet. */
  raiseCap: number;
  /** See rule 3 in the header. 0 disables it. */
  allInThreshold: number;
  /** Smallest bet, in chips. */
  minBet: number;
  /**
   * A node's own actions, by its path (`X-B1.82`): the labels it offers in
   * place of the menu's, as a nodelock's custom sizes set them (`B8.25`
   * bets to 8.25). A label the menu gives keeps the menu's exact amount; any
   * other is taken at its own (`nodeActionsOf`).
   */
  nodeActions?: Readonly<Record<string, readonly string[]>>;
}

export type ActionKind = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface ActionInfo {
  label: string;
  kind: ActionKind;
  /** Chips this action puts in. */
  amount: number;
  /** The player's street total after the action. */
  to: number;
  /**
   * Size as a fraction of the pot, the unit action translation works in: a
   * bet's amount over the pot; a raise's increment over the call, over the pot
   * after the call. 0 for fold, check and call.
   */
  sizePot: number;
}

/** What the result needs to describe an action node of a betting street. */
export interface NodeInfo {
  street: "flop" | "turn" | "river";
  path: string;
  /** Pot before this decision, including every bet already in. */
  pot: number;
  toCall: number;
  /** Chips the actor still has behind. */
  behind: number;
  actions: ActionInfo[];
}

export interface StreetContext {
  builder: TreeBuilder;
  street: "flop" | "turn" | "river";
  /** Dead money at the start of the subgame. */
  pot: number;
  /** Effective stack at the start of the subgame. */
  stack: number;
  rake: Rake | undefined;
  /** Player index who acts first on every street. */
  first: 0 | 1;
  rules: BettingRules;
  /** Node info per node id, filled as nodes are built. */
  info: (NodeInfo | undefined)[];
  /**
   * Builds whatever follows a street that closed with a call or two checks:
   * contributions are subgame totals; `allIn` when nobody has chips behind.
   */
  close: (c0: number, c1: number, allIn: boolean, path: string) => number;
}

const EPS = 1e-9;

/** Number with at most two decimals, no trailing zeros: `6.5`, `20`, `3.33`. */
export function formatAmount(x: number): string {
  return String(Math.round(x * 100) / 100);
}

/**
 * Builds one street of betting. `base` is each player's subgame contribution
 * before the street. Returns the street's first node.
 */
export function buildStreet(ctx: StreetContext, base: readonly [number, number], path: string): number {
  const { builder, rules, stack, pot, rake } = ctx;

  const node = (
    street: [number, number],
    toAct: number,
    raises: number,
    lastIncrement: number,
    checked: boolean,
    at: string,
  ): number => {
    const me = toAct;
    const op = 1 - toAct;
    const total0 = base[0] + street[0];
    const total1 = base[1] + street[1];
    const potNow = pot + total0 + total1;
    const behindMe = stack - (base[me] + street[me]);
    const behindOp = stack - (base[op] + street[op]);
    const toCall = street[op] - street[me];
    const menu = rules.menus[me];
    const edges: Edge[] = [];
    const actions: ActionInfo[] = [];
    const join = (label: string) => (!at || at.endsWith("|") ? at + label : `${at}-${label}`);

    const sized = (
      fractions: readonly number[],
      amountOf: (x: number) => number,
      floor: number,
      potsOf: (amount: number) => number,
    ) => {
      // Rule 1 floor, rules 2-3 to all-in, rule 4 merge.
      const maxAmount = behindMe;
      const out = new Map<string, number>();
      const push = (amount: number) => {
        const a = Math.min(Math.max(amount, floor), maxAmount);
        const raiseTo = street[me] + a;
        const afterCall = potNow + a + (raiseTo - street[op]);
        const allIn = maxAmount - a <= EPS || maxAmount - a < rules.allInThreshold * afterCall;
        const final = allIn ? maxAmount : a;
        out.set(formatAmount(street[me] + final), final);
      };
      for (const x of fractions) {
        push(amountOf(x));
      }
      if (menu.allIn && !(potsOf(maxAmount) > (menu.allInMaxPot ?? Infinity) + EPS)) {
        push(maxAmount);
      }
      return [...out.values()].sort((a, b) => a - b);
    };

    const describe = (kind: ActionKind, amount: number, sizePot: number): ActionInfo => {
      const to = street[me] + amount;
      const letter = { fold: "F", check: "X", call: "C", bet: "B", raise: "R", allin: "A" }[kind];
      const label = kind === "bet" || kind === "raise" || kind === "allin" ? letter + formatAmount(to) : letter;
      return { label, kind, amount, to, sizePot };
    };

    // The menu's actions, then the node's own in their place where it has them.
    let planned: ActionInfo[] = [];
    if (toCall > EPS) {
      planned.push(describe("fold", 0, 0), describe("call", Math.min(toCall, behindMe), 0));
      if (raises < rules.raiseCap && behindOp > EPS && behindMe > toCall + EPS) {
        const potAfterCall = potNow + toCall;
        const floor = toCall + Math.max(lastIncrement, rules.minBet);
        const amounts = sized(
          menu.raise,
          (x) => toCall + x * potAfterCall,
          floor,
          (amount) => (amount - toCall) / potAfterCall,
        );
        for (const amount of amounts) {
          const kind: ActionKind = behindMe - amount <= EPS ? "allin" : "raise";
          planned.push(describe(kind, amount, (amount - toCall) / potAfterCall));
        }
      }
    } else {
      planned.push(describe("check", 0, 0));
      if (behindMe > EPS) {
        const amounts = sized(menu.bet, (x) => x * potNow, rules.minBet, (amount) => amount / potNow);
        for (const amount of amounts) {
          const kind: ActionKind = behindMe - amount <= EPS ? "allin" : "bet";
          planned.push(describe(kind, amount, amount / potNow));
        }
      }
    }
    const own = rules.nodeActions?.[at];
    if (own) planned = nodeActionsOf(at, own, planned, { street: street[me], toCall, behind: behindMe, pot: potNow });

    for (const info of planned) {
      actions.push(info);
      let child: number;
      if (info.kind === "fold") {
        child = builder.fold(me, pot, total0, total1, rake);
      } else if (info.kind === "call") {
        const c: [number, number] = [total0, total1];
        c[me] += info.amount;
        const allIn = stack - c[me] <= EPS || behindOp <= EPS;
        child = ctx.close(c[0], c[1], allIn, join(info.label));
      } else if (info.kind === "check") {
        child = checked
          ? ctx.close(total0, total1, false, join(info.label))
          : node(street, op, raises, lastIncrement, true, join(info.label));
      } else {
        const next: [number, number] = [street[0], street[1]];
        next[me] += info.amount;
        child =
          toCall > EPS
            ? node(next, op, raises + 1, next[me] - street[op], checked, join(info.label))
            : node(next, op, raises, info.amount, checked, join(info.label));
      }
      edges.push({ label: info.label, child });
    }

    const id = builder.action(me, edges);
    ctx.info[id] = {
      street: ctx.street,
      path: at,
      pot: potNow,
      toCall: Math.max(0, toCall),
      behind: behindMe,
      actions,
    };
    return id;
  };

  return node([0, 0], ctx.first, 0, 0, false, path);
}

/** Where a node stands, for its own actions: the actor's street total, what it has to call, its chips behind and the pot. */
export interface NodeStand {
  street: number;
  toCall: number;
  behind: number;
  pot: number;
}

/**
 * A node's own actions (`BettingRules.nodeActions`) from their labels: a
 * label among the menu's (`menu`) keeps the menu's action, exact amount
 * included; another is read off the label (`B8.25` bets to 8.25, `A100`
 * is all-in). Throws on a label that is not legal here: a check facing a
 * bet, a bet below a raise's minimum, an all-in that is not the stack.
 */
export function nodeActionsOf(path: string, labels: readonly string[], menu: readonly ActionInfo[], at: NodeStand): ActionInfo[] {
  const fail = (label: string, why: string): never => {
    throw new SolverInputError(`${path || "the root"}: ${label} ${why}`);
  };
  if (!labels.length) fail("(none)", "leaves the node without an action");
  const seen = new Set<string>();
  return labels.map((label) => {
    if (seen.has(label)) fail(label, "is there twice");
    seen.add(label);
    const known = menu.find((a) => a.label === label);
    if (known) return known;
    const facing = at.toCall > EPS;
    const letter = label[0];
    if (letter === "X" || letter === "F" || letter === "C") {
      if (label.length > 1) fail(label, "is not an action");
      if ((letter === "X") === facing) fail(label, facing ? "faces a bet" : "has no bet to answer");
      return letter === "X"
        ? { label, kind: "check", amount: 0, to: at.street, sizePot: 0 }
        : letter === "F"
          ? { label, kind: "fold", amount: 0, to: at.street, sizePot: 0 }
          : { label, kind: "call", amount: Math.min(at.toCall, at.behind), to: at.street + Math.min(at.toCall, at.behind), sizePot: 0 };
    }
    const to = Number(label.slice(1));
    if (!(letter === "B" || letter === "R" || letter === "A") || !Number.isFinite(to)) fail(label, "is not an action");
    const amount = to - at.street;
    const sizePot = (a: number) => (facing ? (a - at.toCall) / (at.pot + at.toCall) : a / at.pot);
    if (letter === "A") {
      // The label rounds to two decimals; the stack is exact.
      if (Math.abs(amount - at.behind) > 0.006) fail(label, `is not all-in (${formatAmount(at.street + at.behind)})`);
      return { label, kind: "allin", amount: at.behind, to: at.street + at.behind, sizePot: sizePot(at.behind) };
    }
    if ((letter === "R") !== facing) fail(label, facing ? "is a bet facing a bet" : "raises no bet");
    if (!(amount > (facing ? at.toCall : 0) + EPS)) fail(label, "is too small");
    if (facing && amount - at.toCall < at.toCall - 0.006) fail(label, "raises less than the minimum");
    if (!(amount < at.behind - EPS)) fail(label, "is the stack or more: that is all-in");
    return { label, kind: facing ? "raise" : "bet", amount, to, sizePot: sizePot(amount) };
  });
}

/** Path segment for a dealt card. */
export function dealtPath(path: string, card: number): string {
  return `${path}|${cardCode(card)}|`;
}
