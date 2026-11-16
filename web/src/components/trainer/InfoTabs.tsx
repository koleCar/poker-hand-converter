/**
 * The extra information under a decision - the range, what the solver does
 * with the hand, the hand's facts, why - as one row of tabs that fold: a tab
 * opens its panel, the open tab closes it. Nothing is open unless the player
 * opens it, and the choice is remembered on the device for every spot after.
 * A tab whose panel is not there yet (the strategy before the answer) waits
 * disabled, so the row never changes shape.
 */

"use client";

import { useId, useState, type ReactNode } from "react";
import { useTrainerHost } from "./host";
import styles from "./trainer.module.css";

const KEY = "rail.trainer.tab";

export interface InfoTab {
  id: string;
  label: string;
  /** null: not available yet (shown disabled). */
  content: ReactNode | null;
}

function readTab(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(KEY);
    if (stored !== null) return stored === "" ? null : stored;
    // The range panel's old open/closed choice.
    return window.localStorage.getItem("rail.trainer.rangeOpen") === "1" ? "range" : null;
  } catch {
    return null;
  }
}

function writeTab(tab: string | null) {
  try {
    window.localStorage.setItem(KEY, tab ?? "");
  } catch {
    // No storage: it stays as set for the visit.
  }
}

export function InfoTabs({ tabs }: { tabs: InfoTab[] }) {
  const { t } = useTrainerHost();
  const id = useId();
  const [open, setOpen] = useState<string | null>(readTab);
  // The panel last shown stays in place while it folds away.
  const [shown, setShown] = useState<string | null>(open);
  if (open && open !== shown) setShown(open);

  const available = (tab: InfoTab | undefined) => Boolean(tab && tab.content !== null);
  const openTab = tabs.find((tab) => tab.id === open);
  const isOpen = available(openTab);
  const panel = tabs.find((tab) => tab.id === (isOpen ? open : shown));

  const toggle = (tab: string) => {
    const next = open === tab && isOpen ? null : tab;
    setOpen(next);
    writeTab(next);
  };

  return (
    <section className={styles.info} data-open={isOpen || undefined}>
      <div className={styles.tabs} role="tablist" aria-label={t.tabs.label}>
        {tabs.map((tab) => {
          const selected = open === tab.id && isOpen;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${id}-${tab.id}`}
              className={styles.tab}
              aria-selected={selected}
              aria-expanded={selected}
              aria-controls={`${id}-panel`}
              disabled={!available(tab)}
              title={available(tab) ? undefined : t.tabs.afterAnswer}
              onClick={() => toggle(tab.id)}
            >
              {tab.label}
              <span className={styles.foldChevron} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className={styles.tabFold} data-open={isOpen || undefined}>
        <div
          className={styles.tabPanel}
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={panel ? `${id}-${panel.id}` : undefined}
          hidden={!panel || panel.content === null ? true : undefined}
          inert={!isOpen || undefined}
        >
          {panel && panel.content !== null ? (
            <div key={panel.id} className={styles.tabBody}>
              {panel.content}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
