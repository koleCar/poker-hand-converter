/**
 * The flop picker of the Solver library, in a dialog: three slots, a clear
 * and a random button, and the deck as four rows of thirteen (one per suit,
 * four colours). Picking the third card opens the flop if the library has
 * solved it on the line (in any suits: the library files flops by their
 * canonical spelling), and says that the flop does not exist otherwise. The
 * solved flops are listed under the deck, so the next pick is one click.
 */

"use client";

import { Overlay } from "@rail/ui/overlay/Overlay";
import { useState } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { useDict } from "../../lib/i18n/client";
import { flopCards, pickedFlop } from "../../lib/solver";
import styles from "./solver.module.css";

const RANKS = "AKQJT98765432";
const SUITS: readonly Suit[] = ["s", "h", "d", "c"];
const SUIT_CLASS: Record<Suit, string> = { s: styles.suitS, h: styles.suitH, d: styles.suitD, c: styles.suitC };

interface FlopPickerProps {
  open: boolean;
  onClose: () => void;
  /** Canonical keys of the line's solved flops, high card first. */
  solved: readonly string[];
  /** The flop on screen, if any: the picker starts from it. */
  current: readonly string[] | null;
  onPick: (cards: string[]) => void;
}

export function FlopPicker({ open, onClose, solved, current, onPick }: FlopPickerProps) {
  const t = useDict().solver.flop;
  const [picked, setPicked] = useState<string[]>(current ? [...current] : []);
  const [missing, setMissing] = useState(false);

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
    <Overlay open={open} onClose={onClose} title={t.title} note={t.solved(solved.length)} className={styles.pickerDialog}>
      <div className={styles.picker}>
        <div className={styles.pickerTop}>
          <div className={styles.slots}>
            {[0, 1, 2].map((slot) =>
              picked[slot] ? (
                <button key={slot} type="button" className={styles.slotCard} onClick={() => toggle(picked[slot])} aria-label={picked[slot]}>
                  <CardRow cards={[picked[slot]]} size="md" />
                </button>
              ) : (
                <span key={slot} className={styles.slotEmpty} aria-label={t.slot} />
              ),
            )}
          </div>
          <div className={styles.pickerTools}>
            <button type="button" className="btn btn--sm" onClick={() => choose([])} disabled={picked.length === 0}>
              {t.clear}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={solved.length === 0}
              onClick={() => choose(flopCards(solved[Math.floor(Math.random() * solved.length)]))}
            >
              {t.random}
            </button>
          </div>
        </div>

        {missing ? (
          <p className={`notice notice--error ${styles.pickerError}`} role="alert">
            {t.missing}
          </p>
        ) : (
          <p className={styles.pickerHint}>{t.hint}</p>
        )}

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
                    className={`${styles.deckCard} ${SUIT_CLASS[suit]} ${on ? styles.deckOn : ""}`}
                    aria-pressed={on}
                    aria-label={t.card(card, on)}
                    disabled={!on && picked.length >= 3}
                    onClick={() => toggle(card)}
                  >
                    <span className={styles.deckRank}>{rank}</span>
                    <span className={styles.deckSuit} aria-hidden="true">
                      {SUIT_SYMBOL[suit]}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className={styles.solvedList}>
          {solved.map((key) => (
            <button key={key} type="button" className={styles.solvedFlop} aria-label={key} onClick={() => choose(flopCards(key))}>
              <CardRow cards={flopCards(key)} size="xs" />
            </button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
