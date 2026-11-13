/**
 * The app's recent trainer answers (T4), under the session's figures: the
 * last ten, kept on this computer (`host.ts`), each with its grade and the
 * EV it lost. The web keeps its answers in the account instead
 * (`trainer_results`, the study plan counts them).
 */
import { useEffect, useState } from "react";

import { useLocale } from "../i18n";
import { trainerEn, trainerHr, type KeptAnswer } from "./door";
import { onHistory, readHistory } from "./host";

const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };
const SHOWN = 10;

export function TrainerHistory() {
  const locale = useLocale();
  const t = locale === "hr" ? trainerHr : trainerEn;
  const [rows, setRows] = useState<KeptAnswer[]>(() => readHistory());
  useEffect(() => onHistory(() => setRows(readHistory())), []);
  return (
    <section aria-label={t.history.heading}>
      <h3 style={{ margin: "0 0 4px", fontSize: "var(--font-size-xs)", color: "var(--text-tertiary)", textTransform: "uppercase" }}>{t.history.heading}</h3>
      {rows.length === 0 ? (
        <p style={{ margin: 0, color: "var(--text-tertiary)", fontSize: "var(--font-size-xs)" }}>{t.history.none}</p>
      ) : (
        <ol style={{ display: "grid", gap: 4, margin: 0, padding: 0, listStyle: "none", fontSize: "var(--font-size-xs)" }}>
          {rows.slice(0, SHOWN).map((row) => (
            <li key={`${row.at}-${row.label}`} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>
                {row.cards.join("")} · {row.label}
              </span>
              <span style={{ color: `var(--grade-${row.grade})`, whiteSpace: "nowrap" }}>
                {GLYPH[row.grade] ?? ""} {row.evLoss > 0.005 ? t.evLost(row.evLoss) : t.noLoss}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
