import { Fragment, useState } from "react";

import { BackfillProgress } from "../components/BackfillProgress";
import { useT } from "../i18n";
import { errorText, inApp, ipc, type WatchSource } from "../lib/ipc";
import { screenHref, SETUP } from "../lib/router";
import { useWatcherStatus } from "../lib/useWatcherStatus";
import { liveDateFormat, liveNumberFormat } from "../i18n/format";
import styles from "./ImportStatus.module.css";

const number = liveNumberFormat();
const time = liveDateFormat({ dateStyle: "short", timeStyle: "medium" });

/**
 * The watcher (R1.3): its folders, their state and counts, pause / resume,
 * and a folder's backfill in progress (R1.6), kept current by the app's
 * change events.
 */
export function ImportStatus() {
  const t = useT();
  const { status, error: loadError, reload: load } = useWatcherStatus();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const error = actionError ?? loadError;

  const togglePause = async (paused: boolean) => {
    setBusy(true);
    try {
      await ipc.setImportPaused(paused);
      setActionError(null);
      load();
    } catch (e: unknown) {
      setActionError(errorText(e));
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
      {status?.running && status.sources.length === 0 && (
        <p className={styles.muted}>
          {d.noFolders}{" "}
          <a className={styles.link} href={screenHref(SETUP)}>
            {d.findFolders}
          </a>
        </p>
      )}
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
              <Fragment key={source.id}>
                <tr className={source.backfill ? styles.joined : undefined}>
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
                {source.backfill && (
                  <tr>
                    <td colSpan={6}>
                      <BackfillProgress backfill={source.backfill} label={t.backfill.of(source.path)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
