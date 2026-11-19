/**
 * The decision being locked, read off the Solver library's view
 * (`NodelockAt`): the actor's hands with their reach, GTO's mix and each
 * action's EV (the editor's `EditorSpot`), the grid class and the made hand
 * and draw of every hand, the lock's address, and the suggestions' context.
 */
import {
  cardIndex,
  classOfCombo,
  comboText,
  exploreHistory,
  exploreNode,
  handFeatures,
  rangesAt,
  type ExploreAction,
  type NodeKind,
  type NodelockAt,
  type SolverDict,
  type SuggestContext,
} from "../door";
import type { LockStreet, NodeLockSpec } from "./contract";
import { LOCK_COMBOS, lockArrays, type EditorSpot, type Strategy } from "./editor/state";

export interface LockAction {
  /** The tree's label (`B1.82`). */
  label: string;
  /** In words, the library's way (`Bet 33%`). */
  name: string;
  kind: ExploreAction["kind"];
  amount: number;
  /** As a fraction of the pot (`ActionInfo.sizePot`); 0 for fold, check and call. */
  sizePot: number;
  /** The library node's action it is (its row in GTO's strategy and EVs), or null for a size of the lock's own (`editor/sizes.ts`). */
  gto: number | null;
}

export interface LockTarget {
  at: NodelockAt;
  street: LockStreet;
  player: 0 | 1;
  position: string;
  /** Out of position first (`header.players`). */
  players: [string, string];
  /** The node's own path in its chunk. */
  nodePath: string;
  /** The lock's address (`NodeLockSpec.path`). */
  path: string;
  /** The decisions before this one on its street, in words (`BB Check`). */
  steps: string[];
  /** The river card on a river lock (the chunk's suits), else null. */
  river: string | null;
  pot: number;
  toCall: number;
  /** The actor's chips behind. */
  behind: number;
  /** What the actor has put in on this street before the decision. */
  streetIn: number;
  actions: LockAction[];
  /** The library node's actions (`actions` until sizes are added or taken away). */
  library: LockAction[];
  spot: EditorSpot;
  /** Per hand: its grid cell (row * 13 + col), its cards in the picked suits, its made hand and draw (`MADE_HANDS`, `DRAWS`; -1 on the river). */
  cell: Uint8Array;
  cards: string[];
  made: Int8Array;
  draw: Int8Array;
  /** Per grid cell: the hands in it that reach the decision. */
  byCell: number[][];
}

/** The lock's address: the flop's node path, or the deal's path, the card and the turn's node path. */
export function lockPath(at: NodelockAt): string {
  const own = at.chunk.result.nodes[at.node].path;
  if (!at.turn) return own;
  return `${at.library.result.nodes[at.turn.chance].path}~${at.turn.card}/${own}`;
}

/** On a turn chunk: a river decision once a deal lies between it and the root. */
function streetOf(at: NodelockAt): LockStreet {
  if (!at.turn) return "flop";
  const nodes = at.chunk.result.nodes;
  for (let i = at.node; nodes[i].parent >= 0; i = nodes[i].parent) {
    if (nodes[nodes[i].parent].kind === "chance") return "river";
  }
  return "turn";
}

export function lockTarget(at: NodelockAt, t: SolverDict): LockTarget {
  const { chunk } = at;
  const view = exploreNode(chunk, at.node);
  const node = chunk.result.nodes[at.node];
  const player = view.player;
  const hands = chunk.result.hands[player];
  const n = hands.length;
  const reach = rangesAt(chunk.result, at.node)[player];
  const count = view.actions.length;
  const gto = Array.from({ length: count }, (_, a) => Array.from(node.strategy.subarray(a * n, (a + 1) * n)));
  const ev = Array.from({ length: count }, (_, a) => Array.from(node.ev.subarray(a * n, (a + 1) * n)));
  const history = exploreHistory(chunk, at.node);
  const river = at.turn ? (history.find((s) => s.card)?.card ?? null) : null;
  const sinceDeal = history.slice(history.findIndex((s) => s.card) + 1);
  const steps = sinceDeal.map((s) => t.panel.step(s.position, t.action(s.action.kind, s.action.sizePot, s.action.amount)));
  const library: LockAction[] = view.actions.map((a, k) => ({
    label: a.label,
    name: t.action(a.kind, a.sizePot, a.amount),
    kind: a.kind,
    amount: a.amount,
    sizePot: a.sizePot,
    gto: k,
  }));
  const board = [...chunk.result.board.map(cardIndex), ...(river ? [cardIndex(river)] : [])];
  const features = handFeatures(hands, board);
  const cell = Uint8Array.from(hands, (combo) => classOfCombo(combo));
  const byCell: number[][] = Array.from({ length: 169 }, () => []);
  cell.forEach((k, i) => {
    if (reach[i] > 0) byCell[k].push(i);
  });
  return {
    at,
    street: streetOf(at),
    player,
    position: view.position,
    players: chunk.header.players,
    nodePath: view.path,
    path: lockPath(at),
    steps,
    river,
    pot: view.pot,
    toCall: view.toCall,
    behind: node.behind,
    streetIn: streetInOf(view.path),
    actions: library,
    library,
    spot: { hands, reach, gto, ev },
    cell,
    cards: Array.from(hands, (combo) => {
      const text = comboText(combo);
      return `${at.picked.toPicked(text.slice(0, 2))}${at.picked.toPicked(text.slice(2, 4))}`;
    }),
    made: Int8Array.from(features, (f) => f.made),
    draw: Int8Array.from(features, (f) => f.draw),
    byCell,
  };
}

