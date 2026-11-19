/**
 * Everything under a decision in one panel (canvas `ideas-trainer` A, which
 * replaced the Range / Strategy / Your hand / Why tabs): the hero's whole
 * range on the left, the short why on the right (`Brief`).
 *
 * While answering only the range can be opened (one button, remembered on
 * the device): its shape, or the strategy too when the settings say so.
 * After the answer the panel is open, the range drawn with the strategy.
 */

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import type { DecisionAnalysis } from "../../lib/analysis/types";
import type { TrainerSpot } from "../../lib/training";
import type { RangeView } from "../../lib/training/rangeView";
import { Brief } from "./Feedback";
import { useTrainerHost } from "./host";
import { RangeGrid } from "./RangeGrid";
import type { TrainerSettings } from "./settings";
import styles from "./trainer.module.css";

const KEY = "rail.trainer.range";

function readOpen(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(KEY);
    if (stored !== null) return stored === "1";
    // The folding tabs' old choice.
    return window.localStorage.getItem("rail.trainer.tab") === "range";
  } catch {
    return false;
  }
}

/** The range at `target`, read through the host (its worker). */
function useRangeView<T>(target: T | null, read: ((target: T) => Promise<RangeView | null>) | null) {
  const [range, setRange] = useState<{ target: T; view: RangeView | null } | null>(null);
  useEffect(() => {
    if (target === null || !read) return;
    let live = true;
    read(target)
      .then((view) => live && setRange({ target, view }))
      .catch(() => live && setRange({ target, view: null }));
    return () => {
      live = false;
    };
  }, [target, read]);
  if (target === null || !read) return { loading: false, view: null };
  if (range === null || range.target !== target) return { loading: true, view: null };
  return { loading: false, view: range.view };
}

export function DecisionPanel<T>({
  decision,
  spot,
  settings,
  target,
  read,
  answered,
  study = null,
}: {
  /** The graded decision; null before the answer is graded. */
  decision: DecisionAnalysis | null;
  spot: TrainerSpot | null;
  settings: TrainerSettings;
  /** The spot or step the range is read at; null: nothing to read (yet). */
  target: T | null;
  /** How the host reads a range; null: it reads none. */
  read: ((target: T) => Promise<RangeView | null>) | null;
  answered: boolean;
  /** The host's deeper study, under Details. */
  study?: ReactNode;
}) {
  const { t } = useTrainerHost();
  const [open, setOpen] = useState(readOpen);
  // The example hand picked, for this spot only.
  const [pick, setPick] = useState<{ target: T | null; cell: number | null }>({ target: null, cell: null });
  const highlight = pick.target === target ? pick.cell : null;
  const setHighlight = (cell: number | null) => setPick({ target, cell });
  const graded = decision !== null && answered;
  const showRange = read !== null && (graded || open);
  const { loading, view } = useRangeView(showRange ? target : null, read);
  const strategy = settings.range === "strategy" || answered;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // No storage: it stays as set for the visit.
    }
  };

  const range = showRange ? (
    loading ? (
      <RailLoader size="inline" label={t.rangeLoading} showLabel />
    ) : view ? (
      <RangeGrid view={view} strategy={strategy} highlight={graded ? highlight : null} />
    ) : (
      <p className={styles.muted}>{t.rangeNone}</p>
    )
  ) : null;

  if (!graded) {
    if (read === null) return null;
    return (
      <section className={styles.panel} data-closed={!open || undefined} aria-label={t.tabs.label}>
        <button type="button" className={styles.panelToggle} aria-expanded={open} onClick={toggle}>
          {t.tabs.range}
          <span className={styles.foldChevron} aria-hidden="true" />
        </button>
        {open ? <div className={styles.panelRange}>{range}</div> : null}
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label={t.tabs.label}>
      <div className={styles.panelGrid} data-single={!range || undefined}>
        {range ? <div className={styles.panelRange}>{range}</div> : null}
        <Brief
          decision={decision}
          spot={spot}
          settings={settings}
          view={view}
          highlight={highlight}
          onHighlight={setHighlight}
          extra={study}
        />
      </div>
    </section>
  );
}
