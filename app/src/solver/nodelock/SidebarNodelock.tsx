/**
 * The nodelock's notice in the sidebar, on every screen. A solve running on
 * this computer is one line: the lock and the solve's name, a thin bar for
 * how far it is (the rest, and "1 of 3 done", on hover); a click goes to My
 * nodelocks, where its row shows it and its menu cancels it. Then "Nodelock
 * ready" with Open when it is done - the same card as a newer Rail's
 * (`SidebarUpdate`). Collapsed, one icon with a dot. Its buttons are drawn
 * like the Solver library's (the sidebar is on every screen, so it does not
 * load the library's own).
 */
import { Icon } from "@rail/ui/icon/Icon";

import { useT } from "../../i18n";
import { go, useRoute, useRouteParam } from "../../lib/router";
import styles from "./nodelock.module.css";
import { progressLine } from "./progress";
import { dismissNotice, lockIdOf, LOCKS_PARAM, openLock, useNodelockSession } from "./session";

export function SidebarNodelock({ collapsed }: { collapsed: boolean }) {
  const t = useT().nodelock;
  const { running, notice, batch } = useNodelockSession();
  const route = useRoute();
  const param = useRouteParam();
  if (!running && !notice) return null;
  const share = running?.share ?? null;
  // My nodelocks, unless it is already on screen (a lock open in it stays open).
  const showLocks = () => {
    if (route !== "solver" || (param !== LOCKS_PARAM && lockIdOf(param) === null)) go("solver", LOCKS_PARAM);
  };
  const status = running ? progressLine(t, running) : null;
  const line = running ? t.sidebarSolving : notice!.status === "solved" ? t.ready(notice!.name) : t.failed(notice!.name);
  // Everything the running line leaves out, on hover.
  const details = running ? [`${line}: ${running.name}`, status, batch.total > 1 ? t.batch(batch.done, batch.total) : ""].filter(Boolean).join(" · ") : line;

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.sideCompact}
        title={details}
        aria-label={details}
        onClick={() => (running ? showLocks() : notice?.status === "solved" ? void openLock(notice.id) : undefined)}
      >
        <Icon name="lock" />
        <span className={running ? styles.sideDotBusy : styles.sideDot} aria-hidden="true" />
      </button>
    );
  }

  if (running) {
    return (
      <button type="button" className={styles.sideRun} title={details} aria-label={details} onClick={showLocks}>
        <Icon name="lock" />
        <span className={styles.sideRunName}>{running.name || running.board}</span>
        <span className={styles.sideBar} aria-hidden="true">
          <span className={share === null ? styles.sideFillBusy : styles.sideFill} style={share === null ? undefined : { inlineSize: `${share * 100}%` }} />
        </span>
      </button>
    );
  }

  return (
    <div className={styles.side} role={notice!.status === "failed" ? "alert" : "status"}>
      <div className={styles.sideHead}>
        <Icon name="lock" />
        <span className={styles.sideLine}>{line}</span>
      </div>
      <div className={styles.sideTools}>
        {notice!.status === "solved" ? (
          <button type="button" className={`${styles.sideButton} ${styles.sideButtonLock}`} onClick={() => void openLock(notice!.id)}>
            {t.open}
          </button>
        ) : null}
        <button type="button" className={`${styles.sideButton} ${styles.sideButtonQuiet}`} onClick={dismissNotice}>
          {t.dismiss}
        </button>
      </div>
    </div>
  );
}
