"use client";

/**
 * The options of the player to act: fold, check or call, and a bet or raise
 * with its sizing. The editor shows it in a bubble beside the seat.
 */

import { useState, type ReactNode } from "react";
import { useDict } from "../../lib/i18n/client";
import type { ActionOptions, EngineState, ManualAction, ManualStreet } from "../../lib/manual";
import type { Amount, CurrencyUnit } from "../../lib/phf/types";
import { AmountInput } from "./AmountInput";
import { formatFor, type AmountMode } from "./editorState";
import styles from "./manual.module.css";

export interface ActionBarProps {
  options: ActionOptions;
  player: EngineState["players"][number];
  street: ManualStreet;
  bigBlind: Amount;
  mode: AmountMode;
  unit: CurrencyUnit;
  onAct: (action: ManualAction) => void;
  /** Shown under the header: who gets passed over to reach this player. */
  note?: ReactNode;
}

export function ActionBar({ options, player, street, bigBlind, mode, unit, onAct, note }: ActionBarProps) {
  const t = useDict().manual.actions;
  const fmt = (amount: Amount) => formatFor(amount, mode, unit, bigBlind);
  const clamp = (to: number) => Math.max(options.minTo, Math.min(options.maxTo, Math.round(to)));
  const [size, setSize] = useState<Amount>(() => clamp(defaultSize(options, street, bigBlind)));
  // The sizing row stays shut until the player is actually betting, so the
  // bubble is three buttons wide and covers as little of the felt as it can.
  const [sizing, setSizing] = useState(false);
  const valid =
    options.aggressive !== null &&
    size <= options.maxTo &&
    size > options.currentBet &&
    (size >= options.minTo || size === options.allInTo);
  const presets = presetSizes(options, street, bigBlind).map((preset) => ({ ...preset, to: clamp(preset.to) }));

  return (
    <div className={styles.actionBar}>
      <p className={styles.toAct}>
        {player.position ? <span className={styles.pos}>{player.position}</span> : null}
        <strong>{player.name}</strong>
        {options.toCall > 0 ? <span className={styles.dim}>{t.toCall(fmt(options.toCall))}</span> : null}
      </p>
      {note ? <p className={styles.skipNote}>{note}</p> : null}
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
        {options.aggressive ? (
          <button
            type="button"
            className={`btn ${sizing ? "" : "btn--primary"}`.trim()}
            aria-expanded={sizing}
            onClick={() => setSizing((open) => !open)}
          >
            {options.aggressive === "bet" ? t.bet : t.raiseShort}
            {sizing ? " ▴" : " ▾"}
          </button>
        ) : null}
      </div>

      {options.aggressive && sizing ? (
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
              label={`${options.aggressive === "bet" ? t.betAmount : t.raiseAmount} · ${t.sizeHint(fmt(options.minTo), fmt(options.maxTo))}`}
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
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Where the size starts: a standard open, a 3× raise, a half-pot bet. */
function defaultSize(options: ActionOptions, street: ManualStreet, bigBlind: Amount): number {
  if (options.aggressive === "bet") return options.pot / 2;
  if (street === "preflop" && options.currentBet <= bigBlind) return options.currentBet * 2.5;
  return options.currentBet * 3;
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
