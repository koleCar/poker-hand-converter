import { useState } from "react";

import { useT } from "../i18n";
import { errorText, ipc, type HandTime, type RefusedHand, type Retryable } from "../lib/ipc";
import { RawTextDialog } from "./RawTextDialog";
import { liveDateFormat } from "../i18n/format";
import styles from "./RefusedTable.module.css";

/** The room's own clock: `HandTime.at` is a wall time, so it is read and shown as UTC (unshifted). */
const wallTime = liveDateFormat({ dateStyle: "short", timeStyle: "short", timeZone: "UTC" });

/** "17/09/2026, 18:28 UTC": the hand's date and time as the room wrote them. */
function played(time: HandTime): string {
  const date = new Date(`${time.at}:00Z`);
  if (Number.isNaN(date.getTime())) return time.at;
  const text = wallTime.format(date);
  return time.zone ? `${text} ${time.zone}` : text;
}

/** The last part of a file's path: the table shows names, the title the whole path. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Refused hands as a table: room, when the hand was played, reason (its code
 * and message), file (its name on one line, the whole path on hover); each
 * with its raw text in a dialog (R1.6).
 */
export function RefusedTable({ entries }: { entries: RefusedHand[] }) {
  const t = useT();
  const d = t.refused;
  const [shown, setShown] = useState<RefusedHand | null>(null);
  return (
    <>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{d.room}</th>
              <th scope="col">{d.played}</th>
              <th scope="col">{d.reason}</th>
              <th scope="col">{d.file}</th>
              <th scope="col">
                <span className={styles.hidden}>{d.text}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className={styles.nowrap}>
                  {entry.siteName ?? <span className={styles.muted}>{d.unknown}</span>}
                </td>
                <td className={styles.nowrap}>
                  {entry.handTime ? played(entry.handTime) : <span className={styles.muted}>—</span>}
                </td>
                <td className={styles.reason}>
                  <code className={styles.code}>{entry.reason}</code>
                  <span className={styles.message}>{entry.message}</span>
                </td>
                <td className={styles.file} title={entry.file}>
                  {fileName(entry.file)}
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.link}
                    aria-label={d.showTextOf(fileName(entry.file))}
                    onClick={() => setShown(entry)}
                  >
                    {d.showText}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown && <RawTextDialog hand={shown} onClose={() => setShown(null)} />}
    </>
  );
}

/**
 * "Try again after an update" (R1.6): shown when a parser has a newer
 * version than the one that refused some of these hands; reads their files
 * again. `sourceId: null` is every folder.
 */
export function RetryRefused({
  sourceId,
  retryable,
  onDone,
}: {
  sourceId: number | null;
  retryable: Retryable;
  onDone: () => void;
}) {
  const t = useT();
  const d = t.refused;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);

  const retry = async () => {
    setBusy(true);
    setResult(null);
    try {
      const files = await ipc.retryRefused(sourceId);
      setResult({ text: d.retried(files), error: false });
      onDone();
    } catch (e: unknown) {
      setResult({ text: d.retryFailed(errorText(e)), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.retry}>
      {retryable.hands > 0 ? (
        <>
          <p className={styles.hint}>{d.retryHint(retryable.hands, retryable.files)}</p>
          <button type="button" className={styles.button} disabled={busy} onClick={() => void retry()}>
            {busy ? d.retrying : d.retry}
          </button>
        </>
      ) : (
        <p className={styles.hint}>{d.upToDate}</p>
      )}
      <div aria-live="polite" className={styles.live}>
        {result && <p className={result.error ? styles.error : styles.success}>{result.text}</p>}
      </div>
    </div>
  );
}
