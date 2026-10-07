"use client";

import { useDict } from "../../lib/i18n/client";
import type { EngineState, ManualAction } from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { CardRow } from "../replayer/PlayingCard";
import { ActionBar } from "./ActionPanel";
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
  onAct: (action: ManualAction) => void;
  onSelect: (seat: number | null) => void;
  onPickCards: (target: CardTarget) => void;
  mode: AmountMode;
  unit: CurrencyUnit;
  bigBlind: Amount;
}

/**
 * The player picked on the felt: their action when it is their turn, and
 * their seat (name, stack, cards, hero, button) either way.
 */
export function SeatPanel({ seat, state, update, engine, onAct, onSelect, onPickCards, mode, unit, bigBlind }: SeatPanelProps) {
  const dict = useDict().manual;
  const t = dict.table;
  const players = dict.players;
  const entry = state.seats.find((candidate) => candidate.seat === seat);
  const player = engine.players.find((candidate) => candidate.seat === seat);
  if (!entry || !player) return null;

  const status = engine.status;
  const acting = status.kind === "betting" && status.options.seat === seat;
  const actor = status.kind === "betting" ? engine.players.find((p) => p.seat === status.options.seat) : undefined;
  const setSeat = (patch: Partial<EditorState["seats"][number]>) =>
    update((current) => ({
      ...current,
      seats: current.seats.map((candidate) => (candidate.seat === seat ? { ...candidate, ...patch } : candidate)),
    }));

  return (
    <section className={styles.seatPanel} aria-label={player.name}>
      {acting && status.kind === "betting" ? (
        <ActionBar
          key={`${engine.validCount}-${mode}`}
          options={status.options}
          player={player}
          street={engine.street}
          bigBlind={bigBlind}
          mode={mode}
          unit={unit}
          onAct={onAct}
        />
      ) : (
        <div className={styles.seatPanelHead}>
          <p className={styles.toAct}>
            {player.position ? <span className={styles.pos}>{player.position}</span> : null}
            <strong>{player.name}</strong>
            <span className={styles.dim}>{formatFor(player.stack, mode, unit, bigBlind)}</span>
          </p>
          {actor ? (
            <div className={styles.row}>
              <span className={styles.dim}>{t.notTheirTurn(actor.name)}</span>
              <button type="button" className="btn btn--sm" onClick={() => onSelect(null)}>
                {t.goToActor}
              </button>
            </div>
          ) : null}
        </div>
      )}

      <div className={styles.seatEdit}>
        <label className="field field--narrow">
          <span className="field__label">{players.name}</span>
          <input type="text" value={entry.name} maxLength={40} onChange={(event) => setSeat({ name: event.target.value })} />
        </label>
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
        <div className={styles.row}>
          <label className="switch">
            <input type="radio" name="manual-seat-hero" checked={state.heroSeat === seat} onChange={() => update({ heroSeat: seat })} />
            {t.makeHero}
          </label>
          <label className="switch">
            <input
              type="radio"
              name="manual-seat-button"
              checked={state.buttonSeat === seat}
              onChange={() => update({ buttonSeat: seat })}
            />
            {t.makeButton}
          </label>
        </div>
      </div>
    </section>
  );
}
