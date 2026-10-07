"use client";

import { useState } from "react";
import { useDict } from "../../lib/i18n/client";
import { MANUAL_UNITS, type EngineState, type ManualCurrency } from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { CardRow } from "../replayer/PlayingCard";
import { AmountInput } from "./AmountInput";
import type { CardTarget } from "./CardDialog";
import { TABLE_SIZES, formatFor, unitOf, withTableSize, type AmountMode, type EditorState } from "./editorState";
import styles from "./manual.module.css";

type Update = (patch: Partial<EditorState> | ((current: EditorState) => EditorState)) => void;

const CURRENCIES: ManualCurrency[] = ["USD", "EUR", "GBP", "CHIPS"];

/** `datetime-local` wants local wall time without a zone; the state keeps UTC. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/* ------------------------------------------------------------------ game - */

/** Rendered inside the settings bar's dialog, which carries the title. */
export function GamePanel({ state, update }: { state: EditorState; update: Update }) {
  const t = useDict().manual.game;
  const players = useDict().manual.players;
  const money = { mode: "money" as const, unit: unitOf(state), bigBlind: state.bigBlind };
  const tournament = state.format === "tournament";
  const setTournament = (patch: Partial<EditorState["tournament"]>) =>
    update((current) => ({ ...current, tournament: { ...current.tournament, ...patch } }));

  return (
    <section className={styles.dialogBody}>
      <div className={styles.fields}>
        <label className="field field--narrow">
          <span className="field__label">{t.format}</span>
          <select value={state.format} onChange={(event) => update({ format: event.target.value as EditorState["format"] })}>
            <option value="cash">{t.cash}</option>
            <option value="tournament">{t.tournament}</option>
          </select>
        </label>
        <label className="field field--narrow">
          <span className="field__label">{t.variant}</span>
          <select
            value={state.variant}
            onChange={(event) => {
              const variant = event.target.value as EditorState["variant"];
              // Omaha is almost always pot limit; changing the game resets the cards.
              update((current) => ({
                ...current,
                variant,
                limit: variant === "holdem" ? current.limit : "pl",
                seats: current.seats.map((seat) => ({ ...seat, cards: [] })),
              }));
            }}
          >
            <option value="holdem">{t.holdem}</option>
            <option value="omaha">{t.omaha}</option>
            <option value="omaha5">{t.omaha5}</option>
          </select>
        </label>
        <label className="field field--narrow">
          <span className="field__label">{t.limit}</span>
          <select value={state.limit} onChange={(event) => update({ limit: event.target.value as EditorState["limit"] })}>
            <option value="nl">{t.nl}</option>
            <option value="pl">{t.pl}</option>
          </select>
        </label>
        {!tournament ? (
          <label className="field field--narrow">
            <span className="field__label">{t.currency}</span>
            <select
              value={state.currency}
              onChange={(event) => update({ currency: event.target.value as ManualCurrency })}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code === "CHIPS" ? t.chips : code}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field field--narrow">
          <span className="field__label">{t.tableSize}</span>
          <select
            value={state.maxSeats}
            onChange={(event) =>
              update((current) => ({
                ...withTableSize(current, Number(event.target.value), players.defaultName),
                actions: [],
              }))
            }
          >
            {TABLE_SIZES.map((size) => (
              <option key={size} value={size}>
                {t.tableSizeOption(size)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.fields}>
        <label className="field field--narrow">
          <span className="field__label">{t.smallBlind}</span>
          <AmountInput value={state.smallBlind} onChange={(smallBlind) => update({ smallBlind })} {...money} />
        </label>
        <label className="field field--narrow">
          <span className="field__label">{t.bigBlind}</span>
          <AmountInput value={state.bigBlind} onChange={(bigBlind) => update({ bigBlind })} {...money} />
        </label>
        <label className="field field--narrow">
          <span className="field__label">{t.anteMode}</span>
          <select value={state.anteMode} onChange={(event) => update({ anteMode: event.target.value as EditorState["anteMode"] })}>
            <option value="none">{t.anteNone}</option>
            <option value="each">{t.anteEach}</option>
            <option value="bb">{t.anteBb}</option>
          </select>
        </label>
        {state.anteMode !== "none" ? (
          <label className="field field--narrow">
            <span className="field__label">{t.ante}</span>
            <AmountInput value={state.ante} onChange={(ante) => update({ ante })} {...money} />
          </label>
        ) : null}
        {state.maxSeats > 2 ? (
          <label className="field field--narrow">
            <span className="field__label">{t.straddle}</span>
            <AmountInput value={state.straddle} onChange={(straddle) => update({ straddle })} {...money} />
            <span className="field__hint">{t.straddleHint}</span>
          </label>
        ) : null}
      </div>

      <div className={styles.fields}>
        {!tournament ? (
          <label className="field">
            <span className="field__label">{t.tableName}</span>
            <input type="text" value={state.tableName} maxLength={40} onChange={(event) => update({ tableName: event.target.value })} />
          </label>
        ) : null}
        <label className="field">
          <span className="field__label">{t.playedAt}</span>
          <input
            type="datetime-local"
            value={toLocalInput(state.playedAt)}
            onChange={(event) => {
              const date = new Date(event.target.value);
              if (!Number.isNaN(date.getTime())) update({ playedAt: date.toISOString() });
            }}
          />
        </label>
      </div>

      {tournament ? (
        <div className={styles.fields}>
          <label className="field field--narrow">
            <span className="field__label">{t.tournamentId}</span>
            <input
              type="text"
              value={state.tournament.id}
              maxLength={20}
              onChange={(event) => setTournament({ id: event.target.value.replace(/[^A-Za-z0-9_-]/g, "") })}
            />
          </label>
          <label className="field">
            <span className="field__label">{t.tournamentName}</span>
            <input
              type="text"
              value={state.tournament.name}
              maxLength={60}
              onChange={(event) => setTournament({ name: event.target.value.replace(/[()]/g, "") })}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">{t.buyInCurrency}</span>
            <select
              value={state.tournament.buyInCurrency}
              onChange={(event) => setTournament({ buyInCurrency: event.target.value as EditorState["tournament"]["buyInCurrency"] })}
            >
              {CURRENCIES.filter((code) => code !== "CHIPS").map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--narrow">
            <span className="field__label">{t.buyIn}</span>
            <AmountInput
              value={state.tournament.buyIn}
              onChange={(buyIn) => setTournament({ buyIn })}
              mode="money"
              unit={buyInUnit(state)}
              bigBlind={0}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">{t.fee}</span>
            <AmountInput
              value={state.tournament.fee}
              onChange={(fee) => setTournament({ fee })}
              mode="money"
              unit={buyInUnit(state)}
              bigBlind={0}
            />
          </label>
          <label className="field field--narrow">
            <span className="field__label">{t.level}</span>
            <input
              type="number"
              min={0}
              max={999}
              value={state.tournament.level}
              onChange={(event) => setTournament({ level: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------- players - */

interface PlayersPanelProps {
  state: EditorState;
  update: Update;
  engine: EngineState;
  onPickCards: (target: CardTarget) => void;
  mode: AmountMode;
  unit: CurrencyUnit;
  bigBlind: Amount;
}

export function PlayersPanel({ state, update, engine, onPickCards, mode, unit, bigBlind }: PlayersPanelProps) {
  const t = useDict().manual.players;
  const [all, setAll] = useState<Amount>(100 * bigBlind);
  const fmt = { mode, unit, bigBlind };
  const positionOf = new Map(engine.players.map((player) => [player.seat, player.position]));

  const taken = state.seats.filter((seat) => seat.taken);
  const hero = taken.find((seat) => seat.seat === state.heroSeat);
  const deepest = Math.max(0, ...taken.filter((seat) => seat.seat !== state.heroSeat).map((seat) => seat.stack));
  const effective = hero ? Math.min(hero.stack, deepest) : 0;

  const setSeat = (seat: number, patch: Partial<EditorState["seats"][number]>) =>
    update((current) => ({
      ...current,
      seats: current.seats.map((entry) => (entry.seat === seat ? { ...entry, ...patch } : entry)),
    }));

  return (
    <section className={styles.dialogBody}>
      <div className={styles.headRow}>
        <p className={styles.effective}>
          <span className="field__label">{t.effective}</span>{" "}
          <strong>{formatFor(effective, mode, unit, bigBlind)}</strong>
          <span className={styles.dim}> · {t.effectiveHint}</span>
        </p>
      </div>

      <div className={styles.setAll}>
        <span className="field__label">{t.setAll}</span>
        <AmountInput value={all} onChange={setAll} {...fmt} label={t.setAll} />
        <button
          type="button"
          className="btn btn--sm"
          disabled={!(all > 0)}
          onClick={() =>
            update((current) => ({
              ...current,
              seats: current.seats.map((seat) => ({ ...seat, stack: all })),
            }))
          }
        >
          {t.apply}
        </button>
      </div>

      <div className={styles.seatTable} role="table">
        <div className={`${styles.seatRow} ${styles.seatHead}`} role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">{t.name}</span>
          <span role="columnheader">{t.stack}</span>
          <span role="columnheader">{t.button}</span>
          <span role="columnheader">{t.hero}</span>
          <span role="columnheader">{t.cards}</span>
        </div>
        {state.seats.map((seat) => {
          const position = positionOf.get(seat.seat);
          return (
            <div key={seat.seat} className={`${styles.seatRow} ${seat.taken ? "" : styles.seatEmpty}`} role="row">
              <span role="cell" className={styles.seatNo}>
                <input
                  type="checkbox"
                  checked={seat.taken}
                  aria-label={`${t.seat(seat.seat)} · ${t.taken}`}
                  onChange={(event) => setSeat(seat.seat, { taken: event.target.checked })}
                />
                <span>{seat.seat}</span>
                {seat.taken && position ? <span className={styles.pos}>{position}</span> : null}
              </span>
              <span role="cell">
                <input
                  type="text"
                  value={seat.name}
                  maxLength={40}
                  disabled={!seat.taken}
                  aria-label={`${t.seat(seat.seat)} · ${t.name}`}
                  onChange={(event) => setSeat(seat.seat, { name: event.target.value })}
                />
              </span>
              <span role="cell">
                <AmountInput
                  value={seat.stack}
                  onChange={(stack) => setSeat(seat.seat, { stack })}
                  disabled={!seat.taken}
                  label={`${t.seat(seat.seat)} · ${t.stack}`}
                  {...fmt}
                />
              </span>
              <span role="cell" className={styles.center}>
                <input
                  type="radio"
                  name="manual-button"
                  checked={state.buttonSeat === seat.seat}
                  disabled={!seat.taken}
                  aria-label={`${t.seat(seat.seat)} · ${t.button}`}
                  onChange={() => update({ buttonSeat: seat.seat })}
                />
              </span>
              <span role="cell" className={styles.center}>
                <input
                  type="radio"
                  name="manual-hero"
                  checked={state.heroSeat === seat.seat}
                  disabled={!seat.taken}
                  aria-label={`${t.seat(seat.seat)} · ${t.hero}`}
                  onChange={() => update({ heroSeat: seat.seat })}
                />
              </span>
              <span role="cell">
                <button
                  type="button"
                  className={styles.cardsBtn}
                  disabled={!seat.taken}
                  onClick={() => onPickCards({ kind: "seat", seat: seat.seat })}
                  aria-label={t.pickCards(seat.name || t.seat(seat.seat))}
                >
                  {seat.cards.length > 0 ? <CardRow cards={seat.cards} size="xs" /> : <span className={styles.dim}>{t.setCards}</span>}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function buyInUnit(state: EditorState): CurrencyUnit {
  return MANUAL_UNITS[state.tournament.buyInCurrency];
}
