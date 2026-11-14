/**
 * The trainer's table: the seats around an oval with the hero at the bottom,
 * what each has in front, the board and the pot in the middle, the hero's
 * cards, and above it the hand so far as one strip of actions (who did what,
 * street by street), as GTO Wizard's trainer and every poker client show it.
 */

"use client";

import { PlayingCard } from "@rail/ui/cards/PlayingCard";
import type { CSSProperties, ReactNode } from "react";
import type { Felt, StripItem } from "./felt";
import { aroundHero, seatSpot } from "./felt";
import { useTrainerHost } from "./host";
import styles from "./trainer.module.css";

function bbText(value: number, locale: string): string {
  const tenth = Math.round(value * 10) / 10;
  return tenth.toLocaleString(locale, { maximumFractionDigits: 1 });
}

export function ActionStrip({ items, now = true }: { items: StripItem[]; /** The hero is to act: the strip ends on "your move". */ now?: boolean }) {
  const { t, locale } = useTrainerHost();
  return (
    <ol className={styles.strip} aria-label={t.yourMove}>
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

export function SpotFelt({
  felt,
  cards,
  toCallBb,
  overlay,
  shown,
  compact = false,
}: {
  felt: Felt;
  cards: readonly string[];
  toCallBb: number;
  overlay?: ReactNode;
  /** An opponent's cards turned over (a whole hand's showdown). */
  shown?: { position: string; cards: readonly string[] } | null;
  /** One of several tables: smaller cards. */
  compact?: boolean;
}) {
  const { t, locale } = useTrainerHost();
  const seats = aroundHero(felt.seats);
  return (
    <div className={styles.felt}>
      <div className={styles.feltOval} aria-hidden="true" />
      <div className={styles.middle}>
        <span className={styles.pot}>
          {t.potOf(felt.totalBb)}
        </span>
        {felt.board.length > 0 ? (
          <span className={styles.board}>
            {felt.board.map((card) => (
              <PlayingCard key={card} code={card} size={compact ? "sm" : "md"} />
            ))}
          </span>
        ) : null}
        {toCallBb > 0 && !overlay ? <span className={styles.toCall}>{t.toCall(toCallBb)}</span> : null}
        {overlay}
      </div>
      {seats.map((seat, k) => {
        const spot = seatSpot(k, seats.length);
        const style = { "--left": `${spot.left}%`, "--top": `${spot.top}%` } as CSSProperties;
        return (
          <div
            key={seat.seatNo}
            className={styles.seat}
            style={style}
            data-hero={seat.hero || undefined}
            data-folded={seat.folded || undefined}
            data-acting={seat.acting || undefined}
          >
            {!seat.hero && shown && shown.position === seat.position ? (
              <span className={styles.heroCards}>
                {shown.cards.map((card) => (
                  <PlayingCard key={card} code={card} size="md" />
                ))}
              </span>
            ) : null}
            {seat.hero ? (
              <span className={styles.heroCards}>
                {cards.map((card) => (
                  <PlayingCard key={card} code={card} size={compact ? "sm" : "lg"} />
                ))}
              </span>
            ) : null}
            <span className={styles.seatDisc}>
              <span className={styles.seatPos}>{seat.position}</span>
              <span className={styles.seatStack}>{bbText(seat.stackBb, locale)}</span>
            </span>
            {seat.button ? <span className={styles.button}>D</span> : null}
            {seat.betBb > 0 ? <span className={styles.bet}>{bbText(seat.betBb, locale)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
