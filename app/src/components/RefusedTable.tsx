import { useState } from "react";

import { useT } from "../i18n";
import type { HandTime, RefusedHand } from "../lib/ipc";
import { RawTextDialog } from "./RawTextDialog";
import { liveDateFormat } from "../i18n/format";
import styles from "./RefusedTable.module.css";

/** The room's own clock: `HandTime.at` is a wall time, so it is read and shown as UTC (unshifted). */
const wallTime = liveDateFormat({ dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
/** When Rail last met the hand: the reader's own clock. */
const seen = liveDateFormat({ dateStyle: "short", timeStyle: "short" });

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
 * Refused hands as a table (R1.6): the reason's code as a badge, its
 * message, the room, when the hand was played, the file (its name on one
 * line, the whole path on hover), when Rail last met it, and its raw text in
 * a dialog.
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
              <th scope="col">{d.reason}</th>
              <th scope="col">{d.details}</th>
              <th scope="col">{d.room}</th>
              <th scope="col">{d.handTime}</th>
              <th scope="col">{d.file}</th>
              <th scope="col">{d.lastSeen}</th>
              <th scope="col">
                <span className={styles.hidden}>{d.text}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <code className={styles.code}>{entry.reason}</code>
                </td>
                <td className={styles.message}>{entry.message}</td>
                <td className={styles.nowrap}>
                  {entry.siteName ?? <span className={styles.muted}>{d.unknown}</span>}
                </td>
                <td className={styles.nowrap}>
                  {entry.handTime ? played(entry.handTime) : <span className={styles.muted}>—</span>}
                </td>
                <td className={styles.file} title={entry.file}>
                  {fileName(entry.file)}
                </td>
                <td className={styles.nowrap}>{seen.format(entry.lastSeen)}</td>
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