/**
 * What the actor has put in on this street before the decision, from the
 * node's path: the street's labels alternate between the players, so the
 * actor's last one is two back (`X-B1.82-R6`: the bettor's 1.82). A check
 * puts in nothing; a call ends the street, so none comes two back.
 */
export function streetInOf(path: string): number {
  const street = path.slice(path.lastIndexOf("|") + 1);
  const steps = street ? street.split("-") : [];
  const own = steps[steps.length - 2];
  if (!own || own[0] === "X") return 0;
  const to = Number(own.slice(1));
  return Number.isFinite(to) ? to : 0;
}

/**
 * This node's lock; `custom` when its actions are not the shown node's
 * (sizes added or taken away), or when the shown node is itself a lock's
 * own (`inherited`: opened inside a lock that changed this node's sizes).
 */
export function lockSpec(target: LockTarget, state: Strategy, inherited = false): NodeLockSpec {
  const actions = target.actions.map((a) => a.label);
  const same = !inherited && actions.length === target.library.length && actions.every((label, k) => label === target.library[k].label);
  return {
    street: target.street,
    path: target.path,
    player: target.player,
    actions,
    ...lockArrays(target.spot, state),
    ...(same ? {} : { custom: true as const }),
  };
}

/** Per-hand values spread over the 1,326 combos (0 elsewhere). */
function perCombo(target: LockTarget, values: ArrayLike<number>): number[] {
  const out = new Array<number>(LOCK_COMBOS).fill(0);
  for (let i = 0; i < target.spot.hands.length; i += 1) out[target.spot.hands[i]] = values[i];
  return out;
}

/** Who raised last before the flop on a library line (`btn-bb`, `co-bb-3bet`…), or null in a limped pot. */
function aggressorOf(line: string): string | null {
  const parts = line.toUpperCase().split("-");
  if (line.endsWith("-limp")) return null;
  if (line.endsWith("-3bet") || line.endsWith("-limp-raise")) return parts[1];
  return parts[0];
}

/** First to act, facing a bet, or facing a raise: the aggressive actions on this street so far. */
function nodeKindOf(target: LockTarget): NodeKind {
  if (target.toCall <= 0) return "first";
  const steps = exploreHistory(target.at.chunk, target.at.node);
  let raises = 0;
  for (const step of steps) {
    if (step.action.kind === "bet" || step.action.kind === "raise" || step.action.kind === "allin") raises += 1;
    // A dealt card after this action starts the next street.
    if (step.card) raises = 0;
  }
  return raises >= 2 ? "facingRaise" : "facingBet";
}

/** The suggestions' view of the decision (`nodelockSuggest.ts`). */
export function suggestContext(target: LockTarget): SuggestContext {
  return {
    street: target.street,
    path: target.path,
    player: target.player,
    position: target.position,
    role: { preflop: aggressorOf(target.at.line) === target.position ? "aggressor" : "caller", inPosition: target.player === 1 },
    nodeKind: nodeKindOf(target),
    actions: target.actions.map((a) => a.label),
    kinds: target.actions.map((a) => a.kind),
    amounts: target.actions.map((a) => a.amount),
    strategy: target.spot.gto.map((row) => perCombo(target, row)),
    reach: perCombo(target, target.spot.reach),
    ev: target.spot.ev.map((row) => perCombo(target, row)),
  };
}
