/**
 * The postflop half of the Solver library's action strip, after the preflop
 * cards (PreflopBar): a card for the flop (the board, clicked to change it),
 * one card per decision taken on it, then the turn's card and its decisions,
 * then the river's - as a solver's viewer strings the whole hand along one
 * bar.
 *
 * A decision's card lists every option the seat had, each with its colour
 * and its share of the range, the one taken highlighted: its head goes back
 * to that decision, another option takes it instead. The decision to make is
 * the highlighted card, and its options walk the line on. A locked decision
 * (the desktop app's nodelock, `lockMark`) marks its locked options and has a
 * lock button in its corner. An action that ends the street adds the next
 * street's card - dashed while its card is picked under the strip
 * (`DealPicker`), with the progress while a turn is solved here; a dealt card
 * is clicked to pick another.
 */

"use client";

import { CardRow } from "@rail/ui/cards/PlayingCard";
import type { ReactNode } from "react";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { dealtCards, exploreHistory, exploreNode, turnDeal, type ExploreAction, type FlopChunk, type PickedFlop } from "../../lib/solver";
import type { FullSolve } from "./fullSolve";
import { useSolverHost, type NodelockNode, type SolverDict } from "./host";
import { liveTurnId } from "./liveTurn";
import { actionColours } from "./StrategyView";
import styles from "./solver.module.css";

/** Where the walk is: the flop's solve, and on a turn that turn's solve and the flop's deal it came from. */
export interface Where {
  flop: FlopChunk;
  turn: FlopChunk | null;
  turnChance: number | null;
  /** A full solve, when one is served: its turn files are picked instead of solving live. */
  full: FullSolve | null;
}

/** For the app's lock marks: the library's flop chunk and, on a live turn, its deal and card (chunk suits). */
export interface MarkWhere {
  library: FlopChunk;
  turn: { chance: number; card: string } | null;
}

/** How the bar moves the view. */
export interface PostflopMoves {
  /** A decision of the flop's solve (off any turn). */
  flopNode: (node: number) => void;
  /** The flop's betting ended at `chance` (from decision `from`): the turn card is picked. */
  flopDeal: (from: number, chance: number) => void;
  /** A decision of the shown solve (the turn's on a turn, else the flop's). */
  node: (node: number) => void;
  /** A deal inside the shown solve (the turn on the flop, the river in a turn file). */
  deal: (from: number, chance: number) => void;
  /** Opens the flop picker. */
  changeFlop: () => void;
}

/** A street's betting is over at the deal: it opens the next card, unless the flop went all-in (nothing left to solve). */
function dealable(chunk: FlopChunk, deal: number): boolean {
  return deal >= 0 && (chunk.result.street === "turn" || turnDeal(chunk, deal) !== null);
}

/** The flop's card: the board as picked and the pot, or the prompt to pick one. */
export function FlopCard({ board, pot, onChange, t }: { board: readonly string[] | null; pot: number | null; onChange: () => void; t: SolverDict }) {
  return (
    <StreetCard
      name={t.panel.streetName("flop")}
      pot={pot}
      cards={board}
      title={board ? t.flop.change : t.flop.pick}
      onClick={onChange}
      acting={!board}
      flop
      t={t}
    >
      {board ? null : <span className={styles.pcardLine}>{t.flop.pick}</span>}
    </StreetCard>
  );
}

/**
 * The cards after the flop's: every decision up to the one shown (or the deal
 * being picked), with the turn's and the river's cards between them.
 */
