/**
 * One sharing setting as a single row: icon, name, the state in a word, and a
 * switch. The long explanation is a tooltip, shown on hover (after a short
 * delay, so passing over the popover does not flash it) and on keyboard
 * focus; the state word carries the meaning on touch, where there is no hover.
 *
 * The whole row is the switch, so it is a 40px target rather than an 18px
 * checkbox. `action` replaces the switch when there is nothing to flip yet
 * (an analysis that has not been run).
 */

"use client";

import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "@rail/ui/icon/Icon";
import styles from "./SettingRow.module.css";

export function SettingRow({
  icon,
  label,
  checked,
  status,
  explain,
  busy = false,
  onToggle,
  action,
  error,
}: {
  icon: IconName;
  label: string;
  checked: boolean;
  /** The state in a word or two: "Hidden", "Shared", "Saving…". */
  status: string;
  /** What each state means; shown on hover and focus. */
  explain: ReactNode;
  busy?: boolean;
  onToggle?: (next: boolean) => void;
  /** Shown instead of the switch, when the setting cannot be flipped yet. */
  action?: ReactNode;
  error?: string | null;
}) {
  const tipId = useId();
  const tip = (
    <span id={tipId} role="tooltip" className={styles.tip}>
      {explain}
    </span>
  );

  if (action || !onToggle) {
    return (
      <div className={styles.wrap}>
        <div className={`${styles.row} ${styles.static}`} tabIndex={0} aria-describedby={tipId}>
          <Icon name={icon} className={styles.icon} />
          <span className={styles.label}>{label}</span>
          <span className={styles.status}>{action ?? status}</span>
          {tip}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={tipId}
        disabled={busy}
        className={styles.row}
        onClick={() => onToggle(!checked)}
      >
        <Icon name={icon} className={styles.icon} />
        <span className={styles.label}>{label}</span>
        <span className={`${styles.status}${checked ? ` ${styles.on}` : ""}`} aria-live="polite">
          {status}
        </span>
        <span className={`${styles.switch}${checked ? ` ${styles.on}` : ""}`} aria-hidden="true" />
        {tip}
      </button>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One line of a tooltip: the current state's line is bright, the other one dim. */
export function TipLine({ current, children }: { current: boolean; children: ReactNode }) {
  return <span className={current ? styles.current : undefined}>{children}</span>;
}
