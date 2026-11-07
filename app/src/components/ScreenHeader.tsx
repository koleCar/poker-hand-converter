import type { ReactNode } from "react";

import styles from "./ScreenHeader.module.css";

/** A screen's title and, when it needs one, a one-line description (the first-run screen). */
export function ScreenHeader({ title, lead }: { title: string; lead?: string }) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      {lead ? <p className={styles.lead}>{lead}</p> : null}
    </header>
  );
}

/**
 * The header row every tab shares (2026-11-07): no visible title - the
 * sidebar says where the user is, the `<h1>` stays for assistive
 * technology -, the screen's state or context on the left, its pill
 * toggles or its one action on the right. A side with nothing to say shows
 * nothing.
 */
export function HeaderRow({ title, start, end }: { title: string; start?: ReactNode; end?: ReactNode }) {
  return (
    <header className={styles.row}>
      <h1 className={styles.visuallyHidden}>{title}</h1>
      {start ? <div className={styles.start}>{start}</div> : null}
      {end ? <div className={styles.end}>{end}</div> : null}
    </header>
  );
}

/** A choice of a few, as one joined pill (`chip-btn`s, the Live and Hands look). */
export function PillSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.toggle} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`chip-btn${option.id === value ? " is-active" : ""}`}
          aria-pressed={option.id === value}
          onClick={() => {
            if (option.id !== value) onChange(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The tone of a status pill: green running, grey idle, amber something to do. */
export type StatusTone = "live" | "idle" | "warn";

/**
 * A status pill like Live's "Playing now": a dot, the state in a few words,
 * a quieter detail after a "·", and, when the user has something to do, the
 * whole pill is the button that does it.
 */
export function StatusPill({
  tone,
  label,
  meta,
  hint,
  onClick,
}: {
  tone: StatusTone;
  label: string;
  meta?: string | null;
  /** Said on hover and to assistive technology: the sentence behind the words. */
  hint?: string | null;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={styles.dot} data-tone={tone} aria-hidden="true" />
      {label}
      {meta ? <span className={styles.meta}> · {meta}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className={styles.status} data-tone={tone} title={hint ?? undefined} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className={styles.status} data-tone={tone} role="status" title={hint ?? undefined}>
      {body}
    </span>
  );
}

/** The empty state of a screen that is not built yet (R2.7). */
export function Placeholder({ children }: { children: ReactNode }) {
  return <div className={styles.placeholder}>{children}</div>;
}
