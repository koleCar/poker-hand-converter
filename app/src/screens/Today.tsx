import { useEffect, useState } from "react";

import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { errorText, inApp, ipc, type StoreStatus } from "../lib/ipc";
import { ImportStatus } from "./ImportStatus";
import styles from "./Today.module.css";

/** How often the counts refresh while the screen is open. */
const REFRESH_MS = 5000;

const number = new Intl.NumberFormat();

/** Today: the watcher's folders with a backfill's progress (R1.3, R1.6) and
 * the local store's counts (R1.2). The session result arrives in Phase 2. */
export function Today() {
  const t = useT();
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    let live = true;
    const load = () => {
      ipc
        .storeStatus()
        .then((next) => {
          if (live) {
            setStatus(next);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (live) {
            setError(errorText(e));
          }
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const d = t.today;
  const failure = error ?? status?.error ?? null;
  const tiles: [label: string, value: number][] = status
    ? [
        [d.hands, status.hands],
        [d.handsToday, status.handsToday],
        [d.outbox, status.outbox],
        [d.files, status.files],
        [d.folders, status.sources],
        [d.quarantined, status.quarantined],
        [d.unsupported, status.unsupported],
        [d.filesWithErrors, status.filesWithErrors],
      ]
    : [];

  return (
    <>
      <ScreenHeader title={t.screens.today.title} lead={t.screens.today.lead} />
      <ImportStatus />
      <section className={styles.section} aria-labelledby="today-store">
        <h2 id="today-store" className={styles.heading}>
          {d.heading}
        </h2>
        {!inApp && <p className={styles.muted}>{d.unavailable}</p>}
        {inApp && failure && <p className={styles.error}>{d.storeError(failure)}</p>}
        {inApp && !failure && !status && <p className={styles.muted}>{d.loading}</p>}
        {status && !status.error && (
          <>
            <dl className={styles.tiles}>
              {tiles.map(([label, value]) => (
                <div key={label} className={styles.tile}>
                  <dt className={styles.label}>{label}</dt>
                  <dd className={styles.value}>{number.format(value)}</dd>
                </div>
              ))}
            </dl>
            {status.hands === 0 && <p className={styles.muted}>{d.empty}</p>}
            <p className={styles.muted}>
              {d.storeFile} <span className={styles.mono}>{status.path}</span>
            </p>
          </>
        )}
      </section>
    </>
  );
}
