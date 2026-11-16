"use client";

import { useDict } from "../../lib/i18n/client";
import type { EngineState } from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { AmountInput } from "./AmountInput";
import type { CardTarget } from "./CardDialog";
import { formatFor, type AmountMode, type EditorState } from "./editorState";
import styles from "./manual.module.css";

type Update = (patch: Partial<EditorState> | ((current: EditorState) => EditorState)) => void;

interface SeatPanelProps {
  seat: number;
  state: EditorState;
  update: Update;
  engine: EngineState;
  onPickCards: (target: CardTarget) => void;
  mode: AmountMode;
  unit: CurrencyUnit;
  bigBlind: Amount;
}

/**
 * The seat picked on the felt: starting stack and cards. The name is renamed
 * on the felt itself, the hero's position is picked above the table, and the
 * player's action is in the bubble beside the seat.
 */
export function SeatPanel({ seat, state, update, engine, onPickCards, mode, unit, bigBlind }: SeatPanelProps) {
  const dict = useDict().manual;
  const t = dict.table;
  const players = dict.players;
  const entry = state.seats.find((candidate) => candidate.seat === seat);
  const player = engine.players.find((candidate) => candidate.seat === seat);
  if (!entry || !player) return null;

  const setSeat = (patch: Partial<EditorState["seats"][number]>) =>
    update((current) => ({
      ...current,
      seats: current.seats.map((candidate) => (candidate.seat === seat ? { ...candidate, ...patch } : candidate)),
    }));

  return (
    <section className={styles.seatPanel} aria-label={player.name}>
      <p className={styles.toAct}>
        {player.position ? <span className={styles.pos}>{player.position}</span> : null}
        <strong>{player.name}</strong>
        <span className={styles.dim}>{formatFor(player.stack, mode, unit, bigBlind)}</span>
      </p>

      <div className={styles.seatEdit}>
        <label className="field field--narrow">
          <span className="field__label">{t.startingStack}</span>
          <AmountInput value={entry.stack} onChange={(stack) => setSeat({ stack })} mode={mode} unit={unit} bigBlind={bigBlind} />
        </label>
        <div className="field field--narrow">
          <span className="field__label">{players.cards}</span>
          <button type="button" className={styles.cardsBtn} onClick={() => onPickCards({ kind: "seat", seat })}>
            {entry.cards.length > 0 ? <CardRow cards={entry.cards} size="xs" /> : <span className={styles.dim}>{players.setCards}</span>}
          </button>
        </div>
      </div>
    </section>
  );
}
