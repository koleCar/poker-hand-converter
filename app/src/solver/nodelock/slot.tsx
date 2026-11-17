/**
 * The app's side of the Solver library's nodelock slot (`SolverHost.nodelock`,
 * `docs/NODELOCK.md` §5.1), in two modes:
 *
 * - the Library tab: the clean solve. Only the Nodelock action on a
 *   decision's card; no banner, no locked chunk, whatever lock is open.
 * - My nodelocks on one lock: the locked chunk in place of the library's and
 *   the Nodelocked banner (its summary, Compare, Edit lock, Back to GTO); off
 *   the locked decision the banner says the view is GTO and leads back.
 *
 * A solve's progress shows in My nodelocks (`SolveProgress`) and the sidebar.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { useEffect, useMemo } from "react";

import { useT } from "../../i18n";
import type { NodelockAt, SolverNodelock } from "../door";
import styles from "./nodelock.module.css";
import {
  arrivedAt,
  backToGto,
  cancelSolve,
  editLock,
  openEditor,
  openLock,
  setCompare,
  useNodelockSession,
  type ActiveLock,
  type RunningSolve,
} from "./session";

export function useNodelockSlot(lock: ActiveLock | null, view: () => string): SolverNodelock {
  const session = useNodelockSession();
  const t = useT().nodelock;
  const compare = lock ? session.compare : false;
  return useMemo<SolverNodelock>(
    () => ({
      override: lock?.override ?? null,
      compare,
      compareLabel: t.gto,
      shareDelta: t.shareDelta,
      nodeAction: (at) => (lock ? null : <NodeAction at={at} />),
      banner: (at) => (lock ? <Banner at={at} lock={lock} compare={compare} view={view} /> : <PendingEdit at={at} />),
    }),
    [lock, compare, view, t],
  );
}

function NodeAction({ at }: { at: NodelockAt }) {
  const t = useT().nodelock;
  const position = at.chunk.header.players[at.chunk.result.nodes[at.node].player];
  return (
    <button type="button" className={`btn btn--sm ${styles.nodeAction}`} title={t.actionTitle(position)} onClick={() => openEditor(at)}>
      <Icon name="lock" />
      {t.action}
    </button>
  );
}

/** The library: nothing shown, but a saved lock being edited opens the editor once its decision is on screen. */
function PendingEdit({ at }: { at: NodelockAt | null }) {
  const pending = useNodelockSession().pendingEdit;
  useEffect(() => {
    if (at && pending) arrivedAt(at);
  }, [at, pending]);
  return null;
}

/** A solve running on this computer: a quiet line with its progress and Cancel. */
export function SolveProgress({ running }: { running: RunningSolve }) {
  const t = useT().nodelock;
  return (
    <div className={styles.progress} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <div className={styles.progressText}>
        <strong>{running.name}</strong>
        <span>{running.progress ? t.progress(running.share, running.progress.etaMs === null ? null : running.progress.etaMs / 1000) : t.starting}</span>
        <span className={styles.muted}>{t.solvingHere}</span>
      </div>
      <button type="button" className="btn btn--sm" onClick={cancelSolve}>
        {t.cancel}
      </button>
    </div>
  );
}

function Banner({ at, lock, compare, view }: { at: NodelockAt | null; lock: ActiveLock; compare: boolean; view: () => string }) {
  const t = useT().nodelock;
  const here = at?.locked ?? false;
  return (
    <div className={`${styles.banner} ${here ? "" : styles.bannerOff}`} role="region" aria-label={t.nodelocked}>
      <span className={styles.tag}>
        <Icon name="lock" />
        {t.nodelocked}
      </span>
      <div className={styles.bannerText}>
        <strong>{lock.row.name}</strong>
        {here ? (
          <>
            <span className={styles.shifts}>
              {lock.summary.shifts.map((s) => (
                <span key={s.label}>{t.shift(s.label, s.gto, s.locked)}</span>
              ))}
            </span>
            {lock.row.exploitability_pct !== null && lock.row.seconds !== null ? (
              <span className={styles.muted}>
                {t.solvedTo(lock.row.exploitability_pct, lock.row.seconds, t.engines[lock.row.engine ?? ""] ?? lock.row.engine ?? "")}
              </span>
            ) : null}
          </>
        ) : (
          <span className={styles.muted}>{t.offSpot}</span>
        )}
      </div>
      <div className={styles.bannerTools}>
        {here ? (
          <>
            <button
              type="button"
              className={`btn btn--sm ${compare ? styles.pressed : ""}`}
              aria-pressed={compare}
              onClick={() => setCompare(!compare)}
            >
              {t.compare}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => editLock(lock.row, null)}>
              {t.editLock}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => backToGto(view())}>
              {t.backToGto}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void openLock(lock.row.id)}>
            {t.toLockedSpot}
          </button>
        )}
      </div>
    </div>
  );
}
