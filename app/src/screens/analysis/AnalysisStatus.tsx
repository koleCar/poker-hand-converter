/**
 * The background analysis under the tabs (R5.4): while hands are analysed, a
 * progress bar with how many are left of how many and about how long the
 * rest takes; otherwise one short line (why it waits, that every hand is
 * done). Pause / Resume beside it (kept across restarts). Read from the
 * runner (`analysis/service.ts`), which asks Rust for the counts as it goes.
 */
import { useState } from "react";

import { useT } from "../../i18n";
import { setAnalysisPaused, useAnalysisStatus } from "../../analysis/service";
import { describeStatus, progressOf } from "./status";
import styles from "./Analysis.module.css";

export function AnalysisStatus() {
  const t = useT();
  const s = t.analysis.status;
  const status = useAnalysisStatus();
  const [busy, setBusy] = useState(false);
  const progress = progressOf(status);
  const lines = describeStatus(status, s);
  const toggle = () => {
    setBusy(true);
    setAnalysisPaused(!status.paused)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.status} role="status" aria-label={s.label}>
      {progress ? (
        <div className={styles.progress}>
          <div
            className={styles.bar}
            role="progressbar"
            aria-label={s.progress}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <span className={styles.barFill} style={{ width: `${Math.max(1, progress.share * 100)}%` }} />
          </div>
          <span className={styles.progressText}>
            {s.left(progress.left, progress.total)}
            {progress.minutes !== null ? <span className={styles.muted}> · {s.eta(progress.minutes)}</span> : null}
          </span>
        </div>
      ) : null}
      {lines.map((line, i) => (
        <span key={i} className={line.warn ? styles.statusWarn : undefined}>
          {line.text}
        </span>
      ))}
      <button type="button" className={`${styles.button} ${styles.buttonSm}`} onClick={toggle} disabled={busy}>
        {status.paused ? s.resume : s.pause}
      </button>
    </div>
  );
}
