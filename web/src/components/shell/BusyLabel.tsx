import type { ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import styles from "./BusyLabel.module.css";

/**
 * A button's label that turns into "working" while the button's request runs:
 * the inline Rail loader, then the busy words ("Saving…").
 *
 * The words stay visible from the first frame (the loader's own 150ms delay
 * would otherwise leave an empty button), and are hidden from assistive tech
 * so the button's name is the loader's label, said once, rather than the
 * words twice.
 */
export function BusyLabel({ busy, busyLabel, children }: { busy: boolean; busyLabel: string; children: ReactNode }) {
  if (!busy) return <>{children}</>;
  return (
    <span className={styles.busy}>
      <RailLoader size="inline" label={busyLabel} />
      <span aria-hidden="true">{busyLabel}</span>
    </span>
  );
}
