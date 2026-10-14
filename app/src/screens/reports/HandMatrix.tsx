/**
 * The 13 x 13 starting-hand grid, as on the web (`components/stats/HandMatrix.tsx`):
 * pairs on the diagonal, suited above it, offsuit below. Each cell is a
 * button (focusable, announced) showing the chosen statistic's value - the
 * R2.4 definition's text, faded by its reliability - and tinted by it; the
 * one selected lists every column under the grid. Hold'em classes only: an
 * Omaha class is another alphabet, and the table under the grid lists every
 * class whatever the game.
 *
 * The tint is presentation, as the web's: win rate scaled to +/-150 bb/100
 * and damped by the value's reliability (an AA at +900 over four hands is the
 * loudest wrong cell a grid can have), a percentage by itself, hands dealt
 * per combination against the most dealt.
 */
import { useMemo, useState } from "react";
import type { Shown, StatDefinition } from "@rail/ui/model/stats";
import { StatValue } from "@rail/ui/stats/StatValue";

import { useLocale, useT } from "../../i18n";
import type { StatGroup } from "../../lib/ipc";
import { count } from "../hands/format";
import styles from "./Reports.module.css";

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

/** The metrics a cell can show, by definition id (the web's four). */
const METRICS = ["bb_per_100", "vpip", "pfr", "hands"] as const;
type Metric = (typeof METRICS)[number];

/** `AKs` for row A / column K above the diagonal; `AKo` below; `AA` on it. */
function classAt(row: number, col: number): string {
  const a = RANKS[row] ?? "";
  const b = RANKS[col] ?? "";
  if (row === col) return `${a}${b}`;
  return row < col ? `${a}${b}s` : `${b}${a}o`;
}

/** Combinations per class: what "how often was I dealt this" divides by. */
function combos(handClass: string): number {
  return handClass.length === 2 ? 6 : handClass.endsWith("s") ? 4 : 12;
}

const HOLDEM_CLASS = /^[AKQJT98765432]{2}[so]?$/;

interface HandMatrixProps {
  rows: StatGroup[];
  /** The rows' `stats` columns. */
  columns: (StatDefinition | null)[];
}

export function HandMatrix({ rows, columns }: HandMatrixProps) {
  const t = useT();
  const m = t.reports.matrix;
  const locale = useLocale();
  const [metric, setMetric] = useState<Metric>("bb_per_100");
  const [selected, setSelected] = useState<string | null>(null);
  const byClass = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const holdem = rows.some((row) => HOLDEM_CLASS.test(row.key));
  const column = columns.findIndex((definition) => definition?.id === metric);
  const definition = columns[column] ?? null;
  const maxPerCombo = Math.max(1, ...rows.filter((row) => HOLDEM_CLASS.test(row.key)).map((row) => row.hands / combos(row.key)));

  if (!holdem) {
    return <p className={styles.muted}>{m.notHoldem}</p>;
  }

  const shownOf = (row: StatGroup | undefined): Shown | null => (row && column >= 0 ? (row.stats[column] ?? null) : null);

  /** 0..1: how strongly to tint. */
  const intensity = (row: StatGroup | undefined, handClass: string): number => {
    const shown = shownOf(row);
    if (!row || row.hands === 0 || !shown || shown.value === null) return 0;
    const confidence = (shown.reliability.opacity - 0.6) / 0.4;
    switch (metric) {
      case "hands":
        return Math.min(1, row.hands / combos(handClass) / maxPerCombo);
      case "vpip":
      case "pfr":
        return Math.min(1, shown.value / 100);
      case "bb_per_100":
        return Math.min(1, Math.abs(shown.value) / 150) * (0.25 + 0.75 * Math.max(0, confidence));
    }
  };

  const chosen = selected === null ? undefined : byClass.get(selected);

  return (
    <div className={styles.matrix}>
      <div className={styles.matrixHead} role="group" aria-label={m.colourBy}>
        <span className={styles.muted}>{m.colourBy}</span>
        {METRICS.map((entry) => (
          <button
            key={entry}
            type="button"
            className={`chip-btn${entry === metric ? " is-active" : ""}`}
            aria-pressed={entry === metric}
            onClick={() => setMetric(entry)}
          >
            {m.metrics[entry]}
          </button>
        ))}
      </div>
      <div className={styles.grid} role="grid" aria-label={m.gridLabel}>
        {RANKS.map((_, r) => (
          <div key={r} role="row" className={styles.gridRow}>
            {RANKS.map((__, c) => {
              const handClass = classAt(r, c);
              const row = byClass.get(handClass);
              const shown = shownOf(row);
              const level = intensity(row, handClass);
              const tone =
                metric === "bb_per_100" && shown?.value !== null && shown?.value !== undefined && shown.value < 0
                  ? "var(--loss-fg)"
                  : metric === "bb_per_100"
                    ? "var(--profit-fg)"
                    : "var(--accent-fg)";
              return (
                <button
                  key={c}
                  type="button"
                  role="gridcell"
                  className={`${styles.cell}${selected === handClass ? ` ${styles.cellSelected}` : ""}`}
                  style={{ background: `color-mix(in srgb, ${tone} ${Math.round(level * 55)}%, var(--surface-raised))` }}
                  aria-label={m.cellLabel(handClass, row ? count(row.hands) : null)}
                  aria-pressed={selected === handClass}
                  onClick={() => setSelected(selected === handClass ? null : handClass)}
                >
                  <span className={styles.cellClass}>{handClass}</span>
                  {row && shown && definition ? (
                    <StatValue shown={shown} unit={definition.format.unit} className={styles.cellValue} />
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selected !== null ? (
        <div className={styles.cellDetail} role="status">
          <strong>{m.selected(selected)}</strong>
          {chosen ? (
            <dl>
              {columns.map((entry, index) => {
                const value = chosen.stats[index];
                return entry && value ? (
                  <div key={entry.id}>
                    <dt title={entry.name[locale]}>{entry.label[locale]}</dt>
                    <dd>
                      <StatValue shown={value} unit={entry.format.unit} />
                    </dd>
                  </div>
                ) : null;
              })}
            </dl>
          ) : (
            <span className={styles.muted}>{m.neverDealt}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
