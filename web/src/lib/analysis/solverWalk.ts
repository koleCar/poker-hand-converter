/**
 * A hand's line as a Solver library link (`/solver?…&walk=`): the postflop
 * actions before a decision, street by street, with the turn and river cards
 * between them, in words the library's trees all read - the action, a size as
 * a share of the pot, all-in or not - never a node of one particular solve.
 *
 * ```
 * x-b33-c-Kh-x-b75-c-7s-x      check, bet 33% pot, call · K♥ · check, bet 75%, call · 7♠ · check
 * ```
 *
 * The analysis grades a turn or river from its own solve of the hand's ranges;
 * the Solver library solves the turn live from the flop library's chunk
 * (`lib/solver/liveTurn.ts`). The trees are not the same, so the link carries
 * the line, and the library follows it onto whatever tree it has
 * (`followWalk`) by the rule the grades follow a line by (`lineEdge`): the
 * flop chunk, then - the walk reaching a turn deal with a card - that turn's
 * solve, its river deal and the river's decisions.
 *
 * Cards are in the hand's own suits. A solve's deal names one card per
 * suit-isomorphism class, so a card the deal does not name is read as the one
 * of its class it does, and the later cards are relabelled the same way.
 */

import { CHART_SETS } from "../charts";
import { cardCode, cardIndex } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import { boardSymmetries, permuteCard, type FlopChunk } from "../solver";
import { FLOP_LIBRARY_SETS, flopLinesFor } from "./flopLibrary";
import { lineEdge, streetActs } from "./river";
import type { DecisionAnalysis } from "./types";

/** One step of a walk: a player's action, or the card a deal deals. */
export type WalkStep =
  | { kind: "act"; type: "fold" | "check" | "call" | "bet" | "raise"; sizePot: number | null; allIn: boolean }
  | { kind: "card"; card: string };

const CARD_RE = /^[2-9TJQKA][cdhs]$/;
const ACT_RE = /^(?:([fxc])|([br])(\d{1,4})(a?))$/;
const SIMPLE = { f: "fold", x: "check", c: "call" } as const;
/** The longest walk a link carries: far more than any heads-up line. */
const MAX_STEPS = 40;

/** A walk as the link writes it: steps joined by `-`. */
export function encodeWalk(steps: readonly WalkStep[]): string {
  return steps
    .map((step) => {
      if (step.kind === "card") return step.card;
      if (step.type === "fold") return "f";
      if (step.type === "check") return "x";
      if (step.type === "call") return "c";
      return `${step.type === "bet" ? "b" : "r"}${Math.max(0, Math.round((step.sizePot ?? 0) * 100))}${step.allIn ? "a" : ""}`;
    })
    .join("-");
}

/** A link's walk, or null when it is not one. */
export function parseWalk(text: string | null | undefined): WalkStep[] | null {
  if (!text) return null;
  const tokens = text.split("-");
  if (tokens.length > MAX_STEPS) return null;
  const steps: WalkStep[] = [];
  for (const token of tokens) {
    if (CARD_RE.test(token)) {
      steps.push({ kind: "card", card: token });
      continue;
    }
    const match = ACT_RE.exec(token);
    if (!match) return null;
    if (match[1]) {
      steps.push({ kind: "act", type: SIMPLE[match[1] as keyof typeof SIMPLE], sizePot: null, allIn: false });
    } else {
      steps.push({ kind: "act", type: match[2] === "b" ? "bet" : "raise", sizePot: Number(match[3]) / 100, allIn: match[4] === "a" });
    }
  }
  return steps;
}

const STREETS = ["flop", "turn", "river"] as const;

/**
 * The walk to a postflop decision of the hand: both players' actions before
 * it from the flop on, and the turn and river cards it saw (`facts.board`).
 * Null preflop, or when the board is short of the decision's street.
 */
export function handWalk(hand: PhfHand, decision: Pick<DecisionAnalysis, "street" | "actionIndex" | "facts">): WalkStep[] | null {
  const last = STREETS.indexOf(decision.street as (typeof STREETS)[number]);
  if (last < 0) return null;
  const board = decision.facts.board;
  if (board.length < 3 + last) return null;
  const steps: WalkStep[] = [];
  for (let s = 0; s <= last; s += 1) {
    if (s > 0) steps.push({ kind: "card", card: board[2 + s] });
    for (const act of streetActs(hand, STREETS[s])) {
      if (act.index >= decision.actionIndex) break;
      steps.push({ kind: "act", type: act.type, sizePot: act.sizePot, allIn: act.allIn });
    }
  }
  return steps;
}

/** Where a walk ended on one solve. */
export interface WalkEnd {
  /** The decision to show: where the walk ended, or the last one before it stopped. */
  node: number;
  /**
   * The walk stopped at this deal: the next card is this solve's last word
   * (the flop chunk stops at its turn deals), or no card was given or read.
   */
  deal: number | null;
  /** The card `deal` deals, as the solve names it (one of the deal's labels); null when there is none. */
  card: string | null;
  /** The steps after `card`, for the next street's solve. */
  rest: WalkStep[];
  /** The hand's suits to this solve's: `perm[s]` is the solve's suit for the hand's suit `s`. */
  perm: number[];
  /** Every step was followed (to a decision, or to a deal handed on with its card). */
  complete: boolean;
}

