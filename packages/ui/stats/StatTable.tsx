/**
 * Statistics as a table: one row per displayed statistic, each value with its
 * reliability attached (R2.4 definitions, R2.5 reliability).
 *
 * The rows arrive computed. A `Shown` is what `showStat` returns on the web and
 * what `rail_stats::display` returns over IPC in the desktop app - the same
 * text, tone, sample and reliability bit for bit - so this component only lays
 * them out and never divides anything (guideline §14).
 *
 * Per row: the label (the definition's description as its tooltip), the value
 * at the reliability's opacity with the sample and the 95% interval in its
 * tooltip ("n = 80, 95% CI 20.0–39.5%"), and the sample size, toned by the
 * level (`ok` / `low` / `insufficient`). The value's text is the definition's
 * `formatFixed` digits - identical on both surfaces - with the reader's
 * decimal mark.
 */

import { useUiStrings } from "../i18n";
import type { Shown, StatUnit } from "../model/stats";
import { countIn } from "./format";
import styles from "./StatTable.module.css";

export interface StatTableRow {
  /** The definition's id (`vpip`), unique in the table. */
  id: string;
  /** The definition's label in the reader's language. */
  label: string;
  /** The definition's description, as the label's tooltip. */
  description?: string;
  /** The definition's `format.unit`: a percent gets its sign. */
  unit: StatUnit;
  shown: Shown;
}

export interface StatTableProps {
  /** The table's caption, for a screen reader and as the visible heading if `showCaption`. */
  caption: string;
  showCaption?: boolean;
  rows: readonly StatTableRow[];
}

const decimalMarks = new Map<string, string>();

/** "," for hr-HR, "." for en-GB. */
function decimalMark(locale: string): string {
  let mark = decimalMarks.get(locale);
  if (mark === undefined) {
    mark = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
    decimalMarks.set(locale, mark);
  }
  return mark;
}

export function StatTable({ caption, showCaption = false, rows }: StatTableProps) {
  const strings = useUiStrings();
  const t = strings.statTable;
  const tile = strings.statTile;
  const locale = strings.intlLocale;
  const count = countIn(locale);
  const mark = decimalMark(locale);

  return (
    <table className={styles.table}>
      <caption className={showCaption ? styles.caption : styles.hidden}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{t.statistic}</th>
          <th scope="col" className={styles.number}>
            {t.value}
          </th>
          <th scope="col" className={styles.number}>
            {t.sample}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ id, label, description, unit, shown }) => {
          const { reliability, sample } = shown;
          const n = sample === null ? null : count(sample);
          const interval = reliability.intervalText;
          const title =
            n === null ? undefined : interval ? tile.sample(n, interval.low, interval.high) : t.sampleOnly(n);
          const text = shown.text === null ? "—" : `${shown.text.replace(".", mark)}${unit === "percent" ? "%" : ""}`;
          return (
            <tr key={id} data-tone={shown.tone ?? undefined}>
              <th scope="row" className={styles.label} title={description}>
                {label}
              </th>
              <td className={styles.number} style={{ opacity: reliability.opacity }} title={title}>
                {text}
              </td>
              <td className={`${styles.number} ${styles[reliability.level]}`} title={tile.reliability[reliability.level]}>
                {n ?? "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
