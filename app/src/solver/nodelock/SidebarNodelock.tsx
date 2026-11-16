/**
 * The nodelock's notice in the sidebar, on every screen: a solve running on
 * this computer (its progress, Cancel), then "Nodelock ready" with Open
 * when it is done - the same card as a newer Rail's (`SidebarUpdate`).
 * Collapsed, one icon with a dot.
 */
import { Icon } from "@rail/ui/icon/Icon";

import { useT } from "../../i18n";
import styles from "./nodelock.module.css";
import { cancelSolve, dismissNotice, openLock, useNodelockSession } from "./session";

export function SidebarNodelock({ collapsed }: { collapsed: boolean }) {
  const t = useT().nodelock;
  const { running, notice } = useNodelockSession();
  if (!running && !notice) return null;
  const progress = running?.progress ?? null;
  const share = progress && progress.etaMs !== null ? progress.elapsedMs / Math.max(1, progress.elapsedMs + progress.etaMs) : null;
  const line = running ? t.sidebarSolving : notice!.status === "solved" ? t.ready(notice!.name) : t.failed(notice!.name);

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.sideCompact}
        title={line}
        aria-label={line}
        onClick={() => (notice?.status === "solved" ? void openLock(notice.id) : undefined)}
      >
        <Icon name="lock" />
        <span className={running ? styles.sideDotBusy : styles.sideDot} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className={styles.side} role={notice?.status === "failed" ? "alert" : "status"}>
      <div className={styles.sideHead}>
        <Icon name="lock" />
        <span className={styles.sideLine}>{line}</span>
      </div>
      {running ? (
        <>
          <span className={styles.muted}>{running.name}</span>
          <span className={styles.muted}>
            {progress
              ? t.progress(progress.iteration, progress.exploitabilityPct, progress.elapsedMs / 1000, progress.etaMs === null ? null : progress.etaMs / 1000)
              : t.starting}
          </span>
          <button type="button" className="btn btn--sm" onClick={cancelSolve}>
            {t.cancel}
          </button>
          <span className={styles.sideBar} role="progressbar" aria-label={line} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
            <span className={share === null ? styles.sideFillBusy : styles.sideFill} style={share === null ? undefined : { inlineSize: `${share * 100}%` }} />
          </span>
        </>
      ) : (
        <div className={styles.sideTools}>
          {notice!.status === "solved" ? (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void openLock(notice!.id)}>
              {t.open}
            </button>
          ) : null}
          <button type="button" className="btn btn--sm btn--ghost" onClick={dismissNotice}>
            {t.dismiss}
          </button>
        </div>
      )}
    </div>
  );
}
