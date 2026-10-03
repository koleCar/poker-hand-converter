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

    if (toCall > EPS) {
      const fold = describe("fold", 0, 0);
      actions.push(fold);
      edges.push({ label: fold.label, child: builder.fold(me, pot, total0, total1, rake) });

      const call = describe("call", Math.min(toCall, behindMe), 0);
      actions.push(call);
      const c: [number, number] = [total0, total1];
      c[me] += call.amount;
      const allIn = stack - c[me] <= EPS || behindOp <= EPS;
      edges.push({ label: call.label, child: ctx.close(c[0], c[1], allIn, join(call.label)) });

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
          const info = describe(kind, amount, (amount - toCall) / potAfterCall);
          actions.push(info);
          const next: [number, number] = [street[0], street[1]];
          next[me] += amount;
          const increment = next[me] - street[op];
          edges.push({
            label: info.label,
            child: node(next, op, raises + 1, increment, checked, join(info.label)),
          });
        }
      }
    } else {
      const check = describe("check", 0, 0);
      actions.push(check);
      edges.push({
        label: check.label,
        child: checked
          ? ctx.close(total0, total1, false, join(check.label))
          : node(street, op, raises, lastIncrement, true, join(check.label)),
      });
      if (behindMe > EPS) {
        const amounts = sized(menu.bet, (x) => x * potNow, rules.minBet, (amount) => amount / potNow);
        for (const amount of amounts) {
          const kind: ActionKind = behindMe - amount <= EPS ? "allin" : "bet";
          const info = describe(kind, amount, amount / potNow);
          actions.push(info);
          const next: [number, number] = [street[0], street[1]];
          next[me] += amount;
          edges.push({
            label: info.label,
            child: node(next, op, raises, amount, checked, join(info.label)),
          });
        }
      }
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

/** Path segment for a dealt card. */
export function dealtPath(path: string, card: number): string {
  return `${path}|${cardCode(card)}|`;
}
