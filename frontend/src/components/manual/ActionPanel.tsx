"use client";

import { useState } from "react";
import { useDict } from "../../lib/i18n/client";
import {
  BOARD_SIZE,
  MANUAL_STREETS,
  bettingPattern,
  type ActionOptions,
  type EngineState,
  type LoggedAction,
  type ManualAction,
  type ManualStreet,
} from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { CardRow } from "../replayer/PlayingCard";
import { AmountInput } from "./AmountInput";
import { formatFor, type AmountMode, type EditorState } from "./editorState";
import styles from "./manual.module.css";

type Update = (patch: Partial<EditorState> | ((current: EditorState) => EditorState)) => void;

interface HandLogProps {
  state: EditorState;
  update: Update;
  engine: EngineState;
  onPickBoard: () => void;
  mode: AmountMode;
  unit: CurrencyUnit;
  bigBlind: Amount;
}

/**
 * The hand so far, street by street: the betting pattern, every action with
 * the button to take it back (and everything after it), and the board.
 */
export function HandLog({ state, update, engine, onPickBoard, mode, unit, bigBlind }: HandLogProps) {
  const t = useDict().manual.actions;
  const fmt = (amount: Amount) => formatFor(amount, mode, unit, bigBlind);
  const nameOf = new Map(engine.players.map((player) => [player.seat, player]));
  const stale = state.actions.length - engine.validCount;
  const truncate = (count: number) =>
    update((current) => ({ ...current, actions: current.actions.slice(0, count), picks: {} }));

  const pattern = bettingPattern(engine);
  const streets = MANUAL_STREETS.filter(
    (street) => street === "preflop" || engine.log.some((entry) => entry.street === street) || BOARD_SIZE[street] <= engine.boardReached,
  );

  return (
    <section className={styles.logPanel} aria-label={t.heading}>
      <p className={styles.pattern}>
        <span className="field__label">{t.pattern}</span>{" "}
        <strong>{t.potType[pattern.potType]}</strong>
        {pattern.players.length > 0 ? (
          <span>
            {" · "}
            {pattern.players.length === 2 ? t.versus(pattern.players) : t.multiway(pattern.players.length)}
          </span>
        ) : null}
      </p>

      <ol className={styles.streets}>
        {streets.map((street) => (
          <li key={street} className={styles.street}>
            <div className={styles.streetHead}>
              <span className={styles.streetName}>{t.streets[street]}</span>
              {street !== "preflop" ? (
                <button type="button" className={styles.boardBtn} onClick={onPickBoard} aria-label={t.editBoard} title={t.editBoard}>
                  <CardRow cards={boardFor(state.board, street)} size="xs" />
                </button>
              ) : null}
              <span className={styles.dim}>{t.pot(fmt(potAtStart(engine, street)))}</span>
            </div>
            <ul className={styles.log}>
              {engine.log
                .filter((entry) => entry.street === street)
                .map((entry, i) => (
                  <LogLine
                    key={`${street}-${i}`}
                    entry={entry}
                    position={nameOf.get(entry.seat)?.position ?? null}
                    fmt={fmt}
                    onRemove={entry.index !== null ? () => truncate(entry.index!) : null}
                  />
                ))}
            </ul>
          </li>
        ))}
      </ol>

      {stale > 0 ? <p className="notice notice--warn">{t.stale(stale)}</p> : null}

      {engine.validCount > 0 ? (
        <div className={styles.row}>
          <button type="button" className="btn btn--sm" onClick={() => truncate(engine.validCount - 1)}>
            {t.undo}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => truncate(0)}>
            {t.clear}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function boardFor(board: readonly string[], street: ManualStreet): string[] {
  if (street === "flop") return board.slice(0, 3);
  if (street === "turn") return board.slice(3, 4);
  if (street === "river") return board.slice(4, 5);
  return [];
}

function potAtStart(engine: EngineState, street: ManualStreet): Amount {
  const first = engine.log.find((entry) => entry.street === street);
  if (first) return first.potBefore;
  return engine.pot;
}

function LogLine({
  entry,
  position,
  fmt,
  onRemove,
}: {
  entry: LoggedAction;
  position: string | null;
  fmt: (amount: Amount) => string;
  onRemove: (() => void) | null;
}) {
  const t = useDict().manual.actions;
  // Bets and raises read as street totals ("raises to"), everything else as chips put in.
  const amount = entry.kind === "raise" || entry.kind === "bet" ? entry.to : entry.added;
  const verb = t.verbs[entry.kind](fmt(amount));
  return (
    <li className={`${styles.logLine} ${entry.index === null ? styles.posting : ""} ${styles[`k_${entry.kind}`] ?? ""}`}>
      {position ? <span className={styles.pos}>{position}</span> : null}
      <span className={styles.logName}>{entry.name}</span>
      <span>{verb}</span>
      {entry.allIn && entry.index !== null ? <span className={styles.allIn}>{t.allIn}</span> : null}
      {onRemove ? (
        <button type="button" className={styles.remove} onClick={onRemove} aria-label={t.removeFrom} title={t.removeFrom}>
          ×
        </button>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------ action bar - */

export interface ActionBarProps {
  options: ActionOptions;
  player: EngineState["players"][number];
  street: ManualStreet;
  bigBlind: Amount;
  mode: AmountMode;
  unit: CurrencyUnit;
  onAct: (action: ManualAction) => void;
}

export function ActionBar({ options, player, street, bigBlind, mode, unit, onAct }: ActionBarProps) {
  const t = useDict().manual.actions;
  const fmt = (amount: Amount) => formatFor(amount, mode, unit, bigBlind);
  const [size, setSize] = useState<Amount>(options.minTo);
  const valid =
    options.aggressive !== null &&
    size <= options.maxTo &&
    size > options.currentBet &&
    (size >= options.minTo || size === options.allInTo);
  const clamp = (to: number) => Math.max(options.minTo, Math.min(options.maxTo, Math.round(to)));
  const presets = presetSizes(options, street, bigBlind).map((preset) => ({ ...preset, to: clamp(preset.to) }));

  return (
    <div className={styles.actionBar}>
      <p className={styles.toAct}>
        {player.position ? <span className={styles.pos}>{player.position}</span> : null}
        <strong>{t.toAct(player.name)}</strong>
        <span className={styles.dim}>
          {" · "}
          {t.pot(fmt(options.pot))}
          {options.toCall > 0 ? ` · ${t.toCall(fmt(options.toCall))}` : ""}
        </span>
      </p>
      <div className={styles.row}>
        {!options.canCheck ? (
          <button type="button" className={`btn ${styles.fold}`} onClick={() => onAct({ seat: options.seat, kind: "fold" })}>
            {t.fold}
          </button>
        ) : null}
        {options.canCheck ? (
          <button type="button" className="btn" onClick={() => onAct({ seat: options.seat, kind: "check" })}>
            {t.check}
          </button>
        ) : null}
        {options.canCall ? (
          <button type="button" className="btn" onClick={() => onAct({ seat: options.seat, kind: "call" })}>
            {options.callIsAllIn ? t.callAllIn(fmt(options.callAmount)) : t.call(fmt(options.callAmount))}
          </button>
        ) : null}
      </div>

      {options.aggressive ? (
        <div className={styles.sizing}>
          <div className={styles.row}>
            {presets.map((preset) => (
              <button
                key={`${preset.id}-${preset.factor ?? ""}`}
                type="button"
                className={`chip-btn ${size === preset.to ? "is-active" : ""}`}
                onClick={() => setSize(preset.to)}
              >
                {presetLabel(preset.id, preset.factor, t.presets)}
              </button>
            ))}
          </div>
          <div className={styles.row}>
            <AmountInput
              value={size}
              onChange={setSize}
              mode={mode}
              unit={unit}
              bigBlind={bigBlind}
              invalid={!valid}
              label={options.aggressive === "bet" ? t.betAmount : t.raiseAmount}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!valid}
              onClick={() => onAct({ seat: options.seat, kind: options.aggressive!, to: size })}
            >
              {options.aggressive === "bet" ? t.bet : t.raise} {fmt(size)}
              {size === options.allInTo ? ` · ${t.allIn}` : ""}
            </button>
            <span className={styles.dim}>{t.sizeHint(fmt(options.minTo), fmt(options.maxTo))}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type PresetId = "min" | "x" | "third" | "half" | "twoThirds" | "threeQuarters" | "pot" | "allIn";

function presetSizes(options: ActionOptions, street: ManualStreet, bigBlind: Amount) {
  const out: Array<{ id: PresetId; to: number; factor?: number }> = [{ id: "min", to: options.minTo }];
  const potAfterCall = options.pot + options.toCall;
  const fraction = (f: number) =>
    options.aggressive === "bet" ? f * options.pot : options.currentBet + f * potAfterCall;
  if (street === "preflop") {
    for (const factor of options.currentBet <= bigBlind ? [2, 2.5, 3] : [2.5, 3, 4]) {
      out.push({ id: "x", to: options.currentBet * factor, factor });
    }
    out.push({ id: "pot", to: fraction(1) });
  } else if (options.aggressive === "bet") {
    out.push(
      { id: "third", to: fraction(1 / 3) },
      { id: "half", to: fraction(1 / 2) },
      { id: "twoThirds", to: fraction(2 / 3) },
      { id: "threeQuarters", to: fraction(3 / 4) },
      { id: "pot", to: fraction(1) },
    );
  } else {
    for (const factor of [2.5, 3]) out.push({ id: "x", to: options.currentBet * factor, factor });
    out.push({ id: "pot", to: fraction(1) });
  }
  // Pot limit can cap the raise below the stack; then there is no all-in button.
  if (options.allInTo <= options.maxTo) out.push({ id: "allIn", to: options.allInTo });
  return out;
}

function presetLabel(
  id: PresetId,
  factor: number | undefined,
  t: { min: string; third: string; half: string; twoThirds: string; threeQuarters: string; pot: string; allIn: string; times: (f: string) => string },
): string {
  if (id === "x") return t.times(String(factor));
  return t[id];
}