export function PostflopCards({
  where,
  index,
  deal,
  picked,
  moves,
  marks = null,
  solving = null,
  t,
}: {
  where: Where;
  index: number;
  /** A deal of the shown solve whose card is being picked, or null. */
  deal: number | null;
  picked: PickedFlop;
  moves: PostflopMoves;
  /** Where the lock marks look (the app's nodelock only), or null. */
  marks?: MarkWhere | null;
  /** The card of `deal` being solved here (picked suits) and how far along, 0..1: the end card shows it. */
  solving?: { card: string; share: number } | null;
  t: SolverDict;
}) {
  const shown = (card: string) => picked.toPicked(card);
  const chunk = where.turn ?? where.flop;
  const nodes = chunk.result.nodes;
  // While a card is picked, the decision before the deal is the last card, its action taken.
  const last = deal !== null ? nodes[deal].parent : index;
  const cards: ReactNode[] = [];
  /** A decision's address for its lock mark: in the flop's chunk, or the shown (turn) one's. */
  const at = (onFlop: boolean, node: number): NodelockNode | null =>
    marks
      ? {
          library: marks.library,
          flop: where.flop,
          chunk: onFlop ? where.flop : chunk,
          node,
          turn: onFlop ? null : marks.turn,
          picked,
        }
      : null;

  // On a turn: the flop's decisions that led to it, then the turn's card.
  const chance = where.turnChance;
  if (where.turn && chance !== null) {
    const flopNodes = where.flop.result.nodes;
    const before = flopNodes[chance].parent;
    for (const step of exploreHistory(where.flop, before)) {
      cards.push(
        <DecisionCard
          key={`f${step.node}`}
          chunk={where.flop}
          node={step.node}
          taken={step.action.label}
          onNode={moves.flopNode}
          onDeal={moves.flopDeal}
          mark={at(true, step.node)}
          t={t}
        />,
      );
    }
    cards.push(
      <DecisionCard
        key={`f${before}`}
        chunk={where.flop}
        node={before}
        taken={exploreNode(where.flop, before).actions[flopNodes[chance].parentEdge]?.label ?? null}
        onNode={moves.flopNode}
        onDeal={moves.flopDeal}
        mark={at(true, before)}
        t={t}
      />,
    );
    cards.push(
      <StreetCard
        key="turn"
        name={t.panel.streetName("turn")}
        pot={exploreNode(where.turn, 0).pot}
        cards={[shown(where.turn.result.board[3])]}
        title={t.panel.repick("turn")}
        onClick={() => moves.flopDeal(before, chance)}
        t={t}
      />,
    );
  }

  // The shown solve's decisions, a river's card after the action that dealt it.
  const history = exploreHistory(chunk, last);
  history.forEach((step, i) => {
    cards.push(
      <DecisionCard
        key={`s${step.node}`}
        chunk={chunk}
        node={step.node}
        taken={step.action.label}
        onNode={moves.node}
        onDeal={moves.deal}
        mark={at(!where.turn, step.node)}
        t={t}
      />,
    );
    if (step.card) {
      const next = history[i + 1]?.node ?? last;
      cards.push(
        <StreetCard
          key={`r${step.node}`}
          name={t.panel.streetName("river")}
          pot={exploreNode(chunk, next).pot}
          cards={[shown(step.card)]}
          title={t.panel.repick("river")}
          onClick={() => moves.deal(step.node, step.action.deal)}
          t={t}
        />,
      );
    }
  });

  // The decision shown: to make, or made with the next street's card being picked.
  const dealing = deal !== null ? (exploreNode(chunk, last).actions[nodes[deal].parentEdge]?.label ?? null) : null;
  cards.push(
    <DecisionCard
      key={`s${last}`}
      chunk={chunk}
      node={last}
      taken={dealing}
      acting={deal === null}
      onNode={moves.node}
      onDeal={moves.deal}
      mark={at(!where.turn, last)}
      t={t}
    />,
  );
  if (deal !== null) {
    const street = where.turn ? "river" : "turn";
    cards.push(
      <div key="deal" className={`${styles.pcard} ${styles.pcardEnd}`} data-current>
        <span className={styles.pcardHead}>
          {t.panel.streetName(street)}
          <span className={styles.pcardPot}>{t.preflop.stack(dealtPot(chunk, deal))}</span>
        </span>
        {solving ? (
          <>
            <span className={styles.pcardBoard}>
              <CardRow cards={[solving.card]} size="xs" />
              <span className={styles.pcardQuiet}>{t.solving.short(solving.share)}</span>
            </span>
            <span className={styles.miniBar} aria-hidden="true">
              <span style={{ inlineSize: `${Math.round(solving.share * 100)}%` }} />
            </span>
          </>
        ) : (
          <span className={`${styles.pcardLine} ${styles.pcardQuiet}`}>{t.solving.pickBelow}</span>
        )}
      </div>,
    );
  }
  return <>{cards}</>;
}

