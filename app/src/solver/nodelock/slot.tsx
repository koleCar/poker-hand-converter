/**
 * The app's side of the Solver library's nodelock slot (`SolverHost.nodelock`,
 * `docs/NODELOCK.md` §5.1): the Nodelock action on a decision's card, the
 * banner above the view (a solve running at this spot, or the Nodelocked
 * solution with its summary, Compare, Edit lock and Back to GTO), and the
 * locked chunk shown in place of the library's.
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
  lockKey,
  openEditor,
  setCompare,
  useNodelockSession,
  type NodelockSession,
} from "./session";

export function useNodelockSlot(): SolverNodelock {
  const session = useNodelockSession();
  const t = useT().nodelock;
  return useMemo<SolverNodelock>(
    () => ({
      override: session.active?.override ?? null,
      compare: session.compare,
      compareLabel: t.gto,
      shareDelta: t.shareDelta,
      nodeAction: (at) => (session.active ? null : <NodeAction at={at} />),
      banner: (at) => <Banner at={at} session={session} />,
    }),
    [session, t],
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

function Banner({ at, session }: { at: NodelockAt | null; session: NodelockSession }) {
  const t = useT().nodelock;
  // A saved lock being edited opens the editor once its decision is on screen.
  useEffect(() => {
    if (at && session.pendingEdit) arrivedAt(at);
  }, [at, session.pendingEdit]);

  const running = session.running;
  const here = running && at && (running.key === lockKey(at) || running.key === lockKey({ ...at, turn: null }));
  const active = session.active;

  return (
    <>
      {running && here ? (
        <div className={styles.progress} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          <div className={styles.progressText}>
            <strong>{running.name}</strong>
            <span>
              {running.progress ? t.progress(running.share, running.progress.etaMs === null ? null : running.progress.etaMs / 1000) : t.starting}
            </span>
            <span className={styles.muted}>{t.solvingHere}</span>
          </div>
          <button type="button" className="btn btn--sm" onClick={cancelSolve}>
            {t.cancel}
          </button>
        </div>
      ) : null}
      {active ? (
        <div className={styles.banner} role="region" aria-label={t.nodelocked}>
          <span className={styles.tag}>
            <Icon name="lock" />
            {t.nodelocked}
          </span>
          <div className={styles.bannerText}>
            <strong>{active.row.name}</strong>
            <span className={styles.shifts}>
              {active.summary.shifts.map((s) => (
                <span key={s.label}>{t.shift(s.label, s.gto, s.locked)}</span>
              ))}
            </span>
            {active.row.exploitability_pct !== null && active.row.seconds !== null ? (
              <span className={styles.muted}>
                {t.solvedTo(active.row.exploitability_pct, active.row.seconds, t.engines[active.row.engine ?? ""] ?? active.row.engine ?? "")}
              </span>
            ) : null}
          </div>
          <div className={styles.bannerTools}>
            <button
              type="button"
              className={`btn btn--sm ${session.compare ? styles.pressed : ""}`}
              aria-pressed={session.compare}
              onClick={() => setCompare(!session.compare)}
            >
              {t.compare}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => editLock(active.row, null)}>
              {t.editLock}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={backToGto}>
              {t.backToGto}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
