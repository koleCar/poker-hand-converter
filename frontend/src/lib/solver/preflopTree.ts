/**
 * The preflop betting tree for no-limit hold'em cash: 6-max by default, any
 * table from heads-up to nine-handed (`NINE_MAX`), any stack depth.
 *
 * **The action abstraction** (the sizes live in `PreflopSizing` and are part of
 * the chart's recorded assumptions):
 *
 * | Spot | Options |
 * |---|---|
 * | Unopened, UTG-BTN | fold, open to 2.5bb. No open limps. |
 * | Unopened, SB | fold, complete (limp), raise to 3bb |
 * | BB after an SB limp | check, raise to 4bb |
 * | Facing an open | fold, call, 3-bet: 3x in position, 4x out of position, plus 1x per caller (squeeze); 3x against the BB's raise over a limp |
 * | Facing a 3-bet | fold, call, 4-bet: 2.2x in position of the 3-bettor, 2.5x out of position |
 * | Facing a 4-bet | fold, call, 5-bet all-in |
 * | Facing an all-in | fold, call |
 *
 * Raise sizes are rounded to half a big blind; a raise that would leave less
 * than nothing behind is an all-in. Other stack depths change the sizes
 * (`PreflopSizing`, recorded in each chart set): at 40bb the open is 2.2bb
 * and every 4-bet is all-in (`allInAbove`).
 *
 * **What is cut, and flagged.** A full no-limit preflop tree for six players is
 * astronomically large, almost all of it multiway pots nobody plays. The tree
 * keeps the lines that make up real 6-max play and flags every node where an
 * option was removed, so a lookup can refuse to grade there:
 *
 * - **At most four players put money in.** Once four players are in
 *   voluntarily (an open, two callers and a squeeze; an open, a caller and
 *   two blinds), the players behind can only fold, and get no node
 *   (`FLAG_MULTIWAY_CAP` where a call alone is cut). A player who is already
 *   in may always call or re-raise. The cap limits who may *enter*, never
 *   who may *continue*: an earlier version capped the players in a pot, and
 *   a 4-bettor whose opponents had called a shove ahead of it was forced to
 *   fold - so the solver learned to fold AA to a 3-bet.
 * - **No cold call of a 3-bet or 4-bet.** A player who has not put money in
 *   voluntarily (the blinds count as not having done so) can fold or re-raise
 *   (`FLAG_COLD_CALL_CUT`). Cold-calling a 3-bet at 100bb is rare at
 *   equilibrium and expensive to model; facing a shove a cold player just
 *   folds and gets no node at all.
 * - **Up to four players see a flop or are all-in**, valued by the multiway
 *   realisation model (`preflopModel.ts`).
 * - **No open limps** except the small blind's, and no limp-behind.
 *
 * **Flat arrays, pre-order.** Same shape as `tree.ts`: node fields in parallel
 * typed arrays, children a contiguous slice. Node 0 is the root; ids follow a
 * depth-first walk, so a chart written in node order reads like the tree.
 *
 * **Line keys.** Each node carries the actions that lead to it as one letter
 * each - `f` fold, `k` check, `c` call (or the SB's limp), `r` raise to the
 * tree's size, `a` all-in - in table order, folds included. `"ffr"` is "UTG and
 * HJ fold, the CO opens"; the node at that key is the button's decision. The
 * actor of every letter is implied by the order, so the key is also how the
 * chart lookup walks a real hand onto the tree.
 */

import type { PotType } from "./preflopModel";

/**
 * Seat names as the stats engine assigns them (`positionRing` in
 * `lib/phf/types.ts`): a table's seats are named by their distance from the
 * button, so the 6-max UTG and the 9-max LJ are the same distance from it.
 */
export type PreflopPosition = "UTG" | "UTG+1" | "UTG+2" | "LJ" | "HJ" | "CO" | "BTN" | "SB" | "BB";

