"use client";

/**
 * The forum's board list and search on a phone: a bottom sheet.
 *
 * Below 860px the sidebar is not shown; the feed's chip row opens this instead
 * (`BoardsButton`). It is a native popover, so the backdrop tap and Escape
 * close it without any state here; following a link inside it closes it too,
 * because a client-side navigation keeps the same element mounted.
 */

import { useRef, type CSSProperties, type ReactNode } from "react";
import styles from "./forum.module.css";

export const BOARDS_SHEET_ID = "forum-boards";

export function BoardsSheet({ title, closeLabel, children }: { title: string; closeLabel: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      id={BOARDS_SHEET_ID}
      popover="auto"
      role="dialog"
      aria-label={title}
      className={styles.sheet}
      onClick={(event) => {
        if ((event.target as Element).closest("a")) ref.current?.hidePopover();
      }}
    >
      <div className={styles.sheetHead}>
        <span className={styles.sheetGrab} aria-hidden="true" />
        <strong>{title}</strong>
        <button
          type="button"
          className={styles.sheetClose}
          popoverTarget={BOARDS_SHEET_ID}
          popoverTargetAction="hide"
          aria-label={closeLabel}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className={styles.sheetBody}>{children}</div>
    </div>
  );
}

/** The chip that opens the sheet: the board being read, or "All boards". Phone only. */
export function BoardsButton({ label, menuLabel, hue }: { label: string; menuLabel: string; hue?: string }) {
  return (
    <button
      type="button"
      className={styles.boardsChip}
      popoverTarget={BOARDS_SHEET_ID}
      aria-haspopup="dialog"
      aria-label={`${menuLabel}: ${label}`}
      style={hue ? ({ "--hue": hue } as CSSProperties) : undefined}
    >
      <span className={styles.navDot} aria-hidden="true" />
      <span className={styles.boardsChipLabel}>{label}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}
