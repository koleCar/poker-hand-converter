/**
 * The background analysis under the tabs (R5.4): while hands are analysed, a
 * progress bar for the month under way (2026-11-18: which hands, how many of
 * its hands are left, about how long they take), the months a click away
 * (each one's state; one waiting can be sent to the front) with the whole
 * store's count; otherwise one short line (why it waits, that every hand is
 * done). Pause / Resume beside it (kept across restarts), and Hide (the tabs
 * row then keeps {@link ShowAnalysisProgress}). Read from the runner
 * (`analysis/service.ts`), which asks Rust for the counts as it goes.
 */
import { useState } from "react";

import { Icon } from "@rail/ui/icon/Icon";

import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import { focusAnalysisMonth, setAnalysisPaused, useAnalysisStatus } from "../../analysis/service";
import { setProgressHidden } from "./progressHidden";
import { describeStatus, monthsOf, progressOf } from "./status";
import styles from "./Analysis.module.css";

const count = liveNumberFormat();

export function AnalysisStatus() {
  const t = useT();
  const s = t.analysis.status;
  const status = useAnalysisStatus();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const progress = progressOf(status);
  const months = progress ? monthsOf(status) : [];
  const lines = describeStatus(status, s);
  const toggle = () => {
    setBusy(true);
    setAnalysisPaused(!status.paused)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.statusBlock}>
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
              {progress.month !== null ? <span className={styles.progressMonth}>{s.analysing(progress.month)} · </span> : null}
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
        <span className={styles.statusActions}>
          {months.length > 1 ? (
            <button
              type="button"
              className={`${styles.button} ${styles.buttonSm}`}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {s.months}
            </button>
          ) : null}
          <button type="button" className={`${styles.button} ${styles.buttonSm}`} onClick={toggle} disabled={busy}>
            {status.paused ? s.resume : s.pause}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={s.hide}
            title={s.hide}
            onClick={() => setProgressHidden(true)}
          >
            <Icon name="close" />
          </button>
        </span>
      </div>
      {open && progress && months.length > 1 ? (
        <div className={styles.months} aria-label={s.monthsLabel}>
          <ul className={styles.monthList}>
            {months.map((m) => {
              const label = s.month(m.month);
              const clickable = m.state === "waiting" && m.month !== "";
              return (
                <li key={m.month}>
                  <button
                    type="button"
                    className={styles.monthChip}
                    data-state={m.state}
                    disabled={!clickable}
                    title={clickable ? s.monthFirst(m.month) : undefined}
                    onClick={clickable ? () => focusAnalysisMonth(m.month) : undefined}
                  >
                    <span>{label}</span>
                    {m.state === "done" ? (
                      <span className={styles.monthState}>
                        <Icon name="check" className={styles.monthCheck} />
                        <span className={styles.visuallyHidden}>{s.monthDone}</span>
                      </span>
                    ) : m.state === "now" ? (
                      <span className={styles.monthState}>{Math.floor((1 - m.left / Math.max(1, m.hands)) * 100)}%</span>
                    ) : (
                      <span className={styles.monthState}>{count.format(m.left)}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <span className={styles.muted}>
            {s.inAll}: {s.left(progress.all.left, progress.all.total)}
            {progress.all.minutes !== null ? ` · ${s.eta(progress.all.minutes)}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The tabs row's one button while the progress is hidden: shows it again. */
export function ShowAnalysisProgress() {
  const s = useT().analysis.status;
  return (
    <button type="button" className={styles.iconButton} aria-label={s.show} title={s.show} onClick={() => setProgressHidden(false)}>
      <Icon name="bars" />
    </button>
  );
}
