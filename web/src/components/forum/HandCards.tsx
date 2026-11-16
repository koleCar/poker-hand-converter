"use client";

/**
 * A post's hero cards and board, as real cards. A client island only because
 * the shared card component reads its strings from context.
 */

import { CardRow } from "@rail/ui/cards/PlayingCard";
import styles from "./forum.module.css";

export function HandCards({ hero, board }: { hero: string[]; board: string[] }) {
  return (
    <span className={styles.handCards}>
      {hero.length ? <CardRow cards={hero} size="sm" /> : null}
      {board.length ? <CardRow cards={board} size="sm" className={styles.handBoard} /> : null}
    </span>
  );
}
