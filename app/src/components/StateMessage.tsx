import type { ReactNode } from "react";

import styles from "./StateMessage.module.css";

/**
 * A screen's loading, empty or error state, one shape on every screen
 * (R2.8: Today, Hands, Reports, Players): the dashed box the screens drew
 * since R2.7, now with a role a screen reader announces (`status`, or
 * `alert` for an error), the error in the danger tone, and while loading a
 * few skeleton lines (decoration, hidden from assistive technology; still
 * when the reader asks for reduced motion) above the words.
 */
export function StateMessage({
  kind,
  children,
  compact = false,
}: {
  kind: "loading" | "empty" | "error";
  children: ReactNode;
  /** Inside a panel rather than in place of a screen's body: no minimum height. */
  compact?: boolean;
}) {
  return (
    <div
      className={`${styles.message}${compact ? ` ${styles.compact}` : ""}`}
      data-kind={kind}
      role={kind === "error" ? "alert" : "status"}
    >
      {kind === "loading" ? (
        <div className={styles.skeleton} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <p className={styles.text}>{children}</p>
    </div>
  );
}
