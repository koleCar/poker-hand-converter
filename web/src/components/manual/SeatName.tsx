"use client";

import styles from "./manual.module.css";

interface SeatNameProps {
  label: string;
  /** Still the name the editor gave it, drawn dimmer so it reads as a placeholder. */
  isDefault: boolean;
  editing: boolean;
  draft: string;
  placeholder: string;
  renameLabel: string;
  onStart: () => void;
  onDraft: (text: string) => void;
  /** Saves the draft; `move` then opens the next (1) or previous (-1) seat. */
  onCommit: (move: 0 | 1 | -1) => void;
  onCancel: () => void;
}

/**
 * A seat's name on the felt, renamed where it stands: click it, type, Enter
 * saves, Tab saves and moves round the table, Escape leaves it as it was.
 *
 * It sits inside the seat, which is itself a button (picking whose action to
 * enter), so every click and key stops here rather than also picking the seat.
 */
export function SeatName({
  label,
  isDefault,
  editing,
  draft,
  placeholder,
  renameLabel,
  onStart,
  onDraft,
  onCommit,
  onCancel,
}: SeatNameProps) {
  if (editing) {
    return (
      <input
        className={styles.seatNameInput}
        type="text"
        value={draft}
        placeholder={placeholder}
        maxLength={40}
        autoFocus
        aria-label={renameLabel}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => onDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit(0);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Tab") {
            event.preventDefault();
            onCommit(event.shiftKey ? -1 : 1);
          }
        }}
        onBlur={() => onCommit(0)}
      />
    );
  }
  return (
    <button
      type="button"
      className={`${styles.seatName} ${isDefault ? styles.seatNameDefault : ""}`.trim()}
      title={renameLabel}
      aria-label={renameLabel}
      onClick={(event) => {
        event.stopPropagation();
        onStart();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className={styles.seatNameText}>{label}</span>
      <svg className={styles.seatNamePen} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </svg>
    </button>
  );
}
