import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { useT } from "../i18n";
import { errorText, inApp, ipc, type WatchSource, type WatchStatus } from "../lib/ipc";
import styles from "./ImportStatus.module.css";

/** How often the status refreshes while the screen is open. */
const REFRESH_MS = 3000;

// Debug builds only: in a production bundle `import.meta.env.DEV` is `false`
// and the import is dropped, so the button is not shipped.
const DevAddFolder = import.meta.env.DEV ? lazy(() => import("./DevAddFolder")) : null;

const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

/** The watcher (R1.3): its folders, their state and counts, pause / resume. */
export function ImportStatus() {
  const t = useT();
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ipc
      .watcherStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const togglePause = async (paused: boolean) => {
    setBusy(true);
    try {
      await ipc.setImportPaused(paused);
      load();
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const d = t.watch;
  const failure = error ?? status?.error ?? null;
  const issues = (source: WatchSource) => {
    const list = [
      source.error,
      source.quarantined > 0 ? d.quarantined(source.quarantined) : null,
      source.fileErrors > 0 ? d.fileErrors(source.fileErrors) : null,
      source.pending > 0 ? d.pending(source.pending) : null,
    ].filter((item): item is string => item !== null);
    return list.length ? list.join(" · ") : d.none;
  };

  return (
    <section className={styles.section} aria-labelledby="today-import">
      <div className={styles.row}>
        <h2 id="today-import" className={styles.heading}>
          {d.heading}
        </h2>
        {status?.running && (
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => void togglePause(!status.paused)}
          >
            {status.paused ? d.resume : d.pause}
          </button>
        )}
      </div>
      {!inApp && <p className={styles.muted}>{d.unavailable}</p>}
      {inApp && failure && <p className={styles.error}>{d.notRunning(failure)}</p>}
      {inApp && !failure && !status && <p className={styles.muted}>{d.loading}</p>}
      {status?.running && (
        <p className={status.paused ? styles.warning : styles.muted}>{status.paused ? d.paused : d.running}</p>
      )}
      {status?.running && status.sources.length === 0 && <p className={styles.muted}>{d.noFolders}</p>}
      {status && status.sources.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{d.folder}</th>
              <th scope="col">{d.status}</th>
              <th scope="col" className={styles.number}>
                {d.handsToday}
              </th>
              <th scope="col" className={styles.number}>
                {d.hands}
              </th>
              <th scope="col">{d.lastImport}</th>
              <th scope="col">{d.issues}</th>
            </tr>
          </thead>
          <tbody>
            {status.sources.map((source) => (
              <tr key={source.id}>
                <td className={styles.mono}>{source.path}</td>
                <td
                  className={
                    source.state === "unavailable" || source.state === "error" ? styles.errorCell : undefined
                  }
                >
                  {d.states[source.state]}
                </td>
                <td className={styles.number}>{number.format(source.handsToday)}</td>
                <td className={styles.number}>{number.format(source.hands)}</td>
                <td>{source.lastImportAt === null ? d.never : time.format(source.lastImportAt)}</td>
                <td>{issues(source)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {inApp && DevAddFolder && status?.running && (
        <Suspense fallback={null}>
          <DevAddFolder onAdded={load} />
        </Suspense>
      )}
    </section>
  );
}
