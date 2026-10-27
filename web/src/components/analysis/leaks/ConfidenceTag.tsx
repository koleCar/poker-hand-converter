/**
 * A leak's confidence (A6): three dots and a word, never colour alone. Shared
 * by the leak report and the overview's top three (R5.2).
 */

"use client";

import type { Leak } from "../../../lib/analysis/leaks";
import { useDict } from "../../../lib/i18n/client";
import styles from "./leaks.module.css";

const CONFIDENCE_GLYPH = { low: "●○○", medium: "●●○", high: "●●●" } as const;

export function ConfidenceTag({ leak }: { leak: Pick<Leak, "confidence"> }) {
  const t = useDict().analysis.leaks;
  return (
    <span className={`${styles.confidence} ${styles[leak.confidence]}`}>
      <span aria-hidden="true" className={styles.confidenceGlyph}>
        {CONFIDENCE_GLYPH[leak.confidence]}
      </span>
      {t.confidence[leak.confidence]}
    </span>
  );
}
