/**
 * Pick cards from a 4 × 13 grid: one row per suit, aces first.
 *
 * One tab stop for the whole grid (a roving `tabIndex`); the arrow keys move
 * between cards, Home and End jump along a row, and Space or Enter toggles.
 * Every card is a real `<button aria-pressed>` named in words ("Ace of
 * spades"), so a screen reader hears what a sighted reader sees. Cards used
 * elsewhere in the same widget (your hand, when picking the board) are
 * disabled rather than hidden, so the grid never reflows under the pointer.
 */

"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { SUIT_PATH, type Suit } from "../../lib/cards";
import { useDict } from "../../lib/i18n/client";
import { CardRow } from "../replayer/PlayingCard";
import styles from "./learn.module.css";

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"] as const;
const SUITS: Suit[] = ["s", "h", "d", "c"];

interface CardPickerProps {
  label: string;
  selected: readonly string[];
  max: number;
  /** Cards that cannot be picked here because they are used elsewhere. */
  blocked?: readonly string[];
  onChange: (next: string[]) => void;
}

export function CardPicker({ label, selected, max, blocked = [], onChange }: CardPickerProps) {
  const words = useDict().replayer.playingCard;
  const t = useDict().learn.widgets.cards;
  const [focus, setFocus] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const full = selected.length >= max;

  const toggle = (code: string) => {
    if (selected.includes(code)) onChange(selected.filter((card) => card !== code));
    else if (!full) onChange([...selected, code]);
  };

  const move = (index: number) => {
    const next = (index + 52) % 52;
    setFocus(next);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = Math.floor(index / 13);
    const col = index % 13;
    switch (event.key) {
      case "ArrowRight":
        move(row * 13 + ((col + 1) % 13));
        break;
      case "ArrowLeft":
        move(row * 13 + ((col + 12) % 13));
        break;
      case "ArrowDown":
        move(((row + 1) % 4) * 13 + col);
        break;
      case "ArrowUp":
        move(((row + 3) % 4) * 13 + col);
        break;
      case "Home":
        move(row * 13);
        break;
      case "End":
        move(row * 13 + 12);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <fieldset className={styles.picker}>
      <legend className={styles.pickerLegend}>{label}</legend>
      <div className={styles.pickerChosen}>
        {selected.length > 0 ? <CardRow cards={[...selected]} size="sm" /> : <span className={styles.hint}>{t.selected("")}</span>}
        {selected.length > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange([])}>
            {t.clear}
          </button>
        ) : null}
      </div>
      <div className={styles.grid}>
        {SUITS.map((suit, row) => (
          <div key={suit} className={styles.gridRow}>
            {RANKS.map((rank, col) => {
              const index = row * 13 + col;
              const code = `${rank}${suit}`;
              const on = selected.includes(code);
              const disabled = blocked.includes(code) || (!on && full);
              return (
                <button
                  key={code}
                  ref={(node) => {
                    refs.current[index] = node;
                  }}
                  type="button"
                  className={`${styles.cardBtn} ${suit === "h" || suit === "d" ? styles.red : ""}`}
                  aria-pressed={on}
                  aria-label={words.card(words.ranks[rank] ?? rank, words.suits[suit])}
                  // Disabled cards stay focusable through the roving index, so
                  // arrowing across a used card does not strand the focus.
                  aria-disabled={disabled || undefined}
                  tabIndex={index === focus ? 0 : -1}
                  onFocus={() => setFocus(index)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  onClick={() => {
                    if (!disabled) toggle(code);
                  }}
                >
                  <span aria-hidden="true">{rank}</span>
                  <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                    <path d={SUIT_PATH[suit]} fill="currentColor" />
                  </svg>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** Preset buttons: each shows its cards and sets them on click. */
export function CardPresets({
  presets,
  onPick,
  current,
}: {
  presets: readonly { id: string; cards: readonly string[] }[];
  onPick: (cards: string[]) => void;
  current: readonly string[];
}) {
  const t = useDict().learn.widgets.cards;
  const same = (cards: readonly string[]) => cards.length === current.length && cards.every((card, i) => card === current[i]);
  return (
    <div className={styles.presets} role="group" aria-label={t.presets}>
      {presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className={styles.presetBtn}
          aria-pressed={same(preset.cards)}
          onClick={() => onPick([...preset.cards])}
        >
          <CardRow cards={[...preset.cards]} size="xs" />
        </button>
      ))}
    </div>
  );
}
