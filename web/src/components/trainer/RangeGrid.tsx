/**
 * The hero's range at the decision as a 13×13 grid (T3): every class shaded
 * by how much of it reaches the node, and - with the strategy shown - split
 * into the reference's actions in their colours, as a solver's grid is. The
 * hero's class is ringed. Under it, each action's share of the whole range.
 */

"use client";

import type { CSSProperties } from "react";
import type { RangeView } from "../../lib/training/rangeView";
import { useTrainerHost } from "./host";
import styles from "./trainer.module.css";

const TONE_VAR: Record<string, string> = {
  fold: "var(--chart-fold)",
  check: "var(--chart-check)",
  call: "var(--chart-call)",
  bet: "var(--chart-raise)",
  raise: "var(--chart-raise)",
  allin: "var(--chart-allin)",
};

function toneOf(option: RangeView["options"][number]): string {
  return option.allIn ? "allin" : option.action;
}

export function RangeGrid({ view, strategy }: { view: RangeView; strategy: boolean }) {
  const { t, locale } = useTrainerHost();
  const most = Math.max(1e-9, ...view.cells.map((cell) => cell.combos));
  const tones = view.options.map(toneOf);
  return (
    <div className={styles.range}>
      <div className={styles.rangeGrid} role="img" aria-label={t.rangeHeading}>
        {view.cells.map((cell) => {
          const weight = cell.combos / most;
          let background = "var(--surface-inset)";
          if (cell.combos > 0) {
            if (strategy && cell.freq.length === tones.length) {
              let at = 0;
              const stops = cell.freq.map((f, a) => {
                const from = at;
                at += f * 100;
                return `${TONE_VAR[tones[a]] ?? "var(--chart-raise)"} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
              });
              background = `linear-gradient(to right, ${stops.join(", ")})`;
            } else {
              background = "var(--accent)";
            }
          }
          const style = { background, opacity: cell.combos > 0 ? 0.25 + 0.75 * weight : 1 } as CSSProperties;
          return (
            <span key={cell.name} className={styles.rangeCell} style={style} data-hero={cell.name === view.heroClass || undefined} title={cell.name}>
              {cell.name}
            </span>
          );
        })}
      </div>
      {strategy ? (
        <ul className={styles.rangeLegend}>
          {view.options.map((option, a) => (
            <li key={a} data-action={tones[a]}>
              <span className={styles.rangeSwatch} style={{ background: TONE_VAR[tones[a]] }} aria-hidden="true" />
              {t.words.option(option.action, option.sizeBb, option.allIn, option.sizePot)}
              <span className={styles.muted}> {Math.round((view.shares[a] ?? 0) * 100).toLocaleString(locale)}%</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