/** The pot once a street's betting is over at a deal: the deal's parent's pot plus what the closing call put in. */
function dealtPot(chunk: FlopChunk, deal: number): number {
  const node = chunk.result.nodes[deal];
  const before = exploreNode(chunk, node.parent);
  const action = before.actions[node.parentEdge];
  return before.pot + (action?.kind === "call" ? before.toCall : 0);
}

/** One decision: the actor and their options with their shares, the one taken highlighted (none on the decision to make). */
function DecisionCard({
  chunk,
  node,
  taken,
  acting = false,
  onNode,
  onDeal,
  mark: markAt = null,
  t,
}: {
  chunk: FlopChunk;
  node: number;
  /** The option taken (its edge label), or null on the decision to make. */
  taken: string | null;
  acting?: boolean;
  onNode: (node: number) => void;
  onDeal: (from: number, chance: number) => void;
  /** This decision's address for the app's lock marks, or null. */
  mark?: NodelockNode | null;
  t: SolverDict;
}) {
  const { nodelock } = useSolverHost();
  const mark = markAt && nodelock?.lockMark ? nodelock.lockMark(markAt) : null;
  const view = exploreNode(chunk, node);
  const colours = actionColours(view.actions);
  const go = (action: ExploreAction) => {
    if (action.child >= 0) onNode(action.child);
    else if (dealable(chunk, action.deal)) onDeal(node, action.deal);
  };
  return (
    <div className={`${styles.pcard} ${acting ? styles.pcardActing : ""} ${mark ? styles.pcardLocked : ""}`} data-current={acting || undefined}>
      <button
        type="button"
        className={styles.pcardHead}
        aria-pressed={acting}
        title={taken ? t.preflop.rewind(view.position) : t.preflop.stack(chunk.result.nodes[node].behind)}
        onClick={() => onNode(node)}
      >
        {view.position}
        <span className={styles.pcardPot}>{t.preflop.stack(view.pot)}</span>
      </button>
      {view.actions.map((action, a) => {
        const isTaken = action.label === taken;
        // An option no hand takes is not one to offer - unless the line took it.
        if (!isTaken && view.totals[a].combos < 0.5) return null;
        const open = action.child >= 0 || dealable(chunk, action.deal);
        const ends = open ? null : action.ends === "fold" ? t.panel.ends.fold : t.panel.showdown;
        return (
          <button
            key={action.label}
            type="button"
            className={`${styles.opt} ${isTaken ? styles.optTaken : ""} ${taken !== null && !isTaken ? styles.optOther : ""}`}
            aria-pressed={taken !== null ? isTaken : undefined}
            aria-disabled={ends !== null}
            title={ends ?? undefined}
            onClick={() => {
              if (ends === null) go(action);
            }}
          >
            <span className={`${styles.optDot} ${colours[a]}`} aria-hidden="true" />
            <span className={styles.optLabel}>
              {t.action(action.kind, action.sizePot, action.amount)}
              {mark?.actions.has(action.label) ? mark.render(action.label) : null}
            </span>
            <span className={styles.optShare}>{t.shareOnly(view.totals[a].share)}</span>
          </button>
        );
      })}
      {mark ? mark.render(null) : null}
    </div>
  );
}

/** A street's card: its name, the pot, the card(s) dealt; clicked to pick another. */
function StreetCard({
  name,
  pot,
  cards,
  title,
  onClick,
  acting = false,
  flop = false,
  children,
  t,
}: {
  name: string;
  pot: number | null;
  cards: readonly string[] | null;
  title: string;
  onClick?: () => void;
  acting?: boolean;
  /** The flop's card: the anchor of the flop picker. */
  flop?: boolean;
  children?: ReactNode;
  t: SolverDict;
}) {
  const body = (
    <>
      <span className={styles.pcardHead}>
        {name}
        {pot !== null ? <span className={styles.pcardPot}>{t.preflop.stack(pot)}</span> : null}
      </span>
      {cards ? (
        <span className={styles.pcardBoard}>
          <CardRow cards={[...cards]} size="sm" />
        </span>
      ) : (
        children
      )}
    </>
  );
  const className = `${styles.pcard} ${styles.pcardStreet} ${acting ? styles.pcardActing : ""}`;
  return onClick ? (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      onClick={onClick}
      data-current={acting || undefined}
      data-flop={flop || undefined}
    >
      {body}
    </button>
  ) : (
    <div className={className} title={title} data-current={acting || undefined}>
      {body}
    </div>
  );
}

