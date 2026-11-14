/**
 * The hero's range at the decision, folded under one header row: closed, it
 * reads nothing; opened, it reads the range (the host's worker) and shows the
 * grid - the shape while answering (or the strategy, when the settings say so),
 * and after the answer how the reference plays every hand of it. Open or closed
 * is remembered on the device, for every spot after.
 */

"use client";

import { useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import type { RangeView } from "../../lib/training/rangeView";
import { useTrainerHost } from "./host";
import { RangeGrid } from "./RangeGrid";
import styles from "./trainer.module.css";

const KEY = "rail.trainer.rangeOpen";

function readOpen(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    // No storage: it stays as set for the visit.
  }
}

export function RangePanel<T>({
  target,
  read,
  strategy,
}: {
  /** The spot or step the range is read at; null: nothing to read yet. */
  target: T | null;
  read: (target: T) => Promise<RangeView | null>;
  /** Split every class into the reference's actions. */
  strategy: boolean;
}) {
  const { t } = useTrainerHost();
  // Shown only once a spot is dealt (on the client), so the stored choice is read at once.
  const [open, setOpen] = useState(readOpen);
  const [range, setRange] = useState<{ target: T; view: RangeView | null } | null>(null);

  useEffect(() => {
    if (!open || target === null) return;
    let live = true;
    read(target)
      .then((view) => live && setRange({ target, view }))
      .catch(() => live && setRange({ target, view: null }));
    return () => {
      live = false;
    };
  }, [open, target, read]);

  const toggle = () => {
    setOpen((was) => {
      writeOpen(!was);
      return !was;
    });
  };

  return (
    <section className={styles.block} data-open={open || undefined}>
      <button type="button" className={styles.foldHead} aria-expanded={open} onClick={toggle}>
        <span className={styles.foldChevron} aria-hidden="true" />
        {t.rangeHeading}
      </button>
      {open ? (
        range === null || range.target !== target ? (
          <RailLoader size="inline" label={t.rangeLoading} showLabel />
        ) : range.view ? (
          <RangeGrid view={range.view} strategy={strategy} />
        ) : (
          <p className={styles.muted}>{t.rangeNone}</p>
        )
      ) : null}
    </section>
  );
}
