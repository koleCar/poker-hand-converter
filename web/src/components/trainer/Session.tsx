/**
 * The pieces of the Trainer's session column: a section that folds (open or
 * closed remembered on the device), a figure that ticks when it changes, and
 * the recent answers, the newest sliding in at the top. The app's history
 * (`app/src/trainer/History.tsx`) is drawn with these too, so both columns
 * move the same way.
 */

"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { KeptAnswer } from "./host";
import styles from "./trainer.module.css";

const KEY = "rail.trainer.fold.";
const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };

function readFold(id: string, fallback: boolean): boolean {
  try {
    if (typeof window === "undefined") return fallback;
    const stored = window.localStorage.getItem(KEY + id);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Without storage the choice lives here for the visit. */
const unstored = new Map<string, boolean>();

/** A heading that opens and closes what is under it, smoothly. */
export function Fold({ id, label, defaultOpen = false, children }: { id: string; label: string; defaultOpen?: boolean; children: ReactNode }) {
  const panel = useId();
  // The server's pass draws the default; the page then reads the device's choice.
  const open = useSyncExternalStore(
    subscribe,
    () => unstored.get(id) ?? readFold(id, defaultOpen),
    () => defaultOpen,
  );
  const toggle = () => {
    try {
      window.localStorage.setItem(KEY + id, open ? "0" : "1");
    } catch {
      unstored.set(id, !open);
    }
    listeners.forEach((listener) => listener());
  };
  return (
    <section className={styles.sideFold}>
      <button type="button" className={styles.foldHead} aria-expanded={open} aria-controls={panel} onClick={toggle}>
        <span className={styles.foldChevron} aria-hidden="true" />
        {label}
      </button>
      <div className={styles.tabFold} data-open={open || undefined}>
        <div id={panel} className={styles.tabPanel} inert={!open || undefined}>
          {children}
        </div>
      </div>
    </section>
  );
}

/** A value that pops when it changes (keyed on the text, so only a change replays it). */
export function Tick({ value, children }: { value: string; children?: ReactNode }) {
  const [first] = useState(value);
  return (
    <span key={value} className={styles.tick} data-changed={value !== first || undefined}>
      {children ?? value}
    </span>
  );
}

/** The last answers, newest first; an answer given since the column opened slides in. */
export function RecentAnswers({
  rows,
  shown = 10,
  empty,
  evLost,
  noLoss,
}: {
  rows: readonly KeptAnswer[];
  shown?: number;
  /** Said when there are none yet. */
  empty: string;
  evLost: (value: number) => string;
  noLoss: string;
}) {
  const [since] = useState(() => Date.now());
  if (rows.length === 0) return <p className={styles.recentEmpty}>{empty}</p>;
  return (
    <ol className={styles.recent}>
      {rows.slice(0, shown).map((row) => (
        <li key={`${row.at}-${row.label}`} data-grade={row.grade} data-new={Date.parse(row.at) >= since || undefined}>
          <span className={styles.recentHand}>
            <span className={styles.recentCards}>{row.cards.join("")}</span>
            <span className={styles.muted}>{row.label}</span>
          </span>
          <span className={styles.recentGrade}>
            <span aria-hidden="true">{GLYPH[row.grade] ?? ""}</span> {row.evLoss > 0.005 ? evLost(row.evLoss) : noLoss}
          </span>
        </li>
      ))}
    </ol>
  );
}
