/**
 * The flop picker of the Solver library, a popover under the action strip's
 * flop card: three slots, a clear and a random button, and the deck as four
 * rows of thirteen (one per suit, four colours). Picking the third card opens
 * the flop if the library has solved it on the line (in any suits: the
 * library files flops by their canonical spelling), and says that the flop
 * does not exist otherwise. The solved flops are listed under the deck, so
 * the next pick is one click: once cards are picked, only the flops that
 * hold their ranks (suits aside: the solve is the same in any suits), each
 * shown in suits that keep the picked cards as picked.
 */

"use client";

import { Icon } from "@rail/ui/icon/Icon";
import { useMemo, useState, type RefObject } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { useSolverDict } from "./host";
import { flopCards, flopsForPicks, pickedFlop } from "../../lib/solver";
import { IconButton, Popover, ToolButton } from "./ui";
import styles from "./solver.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

const RANKS = "AKQJT98765432";
const SUITS: readonly Suit[] = ["s", "h", "d", "c"];
const SUIT_CLASS: Record<Suit, string> = { s: styles.pcS, h: styles.pcH, d: styles.pcD, c: styles.pcC };

interface FlopPickerProps {
  onClose: () => void;
  /** Canonical keys of the line's solved flops, high card first. */
  solved: readonly string[];
  /** The flop on screen, if any: the picker starts from it. */
  current: readonly string[] | null;
  onPick: (cards: string[]) => void;
  /** The flop card that opens it: a click there is not a click outside. */
  anchor?: RefObject<HTMLElement | null>;
  /** Where along the strip it opens, px. */
  left?: number;
}

export function FlopPicker({ onClose, solved, current, onPick, anchor, left = 0 }: FlopPickerProps) {
  const dict = useSolverDict();
  const t = dict.flop;
  const [picked, setPicked] = useState<string[]>(current ? [...current] : []);
  const [missing, setMissing] = useState(false);
  const currentKey = current ? pickedFlop(current).key : null;
  const listed = useMemo(() => flopsForPicks(solved, picked), [solved, picked]);

  const choose = (cards: string[]) => {
    setPicked(cards);
    if (cards.length < 3) {
      setMissing(false);
      return;
    }
    if (solved.includes(pickedFlop(cards).key)) {
      setMissing(false);
      onPick(cards);
    } else {
      setMissing(true);
    }
  };
  const toggle = (card: string) =>
    choose(picked.includes(card) ? picked.filter((c) => c !== card) : picked.length < 3 ? [...picked, card] : picked);

  return (
    <Popover label={t.title} anchor={anchor} left={left} wide onClose={onClose}>
      <div className={styles.pickerTop}>
        <div className={styles.slots}>
          {[0, 1, 2].map((slot) =>
            picked[slot] ? (
              <button key={slot} type="button" className={styles.slotCard} onClick={() => toggle(picked[slot])} aria-label={picked[slot]}>
                <CardRow cards={[picked[slot]]} size="sm" />
              </button>
            ) : (
              <span key={slot} className={styles.slotEmpty} aria-label={t.slot} />
            ),
          )}
        </div>
        <span className={styles.spacer} />
        <ToolButton size="sm" onClick={() => choose([])}>
          {t.clear}
        </ToolButton>
        <ToolButton
          size="sm"
          onClick={() => {
            // Among the listed flops (the picked ranks), else among all.
            const pool = listed.length ? listed.map((flop) => flop.cards) : solved.map(flopCards);
            if (pool.length) choose(pool[Math.floor(Math.random() * pool.length)]);
          }}
        >
          {t.random}
        </ToolButton>
        <IconButton size="sm" label={dict.settings.done} onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </div>

      <div className={styles.deck} role="group" aria-label={t.title}>
        {SUITS.map((suit) => (
          <div key={suit} className={styles.deckRow}>
            {[...RANKS].map((rank) => {
              const card = `${rank}${suit}`;
              const on = picked.includes(card);
              return (
                <button
                  key={card}
                  type="button"
                  className={`${styles.pc} ${SUIT_CLASS[suit]} ${on ? styles.pcPicked : ""}`}
                  aria-pressed={on}
                  aria-label={t.card(card, on)}
                  disabled={!on && picked.length >= 3}
                  onClick={() => toggle(card)}
                >
                  {rank}
                  {SUIT_SYMBOL[suit]}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {missing ? (
        <Dismissible className={`notice notice--error ${styles.pickerError}`} role="alert">
          {t.missing}
        </Dismissible>
      ) : null}

      <p className={styles.pickerNote}>{picked.length ? t.matching(listed.length, solved.length) : t.solved(solved.length)}</p>
      <div className={styles.solvedList}>
        {listed.map(({ key, cards }) => (
          <button
            key={key}
            type="button"
            className={`${styles.solvedFlop} ${key === currentKey ? styles.solvedFlopOn : ""}`}
            aria-label={cards.join("")}
            aria-pressed={key === currentKey}
            onClick={() => choose(cards)}
          >
            <CardRow cards={cards} size="xs" />
          </button>
        ))}
      </div>
    </Popover>
  );
}
