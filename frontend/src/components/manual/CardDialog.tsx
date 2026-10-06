"use client";

import { useDict } from "../../lib/i18n/client";
import { BOARD_SIZE, HOLE_CARDS, type EngineState } from "../../lib/manual";
import { CardPicker } from "../learn/CardPicker";
import { Overlay } from "../ui/Overlay";
import { usedCards, type EditorState } from "./editorState";
import styles from "./manual.module.css";

/** Whose cards the dialog is picking. */
export type CardTarget = { kind: "seat"; seat: number } | { kind: "board" };

type Update = (patch: Partial<EditorState> | ((current: EditorState) => EditorState)) => void;

interface CardDialogProps {
  target: CardTarget | null;
  state: EditorState;
  update: Update;
  engine: EngineState;
  onClose: () => void;
}

/**
 * One card picker for every card in the hand, in a dialog.
 *
 * Cards used anywhere else in the hand are blocked, so a deck can never hold
 * two aces of spades. Board cards are dealt in the order they are clicked:
 * the first three are the flop, then the turn, then the river.
 */
export function CardDialog({ target, state, update, engine, onClose }: CardDialogProps) {
  const t = useDict().manual;
  if (!target) return null;

  const seat = target.kind === "seat" ? state.seats.find((entry) => entry.seat === target.seat) : undefined;
  const selected = target.kind === "board" ? state.board : (seat?.cards ?? []);
  const blocked = usedCards(state).filter((card) => !selected.includes(card));
  const status = engine.status;
  const boardMax = status.kind === "needs-board" && !status.runout ? Math.max(BOARD_SIZE[status.street], state.board.length) : 5;
  const max = target.kind === "board" ? boardMax : HOLE_CARDS[state.variant];
  const title = target.kind === "board" ? t.actions.board : t.players.pickCards(seat?.name ?? "");

  const onChange = (next: string[]) => {
    // Picking the last card a street (or a hand) needs is the end of the job.
    if (next.length === max && next.length > selected.length) onClose();
    if (target.kind === "board") {
      update({ board: next });
    } else {
      update((current) => ({
        ...current,
        seats: current.seats.map((entry) => (entry.seat === target.seat ? { ...entry, cards: next } : entry)),
      }));
    }
  };

  return (
    <Overlay open onClose={onClose} title={title}>
      <div className={styles.dialog}>
        <CardPicker label={title} selected={selected} max={max} blocked={blocked} onChange={onChange} />
        <div className={styles.row}>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t.players.done}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