/** The six seats of a 6-max table, in preflop action order. */
export const SIX_MAX: readonly PreflopPosition[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

/** The nine seats of a full-ring table, in preflop action order. */
export const NINE_MAX: readonly PreflopPosition[] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/**
 * Postflop acting order: higher acts later (is in position). Only the order
 * matters; a table's seats are always a subsequence of `NINE_MAX`.
 */
export const POSTFLOP_ORDER: Readonly<Record<PreflopPosition, number>> = {
  SB: 0,
  BB: 1,
  UTG: 2,
  "UTG+1": 3,
  "UTG+2": 4,
  LJ: 5,
  HJ: 6,
  CO: 7,
  BTN: 8,
};

export interface PreflopSizing {
  /** Open raise to, UTG..BTN. */
  open: number;
  /** Small blind's raise to, when it raises first in. */
  sbOpen: number;
  /** Big blind's raise to over a small-blind limp. */
  isoVsLimp: number;
  /** 3-bet to, as a multiple of the raise faced: in position of the raiser. */
  threeBetIp: number;
  /** ... out of position (the blinds against a steal). */
  threeBetOop: number;
  /** The small blind's re-raise of the big blind's raise over its limp. */
  threeBetVsIso: number;
  /** Added per caller between the open and the 3-bet (a squeeze), in units of the raise faced. */
  squeezePerCaller: number;
  /** 4-bet to, as a multiple of the 3-bet: in position of the 3-bettor. */
  fourBetIp: number;
  /** ... out of position. */
  fourBetOop: number;
  /** Raise sizes are rounded to this. */
  roundTo: number;
  /**
   * A raise that would put more than this share of the starting stack in is
   * made all-in instead (a 4-bet at 40bb). Absent: only a raise that reaches
   * the stack is all-in. The 100bb trees never reach 40% before the 5-bet.
   */
  allInAbove?: number;
}

export const DEFAULT_SIZING: Readonly<PreflopSizing> = {
  open: 2.5,
  sbOpen: 3,
  isoVsLimp: 4,
  threeBetIp: 3,
  threeBetOop: 4,
  threeBetVsIso: 3,
  squeezePerCaller: 1,
  fourBetIp: 2.2,
  fourBetOop: 2.5,
  roundTo: 0.5,
};

export interface PreflopTreeConfig {
  /** Seats dealt in, in preflop action order (a subsequence of `NINE_MAX`). Default: `SIX_MAX`. */
  players?: readonly PreflopPosition[];
  /** Starting stack of every player, in big blinds. Default 100. */
  stackBb?: number;
  sizing?: Partial<PreflopSizing>;
  /**
   * Most players who may put money in voluntarily; a player not yet in can
   * neither call nor raise once this many are live. Default 4.
   */
  maxEntrants?: number;
  /** Whether the small blind may complete. Default true. */
  sbLimp?: boolean;
}

/* Node types. */
export const PF_ACTION = 0;
/** Everyone else folded; `actor` is the winner. */
export const PF_FOLD = 1;
/** Two to four players see a flop with stacks behind. */
export const PF_FLOP = 2;
/** Two or more players all-in before the flop. */
export const PF_ALLIN = 3;

/** A call was removed because the pot would become too multiway. */
export const FLAG_MULTIWAY_CAP = 1;
/** A cold call (of a 3-bet or 4-bet) was removed. */
export const FLAG_COLD_CALL_CUT = 2;
/** An open limp was removed (every unopened node but the small blind's). */
export const FLAG_LIMP_CUT = 4;

export const POT_TYPE_INDEX: readonly PotType[] = ["limped", "srp", "3bet", "4bet", "allin"];

export interface PreflopTree {
  readonly players: readonly PreflopPosition[];
  readonly stackBb: number;
  readonly sizing: Readonly<PreflopSizing>;
  readonly maxEntrants: number;
  readonly sbLimp: boolean;
  readonly size: number;
  readonly type: Uint8Array;
  /** Actor of an action node, winner of a fold terminal, -1 otherwise. */
  readonly actor: Int8Array;
  readonly childStart: Int32Array;
  readonly childCount: Int32Array;
  readonly children: Int32Array;
  /** Per edge: `f`, `k`, `c`, `r` or `a`. */
  readonly edgeCode: readonly string[];
  /** Per edge: what the actor has in after the action, in bb (0 for a fold / check that adds nothing). */
  readonly edgeTo: Float64Array;
  /** Per node and player: chips in, in bb, before the node's action (final at a terminal). */
  readonly contrib: Float64Array;
  /** Per node: bit p set while player p has not folded. */
  readonly live: Int32Array;
  /** Per node: raises so far (0 unopened, 1 opened, 2 3-bet, 3 4-bet, 4 all-in). */
  readonly level: Uint8Array;
  /** Per node: the bet to match, in bb. */
  readonly toMatch: Float64Array;
  /** Per node: the last raiser, or -1. */
  readonly aggressor: Int8Array;
  /** Per node: callers of the current raise so far. */
  readonly callers: Uint8Array;
  /** Per node: bit p set if player p has put money in voluntarily. */
  readonly voluntary: Int32Array;
  /** Per node: `FLAG_*` bits. */
  readonly flags: Uint8Array;
  /** Terminals: index into `POT_TYPE_INDEX`; 255 elsewhere. */
  readonly potType: Uint8Array;
  /** Per node: the line key (see header). */
  readonly line: readonly string[];
  /** Action node by line key. */
  readonly lineIndex: ReadonlyMap<string, number>;
  readonly maxDepth: number;
  readonly maxChildren: number;
  readonly actionNodes: number;
}

interface State {
  contrib: number[];
  live: number;
  level: number;
  toMatch: number;
  aggressor: number;
  callers: number;
  voluntary: number;
  /** Players still to act, in order. */
  pending: number[];
  limped: boolean;
  /** The current raise is the BB's raise over a limp. */
  isoRaise: boolean;
  line: string;
}

function roundSize(x: number, step: number): number {
  // The outer rounding drops float noise (22 x 0.1 = 2.2000000000000006).
  return Math.round(Math.round(x / step) * step * 1e6) / 1e6;
}

/** Builds the tree. 3,825 action nodes for 6-max with the defaults. */
export function buildPreflopTree(config: PreflopTreeConfig = {}): PreflopTree {
  const players = [...(config.players ?? SIX_MAX)];
  for (const position of players) {
    if (!NINE_MAX.includes(position)) {
      throw new Error(`unknown position ${position}`);
    }
  }
  const order = players.map((p) => NINE_MAX.indexOf(p));
  for (let k = 1; k < order.length; k += 1) {
    if (order[k] <= order[k - 1]) {
      throw new Error("players must be in preflop action order");
    }
  }
  if (players.length < 2) {
    throw new Error("need at least two players");
  }
  const n = players.length;
  const stack = config.stackBb ?? 100;
  const sizing: PreflopSizing = { ...DEFAULT_SIZING, ...config.sizing };
  const maxEntrants = config.maxEntrants ?? 4;
  const sbLimp = config.sbLimp ?? true;
  const sb = players.indexOf("SB");
  const bb = players.indexOf("BB");
  const postflop = players.map((p) => POSTFLOP_ORDER[p]);

  const type: number[] = [];
  const actor: number[] = [];
  const childStart: number[] = [];
  const childCount: number[] = [];
  const contribOut: number[] = [];
  const live: number[] = [];
  const level: number[] = [];
  const toMatch: number[] = [];
  const aggressor: number[] = [];
  const callers: number[] = [];
  const voluntary: number[] = [];
  const flags: number[] = [];
  const potType: number[] = [];
  const lines: string[] = [];
  // Children are filled after the subtree is built, per node.
  const kids: number[][] = [];
  const codes: string[][] = [];
  const tos: number[][] = [];
  let maxDepth = 0;
  let actionNodes = 0;

  const newNode = (s: State, t: number, who: number): number => {
    const id = type.length;
    type.push(t);
    actor.push(who);
    childStart.push(0);
    childCount.push(0);
    contribOut.push(...s.contrib);
    live.push(s.live);
    level.push(s.level);
    toMatch.push(s.toMatch);
    aggressor.push(s.aggressor);
    callers.push(s.callers);
    voluntary.push(s.voluntary);
    flags.push(0);
    potType.push(255);
    lines.push(s.line);
    kids.push([]);
    codes.push([]);
    tos.push([]);
    return id;
  };

  const liveCount = (mask: number) => {
    let c = 0;
    for (let p = 0; p < n; p += 1) if (mask & (1 << p)) c += 1;
    return c;
  };

  const terminal = (s: State, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    const count = liveCount(s.live);
    if (count === 1) {
      let winner = 0;
      while (!(s.live & (1 << winner))) winner += 1;
      return newNode(s, PF_FOLD, winner);
    }
    const allIn = s.toMatch >= stack;
    const id = newNode(s, allIn ? PF_ALLIN : PF_FLOP, -1);
    const pt: PotType = allIn
      ? "allin"
      : s.level === 0
        ? "limped"
        : s.level === 1
          ? "srp"
          : s.level === 2
            ? "3bet"
            : "4bet";
    potType[id] = POT_TYPE_INDEX.indexOf(pt);
    return id;
  };

  /** Raise-to size for player `p` raising at state `s`, or the stack if it would be all-in. */
  const raiseTo = (s: State, p: number): number => {
    let to: number;
    if (s.level === 0) {
      to = s.limped && p === bb ? sizing.isoVsLimp : p === sb ? sizing.sbOpen : sizing.open;
    } else if (s.level === 1) {
      if (s.isoRaise) {
        to = sizing.threeBetVsIso * s.toMatch;
      } else {
        const ip = postflop[p] > postflop[s.aggressor];
        to = (ip ? sizing.threeBetIp : sizing.threeBetOop) * s.toMatch + sizing.squeezePerCaller * s.callers * s.toMatch;
      }
    } else if (s.level === 2) {
      const ip = postflop[p] > postflop[s.aggressor];
      to = (ip ? sizing.fourBetIp : sizing.fourBetOop) * s.toMatch;
    } else {
      to = stack;
    }
    to = roundSize(to, sizing.roundTo);
    if (sizing.allInAbove !== undefined && to > sizing.allInAbove * stack) return stack;
    return to >= stack ? stack : to;
  };

  const step = (s: State, depth: number): number => {
    // Skip players whose only option is to fold: they fold silently.
    while (s.pending.length) {
      const p = s.pending[0];
      const facing = s.toMatch > s.contrib[p];
      const isVoluntary = (s.voluntary & (1 << p)) !== 0;
      const canCall = facing && callAllowed(s, p, isVoluntary);
      const canRaise = raiseAllowed(s, isVoluntary, facing);
      if (facing && !canCall && !canRaise) {
        s = { ...s, live: s.live & ~(1 << p), pending: s.pending.slice(1), line: s.line + "f" };
        continue;
      }
      break;
    }
    if (!s.pending.length || liveCount(s.live) === 1) {
      return terminal(s, depth);
    }
    const p = s.pending[0];
    const id = newNode(s, PF_ACTION, p);
    actionNodes += 1;
    const facing = s.toMatch > s.contrib[p];
    const isVoluntary = (s.voluntary & (1 << p)) !== 0;
    const rest = s.pending.slice(1);
    const edges: { code: string; to: number; next: State }[] = [];

    if (facing) {
      edges.push({
        code: "f",
        to: s.contrib[p],
        next: { ...s, live: s.live & ~(1 << p), pending: rest, line: s.line + "f" },
      });
      const canCall = callAllowed(s, p, isVoluntary);
      if (canCall) {
        const contrib = s.contrib.slice();
        contrib[p] = Math.min(s.toMatch, stack);
        const limp = s.level === 0;
        edges.push({
          code: "c",
          to: contrib[p],
          next: {
            ...s,
            contrib,
            callers: s.callers + (limp ? 0 : 1),
            voluntary: s.voluntary | (1 << p),
            limped: s.limped || limp,
            pending: rest,
            line: s.line + "c",
          },
        });
      } else if (s.level === 0) {
        flags[id] |= FLAG_LIMP_CUT;
      } else {
        flags[id] |= s.level === 1 ? FLAG_MULTIWAY_CAP : FLAG_COLD_CALL_CUT;
      }
    } else {
      // Not facing a bet: only the BB (unopened, or after an SB limp) gets here.
      edges.push({ code: "k", to: s.contrib[p], next: { ...s, pending: rest, line: s.line + "k" } });
    }

    if (raiseAllowed(s, isVoluntary, facing)) {
      const to = raiseTo(s, p);
      const contrib = s.contrib.slice();
      contrib[p] = to;
      // Everyone else still live acts again, in order after the raiser.
      const pending: number[] = [];
      for (let k = 1; k < n; k += 1) {
        const q = (p + k) % n;
        if (s.live & (1 << q) && contrib[q] < stack) pending.push(q);
      }
      edges.push({
        code: to >= stack ? "a" : "r",
        to,
        next: {
          ...s,
          contrib,
          level: s.level + 1,
          toMatch: to,
          aggressor: p,
          callers: 0,
          voluntary: s.voluntary | (1 << p),
          isoRaise: s.level === 0 && s.limped && p === bb,
          pending,
          line: s.line + (to >= stack ? "a" : "r"),
        },
      });
    }

    for (const edge of edges) {
      const child = step(edge.next, depth + 1);
      kids[id].push(child);
      codes[id].push(edge.code);
      tos[id].push(edge.to);
    }
    maxDepth = Math.max(maxDepth, depth);
    return id;
  };

  /** Players still live who have put money in voluntarily. */
  function entrants(s: State): number {
    return liveCount(s.live & s.voluntary);
  }

  /** A player already in may always continue; a new one only below the cap. */
  function mayEnter(s: State, isVoluntary: boolean): boolean {
    return isVoluntary || entrants(s) < maxEntrants;
  }

  /** Whether `p` may call at `s` under the limp, multiway and cold-call cuts. */
  function callAllowed(s: State, p: number, isVoluntary: boolean): boolean {
    if (s.level === 0) {
      // Only the small blind may limp (complete); nobody limps behind.
      return p === sb && sbLimp && !s.limped;
    }
    if (s.level === 1) {
      return mayEnter(s, isVoluntary);
    }
    // 3-bet and later: no cold calls.
    return isVoluntary;
  }

  function raiseAllowed(s: State, isVoluntary: boolean, facing: boolean): boolean {
    if (s.level >= 4 || s.toMatch >= stack) return false;
    // The big blind unopened (a walk is a terminal) or after a limp may raise.
    if (s.level === 0 && !facing && !s.limped) return false;
    return mayEnter(s, isVoluntary);
  }

  const contrib = new Array(n).fill(0);
  if (sb >= 0) contrib[sb] = 0.5;
  if (bb >= 0) contrib[bb] = 1;
  const root: State = {
    contrib,
    live: (1 << n) - 1,
    level: 0,
    toMatch: bb >= 0 ? 1 : 0.5,
    aggressor: -1,
    callers: 0,
    voluntary: 0,
    pending: players.map((_, k) => k),
    limped: false,
    isoRaise: false,
    line: "",
  };
  step(root, 0);

  // Flatten the children.
  const size = type.length;
  const flatKids: number[] = [];
  const flatCodes: string[] = [];
  const flatTo: number[] = [];
  let maxChildren = 1;
  for (let id = 0; id < size; id += 1) {
    childStart[id] = flatKids.length;
    childCount[id] = kids[id].length;
    maxChildren = Math.max(maxChildren, kids[id].length);
    flatKids.push(...kids[id]);
    flatCodes.push(...codes[id]);
    flatTo.push(...tos[id]);
  }

  const lineIndex = new Map<string, number>();
  for (let id = 0; id < size; id += 1) {
    if (type[id] === PF_ACTION) lineIndex.set(lines[id], id);
  }

  return {
    players,
    stackBb: stack,
    sizing,
    maxEntrants,
    sbLimp,
    size,
    type: Uint8Array.from(type),
    actor: Int8Array.from(actor),
    childStart: Int32Array.from(childStart),
    childCount: Int32Array.from(childCount),
    children: Int32Array.from(flatKids),
    edgeCode: flatCodes,
    edgeTo: Float64Array.from(flatTo),
    contrib: Float64Array.from(contribOut),
    live: Int32Array.from(live),
    level: Uint8Array.from(level),
    toMatch: Float64Array.from(toMatch),
    aggressor: Int8Array.from(aggressor),
    callers: Uint8Array.from(callers),
    voluntary: Int32Array.from(voluntary),
    flags: Uint8Array.from(flags),
    potType: Uint8Array.from(potType),
    line: lines,
    lineIndex,
    maxDepth,
    maxChildren,
    actionNodes,
  };
}

/**
 * The action node at a line key, or -1. Keys include the folds of players
 * whose only option was to fold (they have no node of their own).
 */
export function preflopNodeAt(tree: PreflopTree, line: string): number {
  return tree.lineIndex.get(line) ?? -1;
}

/** Total pot at a node, in bb. */
export function potAt(tree: PreflopTree, node: number): number {
  const n = tree.players.length;
  let sum = 0;
  for (let p = 0; p < n; p += 1) sum += tree.contrib[node * n + p];
  return sum;
}
