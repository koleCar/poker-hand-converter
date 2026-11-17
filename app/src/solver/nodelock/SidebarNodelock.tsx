/**
 * The nodelock's notice in the sidebar, on every screen: a solve running on
 * this computer (the locked board, how far it is and the time left, Cancel;
 * with more than one asked for, "1 of 3 done"), then "Nodelock ready" with
 * Open when it is done - the same card as a newer Rail's (`SidebarUpdate`).
 * Collapsed, one icon with a dot.
 */
import { Icon } from "@rail/ui/icon/Icon";

import { useT } from "../../i18n";
import styles from "./nodelock.module.css";
import { cancelAll, cancelSolve, dismissNotice, openLock, useNodelockSession } from "./session";

export function SidebarNodelock({ collapsed }: { collapsed: boolean }) {
  const t = useT().nodelock;
  const { running, notice, queue, batch } = useNodelockSession();
  if (!running && !notice) return null;
  const share = running?.share ?? null;
  const etaS = running?.progress?.etaMs == null ? null : running.progress.etaMs / 1000;
  const status = running ? (running.progress ? t.progress(share, etaS) : t.starting) : null;
  const line = running ? t.sidebarSolving : notice!.status === "solved" ? t.ready(notice!.name) : t.failed(notice!.name);

  if (collapsed) {
    const title = running ? `${line} · ${running.board} · ${status}` : line;
    return (
      <button
        type="button"
        className={styles.sideCompact}
        title={title}
        aria-label={title}
        onClick={() => (!running && notice?.status === "solved" ? void openLock(notice.id) : undefined)}
      >
        <Icon name="lock" />
        <span className={running ? styles.sideDotBusy : styles.sideDot} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className={styles.side} role={!running && notice?.status === "failed" ? "alert" : "status"}>
      <div className={styles.sideHead}>
        <Icon name="lock" />
        <span className={styles.sideLine}>{line}</span>
      </div>
      {running ? (
        <>
          <span className={styles.sideBoard}>{running.board}</span>
          <span className={styles.muted}>{status}</span>
          <div className={styles.sideTools}>
            <button type="button" className="btn btn--sm" onClick={cancelSolve}>
              {t.cancel}
            </button>
            {queue.length ? (
              <button type="button" className="btn btn--sm btn--ghost" onClick={cancelAll}>
                {t.cancelAll}
              </button>
            ) : null}
          </div>
          {batch.total > 1 ? <span className={styles.sideCount}>{t.batch(batch.done, batch.total)}</span> : null}
          <span className={styles.sideBar} role="progressbar" aria-label={line} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.floor(share * 100)}>
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