const RANKS = "AKQJT98765432";
const SUITS: readonly Suit[] = ["s", "h", "d", "c"];

/** Every relabelling of the suits. */
function suitPermutations(): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const walk = (left: Suit[], into: Suit[]) => {
    if (!left.length) {
      out.push(Object.fromEntries(SUITS.map((s, i) => [s, into[i]])));
      return;
    }
    left.forEach((s, i) => walk([...left.slice(0, i), ...left.slice(i + 1)], [...into, s]));
  };
  walk([...SUITS], []);
  return out;
}
const PERMUTATIONS = suitPermutations();

/**
 * For each card of the deck, the dealt card it plays as: itself when it is
 * one, else one a relabelling of the suits that keeps the board takes it to
 * (the solve deals one card of each such set). Board cards are left out.
 */
function playsAs(board: readonly string[], dealt: ReadonlySet<string>): Map<string, string> {
  const onBoard = new Set(board);
  const keeps = PERMUTATIONS.filter((p) => board.every((card) => onBoard.has(`${card[0]}${p[card[1]]}`)));
  const out = new Map<string, string>();
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      const card = `${rank}${suit}`;
      if (onBoard.has(card)) continue;
      if (dealt.has(card)) {
        out.set(card, card);
        continue;
      }
      for (const p of keeps) {
        const image = `${rank}${p[suit]}`;
        if (dealt.has(image)) {
          out.set(card, image);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The next street's card, under the strip while it is picked: the deck as four
 * rows of thirteen. A card the solve deals opens its street; a card that plays
 * the same up to suits opens the one it plays as; the board's are off.
 */
export function DealPicker({
  where,
  deal,
  picked,
  onTurn,
  onNode,
  t,
}: {
  where: Where;
  deal: number;
  picked: PickedFlop;
  /** A turn was picked: a full solve's turn file, or a live turn (`live:…`). */
  onTurn: (file: string) => void;
  /** A river was picked: the decision it deals into in the turn's solve. */
  onNode: (node: number) => void;
  t: SolverDict;
}) {
  const shown = (card: string) => picked.toPicked(card);
  let options: Array<{ card: string; go: () => void }>;
  if (!where.turn && where.full) {
    const path = where.flop.result.nodes[deal]?.path;
    options = where.full.manifest.turns.filter((x) => x.flopPath === path).map((x) => ({ card: x.card, go: () => onTurn(x.file) }));
  } else if (!where.turn) {
    // No full solve: the picked card's turn is solved here.
    options = dealtCards(where.flop, deal).map((x) => ({ card: x.card, go: () => onTurn(`live:${liveTurnId(deal, x.card)}`) }));
  } else {
    options = dealtCards(where.turn, deal)
      .filter((x) => x.node >= 0)
      .map((x) => ({ card: x.card, go: () => onNode(x.node) }));
  }
  if (!options.length) return null;
  const board = (where.turn ?? where.flop).result.board.map(shown);
  const byCard = new Map(options.map((x) => [shown(x.card), x.go]));
  const map = playsAs(board, new Set(byCard.keys()));
  const street = where.turn ? "river" : "turn";
  const text = (card: string) => `${card[0]}${SUIT_SYMBOL[card[1] as Suit]}`;
  return (
    <div className={styles.deal} role="group" aria-label={t.panel.dealPick(street)} title={t.panel.isomorphic}>
      <span className={styles.dealHead}>{t.panel.dealPick(street)}</span>
      {SUITS.map((suit) => (
        <div key={suit} className={styles.deckRow}>
          {[...RANKS].map((rank) => {
            const card = `${rank}${suit}`;
            const as = map.get(card);
            const go = as ? byCard.get(as) : undefined;
            const label = !as ? (board.includes(card) ? t.panel.onBoard(text(card)) : text(card)) : as === card ? text(card) : t.panel.playsAs(text(as));
            return (
              <button
                key={card}
                type="button"
                className={`${styles.pc} ${styles[`pc${suit.toUpperCase()}`]} ${as && as !== card ? styles.pcAlias : ""}`}
                disabled={!go}
                aria-label={as && as !== card ? `${text(card)}: ${label}` : label}
                title={label}
                onClick={go}
              >
                {text(card)}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