/**
 * The card a deal deals for a card of the hand: the card in the solve's suits,
 * or the one of its isomorphism class the deal names, with the relabelling
 * that took it there folded into `perm`. Null when the deal has no such card
 * (a representative flop holding it, say).
 */
function dealtLabel(chunk: FlopChunk, deal: number, card: string, perm: readonly number[]): { label: string; perm: number[] } | null {
  const node = chunk.result.nodes[deal];
  const own = permuteCard(cardIndex(card), perm);
  if (node.labels.includes(cardCode(own))) return { label: cardCode(own), perm: [...perm] };
  // The solve's own symmetries when it kept them (a turn solve), else the board's: the library's ranges are suit-blind.
  const group = chunk.result.isomorphism?.group ?? boardSymmetries(chunk.result.board);
  for (const sigma of group) {
    const label = cardCode(permuteCard(own, sigma));
    if (node.labels.includes(label)) return { label, perm: perm.map((s) => sigma[s]) };
  }
  return null;
}

/**
 * Follows a walk from a solve's root (the flop chunk's, or a turn solve's),
 * `perm` taking the hand's suits to the solve's. Stops where the tree has no
 * edge for a step, the line ends, or a deal hands the street on to another
 * solve (the turn, from the flop chunk).
 */
export function followWalk(chunk: FlopChunk, steps: readonly WalkStep[], perm: readonly number[]): WalkEnd {
  const nodes = chunk.result.nodes;
  let at = 0;
  let decision = 0;
  let suits = [...perm];
  const off = (): WalkEnd => ({
    node: nodes[at]?.kind === "action" ? at : decision,
    deal: null,
    card: null,
    rest: [],
    perm: suits,
    complete: false,
  });
  for (let k = 0; k < steps.length; k += 1) {
    const step = steps[k];
    const node = nodes[at];
    if (!node) return off();
    if (step.kind === "act") {
      if (node.kind !== "action") return off();
      const taken = lineEdge(node, { type: step.type, to: 0, allIn: step.allIn, sizePot: step.sizePot }, Number.POSITIVE_INFINITY);
      if (!taken) return off();
      const next = node.children[taken.edge];
      if (next < 0) return off();
      at = next;
      if (nodes[at].kind === "action") decision = at;
      continue;
    }
    if (node.kind !== "chance") return off();
    const dealt = dealtLabel(chunk, at, step.card, suits);
    if (!dealt) return { node: decision, deal: at, card: null, rest: [], perm: suits, complete: false };
    suits = dealt.perm;
    const next = node.children[node.labels.indexOf(dealt.label)];
    // The chunk ends at the deal: the street goes on in another solve.
    if (next < 0 || nodes[next].kind !== "action") {
      return { node: decision, deal: at, card: dealt.label, rest: steps.slice(k + 1), perm: suits, complete: true };
    }
    at = next;
    decision = at;
  }
  if (nodes[at]?.kind === "chance") return { node: decision, deal: at, card: null, rest: [], perm: suits, complete: true };
  return { node: at, deal: null, card: null, rest: [], perm: suits, complete: true };
}

/** Where a link to the Solver library lands: `paths.solver`'s view. */
export interface SolverLink {
  set: string;
  /** The preflop line, in the charts' letters. */
  line: string;
  /** The flop as the library reads it: the hand's own, in its suits, or the representative it was read from. */
  flop: string;
  walk: string;
  /** The walk reaches the decision's own street; false when a representative flop stops it at the turn's deal. */
  exact: boolean;
}

/**
 * The Solver library at a postflop decision of a hand: the table and the
 * preflop line its charts were read from, the flop the library graded, and
 * the hand's line to the decision - on the turn and the river too, which the
 * library solves live from the flop. A flop read from a representative
 * (`facts.flop.mapped`) has none of the hand's turns and rivers: its link
 * follows the flop and stops at the turn's deal. Null preflop, multiway, or
 * where the library graded no flop decision of the hand.
 */
export function solverLinkOf(decisions: readonly DecisionAnalysis[], decision: DecisionAnalysis, hand: PhfHand): SolverLink | null {
  if (decision.street === "preflop") return null;
  const set = decisions.find((d) => d.facts.chart?.set)?.facts.chart?.set ?? null;
  if (!set || !(FLOP_LIBRARY_SETS as readonly string[]).includes(set)) return null;
  // Any flop decision the library graded names the line and the flop: the hand has one of each.
  const facts = decision.facts.flop ?? decisions.find((d) => d.street === "flop" && d.facts.flop)?.facts.flop ?? null;
  if (!facts) return null;
  const players = CHART_SETS.find((s) => s.id === set)?.players;
  const line = players ? flopLinesFor(players).find((l) => l.id === facts.line) : undefined;
  if (!line) return null;
  const steps = handWalk(hand, decision);
  if (!steps) return null;
  const own = decision.facts.board.slice(0, 3).join("");
  const mapped = facts.mapped || own.length !== 6;
  const firstCard = steps.findIndex((step) => step.kind === "card");
  return {
    set,
    line: line.key,
    flop: mapped ? facts.flop : own,
    walk: encodeWalk(mapped && firstCard >= 0 ? steps.slice(0, firstCard) : steps),
    exact: !mapped || firstCard < 0,
  };
}
