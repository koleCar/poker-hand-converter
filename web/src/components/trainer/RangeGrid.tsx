/**
 * The hero's range at the decision as a 13×13 grid (T3): every class shaded
 * by how much of it reaches the node, and - with the strategy shown - split
 * into the reference's actions in their colours, as a solver's grid is. The
 * hero's class is ringed. Above it, how much of all hands the range is;
 * under it, each action's share of the range as a button: picking one shows
 * only the hands that take that action (the range it is played with).
 */

"use client";

import { useState, type CSSProperties } from "react";
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

/** Every two-card hand: the share of them the range holds. */
const ALL_COMBOS = 1326;

function toneOf(option: RangeView["options"][number]): string {
  return option.allIn ? "allin" : option.action;
}

export function RangeGrid({ view, strategy }: { view: RangeView; strategy: boolean }) {
  const { t, locale } = useTrainerHost();
  const [only, setOnly] = useState<number | null>(null);
  const most = Math.max(1e-9, ...view.cells.map((cell) => cell.combos));
  const tones = view.options.map(toneOf);
  const total = view.cells.reduce((sum, cell) => sum + cell.combos, 0);
  const picked = strategy && only !== null && only < tones.length ? only : null;
  const combos = picked === null ? total : view.cells.reduce((sum, cell) => sum + cell.combos * (cell.freq[picked] ?? 0), 0);
  const pct = (value: number) => `${Math.round(value * 100).toLocaleString(locale)}%`;

  return (
    <div className={styles.range}>
      <p className={styles.rangeSummary}>
        {t.rangeCombos(combos, combos / ALL_COMBOS)}
        {picked !== null ? <span className={styles.muted}> · {t.words.option(view.options[picked].action, view.options[picked].sizeBb, view.options[picked].allIn, view.options[picked].sizePot)}</span> : null}
      </p>
      <div className={styles.rangeGrid} role="img" aria-label={t.rangeHeading}>
        {view.cells.map((cell) => {
          const weight = cell.combos / most;
          let background = "var(--surface-inset)";
          let lit = cell.combos > 0;
          if (cell.combos > 0) {
            if (picked !== null) {
              const share = (cell.freq[picked] ?? 0) * 100;
              lit = share > 0.5;
              background = `linear-gradient(to right, ${TONE_VAR[tones[picked]] ?? "var(--chart-raise)"} ${share.toFixed(1)}%, var(--surface-inset) ${share.toFixed(1)}%)`;
            } else if (strategy && cell.freq.length === tones.length) {
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
          const style = { background, opacity: lit ? 0.3 + 0.7 * weight : cell.combos > 0 ? 0.35 : 1 } as CSSProperties;
          return (
            <span key={cell.name} className={styles.rangeCell} style={style} data-hero={cell.name === view.heroClass || undefined} title={cell.name}>
              {cell.name}
            </span>
          );
        })}
      </div>
      {strategy ? (
        <div className={styles.rangeLegend} role="group" aria-label={t.rangeShow}>
          <button type="button" className={styles.rangeOption} aria-pressed={picked === null} onClick={() => setOnly(null)}>
            {t.rangeAll}
          </button>
          {view.options.map((option, a) => (
            <button
              key={a}
              type="button"
              className={styles.rangeOption}
              data-action={tones[a]}
              aria-pressed={picked === a}
              onClick={() => setOnly((current) => (current === a ? null : a))}
            >
              <span className={styles.rangeSwatch} style={{ background: TONE_VAR[tones[a]] }} aria-hidden="true" />
              {t.words.option(option.action, option.sizeBb, option.allIn, option.sizePot)}
              <span className={styles.muted}>{pct(view.shares[a] ?? 0)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
