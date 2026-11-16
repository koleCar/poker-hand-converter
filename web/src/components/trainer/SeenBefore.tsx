/**
 * Under a graded answer on a spot the session has dealt before: every
 * earlier answer on it (when, the move, the grade, the EV it lost), the
 * answer just given, and whether it is better than the last time. Shown only
 * after the answer, so a spot dealt again never gives itself away.
 */

"use client";

import { GRADES, type Grade } from "../../lib/analysis/types";
import { useTrainerHost } from "./host";
import { whenText, type SessionAnswer } from "./sessions";
import styles from "./trainer.module.css";

const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };

export function SeenBefore({ rows, grade }: { rows: readonly SessionAnswer[]; grade: Grade }) {
  const { t, locale } = useTrainerHost();
  const s = t.sessions.seen;
  const last = rows[rows.length - 1];
  const rank = (g: Grade) => GRADES.indexOf(g);
  const trend = !last ? null : rank(grade) < rank(last.grade) ? "better" : rank(grade) > rank(last.grade) ? "worse" : "unchanged";
  return (
    <section className={`${styles.seen} rail-fade`} aria-label={s.title}>
      <div className={styles.seenHead}>
        <span aria-hidden="true">↺</span>
        <strong>{s.title}</strong>
        <span className={styles.muted}>{s.same}</span>
        {trend ? (
          <span className={styles.seenTrend} data-trend={trend}>
            {s[trend]}
          </span>
        ) : null}
      </div>
      <ol className={styles.seenList}>
        {rows.map((row) => (
          <li key={`${row.at}|${row.move}`} data-grade={row.grade}>
            <span className={styles.muted}>{whenText(row.at, t, locale)}</span>
            <span>{row.move}</span>
            <span className={styles.seenGrade}>
              <span aria-hidden="true">{GLYPH[row.grade]}</span> {t.words.grades[row.grade] ?? row.grade}
            </span>
            <span data-loss={row.evLoss > 0.005 || undefined}>{row.evLoss > 0.005 ? t.evLost(row.evLoss) : t.noLoss}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
