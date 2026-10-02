/**
 * A hand's hero decisions as letters — `R · B X · C` — each coloured by how it
 * went (§6.2: "action letters coloured by grade", the way a tracker's list
 * shows a bad hand without opening it).
 *
 * The colour is never the only signal: the strip has one accessible name that
 * reads every decision and its mark in words, and the letters themselves are
 * hidden from assistive tech so a screen reader does not spell "R, B, X".
 */

import { useDict } from "../../lib/i18n/client";
import styles from "./analysis.module.css";
import { toneOf, type Toned } from "./tone";

export interface StripDecision extends Toned {
  street: string;
  action: string;
}

const STREETS = ["preflop", "flop", "turn", "river"];

export function ActionStrip({ decisions }: { decisions: StripDecision[] }) {
  const t = useDict().analysis;
  if (decisions.length === 0) {
    return <span className={styles.muted}>—</span>;
  }
  const label = t.list.stripLabel(
    decisions.map((decision) => {
      const tone = toneOf(decision);
      const mark =
        tone === "skipped"
          ? t.list.notAnalysed
          : decision.grade
            ? (t.grades[decision.grade] ?? null)
            : decision.worstFlag
              ? (t.severity[decision.worstFlag] ?? null)
              : null;
      return t.list.decisionLabel(t.streets[decision.street] ?? decision.street, t.actions[decision.action] ?? decision.action, mark);
    }),
  );
  return (
    <span className={styles.strip} role="img" aria-label={label} title={label}>
      {STREETS.filter((street) => decisions.some((decision) => decision.street === street)).map((street) => (
        <span key={street} className={styles.stripStreet} aria-hidden="true">
          {decisions
            .filter((decision) => decision.street === street)
            .map((decision, index) => (
              <span key={`${street}-${index}`} className={styles[toneOf(decision)]}>
                {t.letters[decision.action] ?? "?"}
              </span>
            ))}
        </span>
      ))}
    </span>
  );
}
