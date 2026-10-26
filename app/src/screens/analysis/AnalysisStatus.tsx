/**
 * The background analysis' line (R5.4): how far it is, why it waits, with
 * Pause / Resume (kept across restarts). Read from the runner
 * (`analysis/service.ts`), which asks Rust for the counts as it goes.
 */
import { useState } from "react";

import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import { setAnalysisPaused, useAnalysisStatus } from "../../analysis/service";
import { describeStatus } from "./status";
import styles from "./Analysis.module.css";

const PACE = liveNumberFormat({ maximumFractionDigits: 1 });

export function AnalysisStatus() {
  const t = useT();
  const s = t.analysis.status;
  const status = useAnalysisStatus();
  const [busy, setBusy] = useState(false);
  const lines = describeStatus(status, s, (n) => PACE.format(n));
  const toggle = () => {
    setBusy(true);
    setAnalysisPaused(!status.paused)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.status} role="status" aria-label={s.label}>
      {lines.map((line, i) => (
        <span key={i} className={line.warn ? styles.statusWarn : undefined}>
          {line.text}
        </span>
      ))}
      <button type="button" className={styles.button} onClick={toggle} disabled={busy}>
        {status.paused ? s.resume : s.pause}
      </button>
    </div>
  );
}
