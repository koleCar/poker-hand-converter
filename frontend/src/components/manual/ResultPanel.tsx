"use client";

import { useDict } from "../../lib/i18n/client";
import type { EngineState, ManualPot, ManualSettlement } from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { CardRow } from "../replayer/PlayingCard";
import { AmountInput } from "./AmountInput";
import type { CardTarget } from "./CardDialog";
import { formatFor, type AmountMode, type EditorState } from "./editorState";
import styles from "./manual.module.css";

type Update = (patch: Partial<EditorState> | ((current: EditorState) => EditorState)) => void;

interface ResultPanelProps {
  state: EditorState;
  update: Update;
  engine: EngineState;
  settlement: ManualSettlement;
  onPickCards: (target: CardTarget) => void;
  mode: AmountMode;
  unit: CurrencyUnit;
  bigBlind: Amount;
}

export function ResultPanel({ state, update, engine, settlement, onPickCards, mode, unit, bigBlind }: ResultPanelProps) {
  const t = useDict().manual.result;
  const unknownCards = useDict().manual.players.unknown;
  const fmt = (amount: Amount) => formatFor(amount, mode, unit, bigBlind);
  const showdown = engine.status.kind === "complete" && engine.status.ending === "showdown";
  const player = new Map(engine.players.map((entry) => [entry.seat, entry]));
  const seatCards = new Map(state.seats.map((seat) => [seat.seat, seat.cards]));
  const live = engine.players.filter((entry) => !entry.folded);

  const potName = (pot: ManualPot, index: number) =>
    pot.name === "pot" ? t.potNames.pot : index === 0 ? t.potNames.main : t.potNames.side(index);

  const setPick = (index: number, seats: number[] | null) =>
    update((current) => {
      const picks = { ...current.picks };
      if (seats === null) delete picks[index];
      else picks[index] = seats;
      return { ...current, picks };
    });

  return (
    <section className="card">
      <h2 className={styles.heading}>{t.heading}</h2>

      {showdown ? (
        <div>
          <h3 className={styles.subheading}>{t.cardsAtShowdown}</h3>
          <ul className={styles.showdown}>
            {live.map((entry) => {
              const hand = settlement.hands.get(entry.seat);
              const cards = seatCards.get(entry.seat) ?? [];
              return (
                <li key={entry.seat}>
                  {entry.position ? <span className={styles.pos}>{entry.position}</span> : null}
                  <span className={styles.logName}>{entry.name}</span>
                  <button
                    type="button"
                    className={styles.cardsBtn}
                    onClick={() => onPickCards({ kind: "seat", seat: entry.seat })}
                  >
                    {cards.length > 0 ? <CardRow cards={cards} size="xs" /> : <span className={styles.dim}>{unknownCards}</span>}
                  </button>
                  {hand ? <span className={styles.dim}>{t.categories[hand.category]}</span> : null}
                </li>
              );
            })}
          </ul>
          <p className={styles.dim}>{t.muckedHint}</p>
        </div>
      ) : null}

      {settlement.uncalled ? (
        <p className={styles.dim}>{t.uncalled(fmt(settlement.uncalled.amount), settlement.uncalled.name)}</p>
      ) : null}

      <ul className={styles.pots}>
        {settlement.pots.map((pot, index) => {
          const picked = state.picks[index];
          const choosing = picked !== undefined || (pot.winners.length === 0 && pot.eligible.length > 1);
          const best = pot.auto && pot.winners.length > 0 ? settlement.hands.get(pot.winners[0]) : undefined;
          return (
            <li key={index} className={styles.pot}>
              <div className={styles.potHead}>
                <strong>{potName(pot, index)}</strong>
                <span>{fmt(pot.amount)}</span>
                {pot.eligible.length > 1 ? (
                  <span className={styles.dim}>
                    {t.eligible}: {pot.eligible.map((seat) => player.get(seat)?.name).join(", ")}
                  </span>
                ) : null}
              </div>

              {!choosing ? (
                <div className={styles.row}>
                  <span>
                    {t.winners}: <strong>{pot.winners.map((seat) => player.get(seat)?.name).join(", ")}</strong>
                    {pot.winners.length > 1 ? ` (${t.split})` : ""}
                  </span>
                  {best && pot.eligible.length > 1 ? <span className={styles.dim}>{t.best(t.categories[best.category])}</span> : null}
                  {pot.eligible.length > 1 ? (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPick(index, pot.winners)}>
                      {t.choose}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className={styles.row}>
                  {pot.winners.length === 0 ? <span className="notice notice--warn">{t.needsWinner}</span> : null}
                  {pot.eligible.map((seat) => {
                    const on = (picked ?? []).includes(seat);
                    return (
                      <label key={seat} className="switch">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(event) =>
                            setPick(
                              index,
                              event.target.checked ? [...(picked ?? []), seat] : (picked ?? []).filter((s) => s !== seat),
                            )
                          }
                        />
                        {player.get(seat)?.name}
                      </label>
                    );
                  })}
                  {picked !== undefined ? (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPick(index, null)}>
                      {t.auto}
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {state.format === "cash" ? (
        <label className="field field--narrow">
          <span className="field__label">{t.rake}</span>
          <AmountInput value={state.rake} onChange={(rake) => update({ rake })} mode={mode} unit={unit} bigBlind={bigBlind} />
          <span className="field__hint">{t.rakeHint}</span>
        </label>
      ) : null}

      {settlement.resolved ? (
        <div>
          <h3 className={styles.subheading}>{t.net}</h3>
          <ul className={styles.net}>
            {engine.players.map((entry) => {
              const net = settlement.net.get(entry.seat) ?? 0;
              return (
                <li key={entry.seat} className={net > 0 ? styles.plus : net < 0 ? styles.minus : ""}>
                  {entry.position ? <span className={styles.pos}>{entry.position}</span> : null}
                  <span className={styles.logName}>{entry.name}</span>
                  <span>{net > 0 ? "+" : ""}{fmt(net)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
