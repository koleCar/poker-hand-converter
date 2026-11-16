"use client";

import { useState } from "react";
import { useDict } from "../../lib/i18n/client";
import { MANUAL_UNITS, type ManualCurrency } from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { AmountInput } from "./AmountInput";
import { TABLE_SIZES, unitOf, withTableSize, type EditorState } from "./editorState";
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
  const [all, setAll] = useState<Amount>(100 * state.bigBlind);
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

      <div className={styles.setAll}>
        <span className="field__label">{players.setAll}</span>
        <AmountInput
          value={all}
          onChange={setAll}
          mode={state.amountMode}
          unit={unitOf(state)}
          bigBlind={state.bigBlind}
          label={players.setAll}
        />
        <button
          type="button"
          className="btn btn--sm"
          disabled={!(all > 0)}
          onClick={() => update((current) => ({ ...current, seats: current.seats.map((seat) => ({ ...seat, stack: all })) }))}
        >
          {players.apply}
        </button>
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

function buyInUnit(state: EditorState): CurrencyUnit {
  return MANUAL_UNITS[state.tournament.buyInCurrency];
}
