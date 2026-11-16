/**
 * The hero's whole range at the decision - every hand the hero reaches this
 * spot with - for the Range tab: read when the tab opens (the host's worker),
 * shown as the grid. While answering it is the shape of the range (or the
 * strategy too, when the settings say so); after the answer, how the
 * reference plays every hand of it, and picking an action shows only the
 * hands that take it.
 */

"use client";

import { useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import type { RangeView } from "../../lib/training/rangeView";
import { useTrainerHost } from "./host";
import { RangeGrid } from "./RangeGrid";
import styles from "./trainer.module.css";

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
  const [range, setRange] = useState<{ target: T; view: RangeView | null } | null>(null);

  useEffect(() => {
    if (target === null) return;
    let live = true;
    read(target)
      .then((view) => live && setRange({ target, view }))
      .catch(() => live && setRange({ target, view: null }));
    return () => {
      live = false;
    };
  }, [target, read]);

  if (range === null || range.target !== target) return <RailLoader size="inline" label={t.rangeLoading} showLabel />;
  if (!range.view) return <p className={styles.muted}>{t.rangeNone}</p>;
  return <RangeGrid view={range.view} strategy={strategy} />;
}
