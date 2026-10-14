/**
 * Debug builds only (see `Settings.tsx`): the background statistics pass
 * (R2.3) - what it is doing, and the two commands that give it work (R2.11:
 * each a recompute, swapped in when done): work every hand's statistics out
 * again, compute every all-in EV again.
 */
import { useCallback, useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type StatsStatus } from "../../lib/ipc";
import styles from "./Settings.module.css";

export default function DevStats() {
  const t = useT();
  const [status, setStatus] = useState<StatsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    ipc
      .statsStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const s = t.devStats;
  const run = (action: () => Promise<number>, done: (n: number) => string) => {
    setNote(null);
    action()
      .then((n) => {
        setNote(done(n));
        load();
      })
      .catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{s.heading}</h2>
      <p className={styles.hint}>{s.note}</p>
      {status && (
        <dl className={styles.facts}>
          <dt>{s.activity}</dt>
          <dd>{s.activities[status.activity]}</dd>

          <dt>{s.rebuild}</dt>
          <dd>
            {status.rebuildTotal !== null
              ? s.rebuildProgress(status.rebuildDone ?? 0, status.rebuildTotal)
              : s.none}
          </dd>

          <dt>{s.evRecompute}</dt>
          <dd>
            {status.evRecomputeTotal !== null
              ? s.rebuildProgress(status.evRecomputeDone ?? 0, status.evRecomputeTotal)
              : s.none}
          </dd>

          <dt>{s.evPending}</dt>
          <dd>{status.evPending}</dd>

          <dt>{s.evComputed}</dt>
          <dd>{s.evTime(status.evComputed, status.evMillis)}</dd>
        </dl>
      )}
      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={() => run(ipc.statsRebuild, s.rebuildStarted)}>
          {s.rebuildButton}
        </button>
        <button type="button" className={styles.button} onClick={() => run(ipc.statsRecomputeEv, s.evQueued)}>
          {s.evButton}
        </button>
      </div>
      {note && <p className={styles.hint}>{note}</p>}
      {(error ?? status?.lastError) && <p className={styles.error}>{error ?? status?.lastError}</p>}
    </section>
  );
}
