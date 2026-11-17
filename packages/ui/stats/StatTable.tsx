/**
 * Statistics as a table: one row per displayed statistic, each value with its
 * reliability attached (R2.4 definitions, R2.5 reliability).
 *
 * The rows arrive computed. A `Shown` is what `showStat` returns on the web and
 * what `rail_stats::display` returns over IPC in the desktop app - the same
 * text, tone, sample and reliability bit for bit - so this component only lays
 * them out and never divides anything (guideline §14).
 *
 * Per row: the label, the value at the reliability's opacity and the sample
 * size, each with the statistic's hover box (`StatTip`: name, description,
 * sample, ideal range); the sample size is toned by the
 * level (`ok` / `low` / `insufficient`). The value's text is the definition's
 * `formatFixed` digits - identical on both surfaces - with the reader's
 * decimal mark.
 */

import { useUiStrings } from "../i18n";
import type { Shown, StatDefinition, StatUnit } from "../model/stats";
import { countIn } from "./format";
import styles from "./StatTable.module.css";
import { useStatTip } from "./StatTip";
import { decimalMark, shownText } from "./StatValue";

export interface StatTableRow {
  /** The definition's id (`vpip`), unique in the table. */
  id: string;
  /** The definition's label in the reader's language. */
  label: string;
  /** The definition's description, in the hover box. */
  description?: string;
  /** The definition, for the hover box (`StatTip`): its sample minimum and ideal range. */
  definition?: StatDefinition;
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


export function StatTable({ caption, showCaption = false, rows }: StatTableProps) {
  const strings = useUiStrings();
  const t = strings.statTable;
  const locale = strings.intlLocale;
  const count = countIn(locale);
  const mark = decimalMark(locale);
  const tip = useStatTip();

  return (
    <>
      {tip.layer}
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
          {rows.map(({ id, label, description, definition, unit, shown }) => {
            const { reliability, sample } = shown;
            const n = sample === null ? null : count(sample);
            const text = shownText(shown, unit, mark, count);
            const on = tip.on({ definition, shown, name: label, description });
            return (
              <tr key={id} data-tone={shown.tone ?? undefined}>
                <th scope="row" className={styles.label} {...tip.on({ definition, name: label, description })}>
                  {label}
                </th>
                <td className={styles.number} style={{ opacity: reliability.opacity }} {...on}>
                  {text}
                </td>
                <td className={`${styles.number} ${styles[reliability.level]}`} {...on}>
                  {n ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
