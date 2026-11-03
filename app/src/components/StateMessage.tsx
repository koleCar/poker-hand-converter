import type { ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import styles from "./StateMessage.module.css";

type StateMessageProps = {
  /** Inside a panel rather than in place of a screen's body: no minimum height. */
  compact?: boolean;
} & (
  | {
      kind: "loading";
      /** What is loading, in the screen's words ("Loading hands…"): the loader's name and caption. */
      children: string;
    }
  | { kind: "empty" | "error"; children: ReactNode }
);

/**
 * A screen's loading, empty or error state, one shape on every screen
 * (R2.8: Today, Hands, Reports, Players). Empty and error are the dashed box
 * the screens drew since R2.7, with a role a screen reader announces
 * (`status`, or `alert` for an error) and the error in the danger tone.
 * Loading is the Rail loader (`@rail/ui/loader`) with the screen's words
 * under it, in the same place and size, without the box: it is invisible for
 * its first 150 ms, so a read that answers at once does not flash, and it is
 * the `status` itself.
 */
export function StateMessage({ kind, children, compact = false }: StateMessageProps) {
  const className = `${styles.message}${compact ? ` ${styles.compact}` : ""}`;
  if (kind === "loading") {
    return (
      <div className={className} data-kind="loading">
        <RailLoader label={children} showLabel size={compact ? "small" : "section"} />
      </div>
    );
  }
  return (
    <div className={`${className} rail-fade`} data-kind={kind} role={kind === "error" ? "alert" : "status"}>
      <p className={styles.text}>{children}</p>
    </div>
  );
}
