/**
 * Around the trainer's table (`TrainerTable`, the replayer's felt): above it
 * the hand so far as one strip of actions (who did what, street by street),
 * as GTO Wizard's trainer and every poker client show it, and under it the
 * status row.
 */

"use client";

import { PlayingCard } from "@rail/ui/cards/PlayingCard";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { StripItem } from "./felt";
import { useTrainerHost } from "./host";
import styles from "./trainer.module.css";

function bbText(value: number, locale: string): string {
  const tenth = Math.round(value * 10) / 10;
  return tenth.toLocaleString(locale, { maximumFractionDigits: 1 });
}

export function ActionStrip({ items, now = true }: { items: StripItem[]; /** The hero is to act: the strip ends on "your move". */ now?: boolean }) {
  const { t, locale } = useTrainerHost();
  // The newest action in view: the strip scrolls rather than wraps.
  const ref = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [items.length, now]);
  return (
    <ol ref={ref} className={styles.strip} aria-label={t.yourMove}>
      {items.map((item, index) =>
        item.kind === "street" ? (
          <li key={index} className={styles.stripStreet}>
            <span className={styles.stripStreetName}>{t.board[item.street]}</span>
            <span className={styles.stripCards}>
              {item.cards.map((card) => (
                <PlayingCard key={card} code={card} size="xs" />
              ))}
            </span>
            <span className={styles.stripPot}>{bbText(item.potBb, locale)}</span>
          </li>
        ) : (
          <li key={index} className={styles.stripAct} data-action={item.allIn ? "allin" : item.action} data-hero={item.hero || undefined}>
            <span className={styles.stripPos}>{item.position}</span>
            <span className={styles.stripVerb}>
              {t.words.leakActions[item.action] ?? item.action}
              {item.action === "bet" || item.action === "raise" || (item.action === "call" && item.toBb > 0) ? ` ${bbText(item.toBb, locale)}` : ""}
            </span>
          </li>
        ),
      )}
      {now ? (
        <li className={styles.stripNow} aria-current="step">
          {t.yourMove}
        </li>
      ) : null}
    </ol>
  );
}

/**
 * The row under the table, one fixed height whatever it says: whose move it
 * is and the price before the answer, the grade after it, the result at the
 * end of a hand. So the answer never moves the table or the buttons.
 */
export function StatusRow({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={styles.statusRow} data-compact={compact || undefined} aria-live="polite">
      {children}
    </div>
  );
}
