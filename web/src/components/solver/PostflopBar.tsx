/**
 * The postflop half of the Solver library's line, laid out as the preflop
 * cards before it (PreflopBar): a card for the flop (the board, clicked to
 * change it), one card per decision taken on it, then the turn's card and its
 * decisions, then the river's - as a solver's viewer strings the whole hand
 * along one bar.
 *
 * A past decision's card lists every option the seat had, the one taken
 * highlighted: its head goes back to that decision, another option takes it
 * instead. The decision to make is the highlighted card, and its options walk
 * the line on. An action that ends the street adds the next street's card,
 * whose card is picked under the bar (`DealPicker`); a dealt card is clicked
 * to pick another.
 */

"use client";

import { CardRow } from "@rail/ui/cards/PlayingCard";
import type { ReactNode } from "react";
import { dealtCards, exploreHistory, exploreNode, turnDeal, type ExploreAction, type FlopChunk, type PickedFlop } from "../../lib/solver";
import analysis from "../analysis/analysis.module.css";
import type { FullSolve } from "./fullSolve";
import type { SolverDict } from "./host";
import { liveTurnId } from "./liveTurn";
import styles from "./solver.module.css";

/** Where the walk is: the flop's solve, and on a turn that turn's solve and the flop's deal it came from. */
export interface Where {
  flop: FlopChunk;
  turn: FlopChunk | null;
  turnChance: number | null;
  /** A full solve, when one is served: its turn files are picked instead of solving live. */
  full: FullSolve | null;
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
      t={t}
    >
      {board ? null : <span className={styles.streetPick}>{t.flop.pick}</span>}
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
  t,
}: {
  where: Where;
  index: number;
  /** A deal of the shown solve whose card is being picked, or null. */
  deal: number | null;
  picked: PickedFlop;
  moves: PostflopMoves;
  t: SolverDict;
}) {
  const shown = (card: string) => picked.toPicked(card);
  const chunk = where.turn ?? where.flop;
  const nodes = chunk.result.nodes;
  // While a card is picked, the decision before the deal is the last card, its action taken.
  const last = deal !== null ? nodes[deal].parent : index;
  const cards: ReactNode[] = [];

  // On a turn: the flop's decisions that led to it, then the turn's card.
  const chance = where.turnChance;
  if (where.turn && chance !== null) {
    const flopNodes = where.flop.result.nodes;
    const before = flopNodes[chance].parent;
    for (const step of exploreHistory(where.flop, before)) {
      cards.push(
        <DecisionCard key={`f${step.node}`} chunk={where.flop} node={step.node} taken={step.action.label} onNode={moves.flopNode} onDeal={moves.flopDeal} t={t} />,
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
    cards.push(<DecisionCard key={`s${step.node}`} chunk={chunk} node={step.node} taken={step.action.label} onNode={moves.node} onDeal={moves.deal} t={t} />);
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
    <DecisionCard key={`s${last}`} chunk={chunk} node={last} taken={dealing} acting={deal === null} onNode={moves.node} onDeal={moves.deal} t={t} />,
  );
  if (deal !== null) {
    const street = where.turn ? "river" : "turn";
    cards.push(<StreetCard key="deal" name={t.panel.streetName(street)} pot={null} cards={null} title={t.panel.dealPick(street)} acting t={t} />);
  }
  return <>{cards}</>;
}

/** One decision: the actor and their options, the one taken highlighted (none on the decision to make). */
function DecisionCard({
  chunk,
  node,
  taken,
  acting = false,
  onNode,
  onDeal,
  t,
}: {
  chunk: FlopChunk;
  node: number;
  /** The option taken (its edge label), or null on the decision to make. */
  taken: string | null;
  acting?: boolean;
  onNode: (node: number) => void;
  onDeal: (from: number, chance: number) => void;
  t: SolverDict;
}) {
  const view = exploreNode(chunk, node);
  const go = (action: ExploreAction) => {
    if (action.child >= 0) onNode(action.child);
    else if (dealable(chunk, action.deal)) onDeal(node, action.deal);
  };
  return (
    <div className={`${styles.seat} ${acting ? styles.seatActing : ""}`} data-current={acting || undefined}>
      <button
        type="button"
        className={styles.seatHead}
        aria-pressed={acting}
        title={taken ? t.preflop.rewind(view.position) : undefined}
        onClick={() => onNode(node)}
      >
        <strong>{view.position}</strong>
        <span>{t.preflop.stack(chunk.result.nodes[node].behind)}</span>
      </button>
      <div className={styles.seatOptions}>
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
              className={`${styles.seatOption} ${isTaken ? styles.seatTaken : ""} ${taken !== null && !isTaken ? styles.seatAhead : ""}`}
              aria-pressed={taken !== null ? isTaken : undefined}
              aria-disabled={ends !== null}
              title={ends ?? undefined}
              onClick={() => {
                if (ends === null) go(action);
              }}
            >
              {t.action(action.kind, action.sizePot, action.amount)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A street's card: its name, the pot, the card(s) dealt - or, while it is picked, an empty slot. */
function StreetCard({
  name,
  pot,
  cards,
  title,
  onClick,
  acting = false,
  children,
  t,
}: {
  name: string;
  pot: number | null;
  cards: readonly string[] | null;
  title: string;
  onClick?: () => void;
  acting?: boolean;
  children?: ReactNode;
  t: SolverDict;
}) {
  const body = (
    <>
      <span className={styles.streetHead}>
        <strong>{name}</strong>
        {pot !== null ? <span>{t.panel.pot(pot, 0)}</span> : null}
      </span>
      {cards ? <CardRow cards={[...cards]} size="xs" /> : children ?? <span className={styles.streetSlot} aria-hidden="true" />}
    </>
  );
  const className = `${styles.seat} ${styles.street} ${acting ? styles.seatActing : ""}`;
  return onClick ? (
    <button type="button" className={className} title={title} aria-label={title} onClick={onClick} data-current={acting || undefined}>
      {body}
    </button>
  ) : (
    <div className={className} title={title} data-current={acting || undefined}>
      {body}
    </div>
  );
}

/** The cards a deal can deal, under the bar while the turn (or the river) is picked. */
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
  options.sort((a, b) => "AKQJT98765432".indexOf(a.card[0]) - "AKQJT98765432".indexOf(b.card[0]) || a.card.localeCompare(b.card));
  if (!options.length) return null;
  const street = where.turn ? "river" : "turn";
  return (
    <div className={styles.dealRow} role="group" aria-label={t.panel.dealPick(street)}>
      <p className={analysis.muted}>{t.panel.dealPick(street)}</p>
      <div className={styles.dealCards}>
        {options.map((x) => (
          <button key={x.card} type="button" className={styles.dealCard} onClick={x.go} aria-label={shown(x.card)}>
            <CardRow cards={[shown(x.card)]} size="xs" />
          </button>
        ))}
      </div>
      <p className={analysis.muted}>{t.panel.isomorphic}</p>
    </div>
  );
}
