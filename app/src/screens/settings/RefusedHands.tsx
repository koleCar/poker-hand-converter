import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type FolderQuarantine } from "../../lib/ipc";
import styles from "./Folders.module.css";

const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** The last part of a file's path: the table shows names, the title the whole path. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * One folder's quarantine (guideline §3: "ruke u karanteni"): counts per
 * reason code, then the most recent refused hands with their messages.
 * The raw text stays in the store.
 */
export function RefusedHands({ id, path, panelId }: { id: number; path: string; panelId: string }) {
  const t = useT();
  const d = t.settings.folders;
  const [data, setData] = useState<FolderQuarantine | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    ipc
      .folderQuarantine(id)
      .then((result) => live && setData(result))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [id]);

  const total = data?.reasons.reduce((sum, reason) => sum + reason.count, 0) ?? 0;

  return (
    <section id={panelId} className={styles.panel} aria-label={d.refusedHeading(path)}>
      {!data && !error && <p className={styles.muted}>{d.refusedLoading}</p>}
      {error && <p className={styles.error}>{d.refusedFailed(error)}</p>}
      {data && data.entries.length === 0 && <p className={styles.muted}>{d.refusedEmpty}</p>}
      {data && data.entries.length > 0 && (
        <>
          <p className={styles.hint}>{d.refusedLead}</p>
          <h4 className={styles.subheading}>{d.byReason}</h4>
          <ul className={styles.reasons}>
            {data.reasons.map((reason) => (
              <li key={reason.reason}>
                <code className={styles.code}>{reason.reason}</code>
                <span className={styles.count}>{number.format(reason.count)}</span>
              </li>
            ))}
          </ul>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{d.refusedReason}</th>
                  <th scope="col">{d.refusedMessage}</th>
                  <th scope="col">{d.refusedFile}</th>
                  <th scope="col">{d.refusedSeen}</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <code className={styles.code}>{entry.reason}</code>
                    </td>
                    <td>{entry.message}</td>
                    <td className={styles.mono} title={entry.file}>
                      {fileName(entry.file)}
                    </td>
                    <td className={styles.nowrap}>{time.format(entry.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.truncated && <p className={styles.muted}>{d.refusedMore(data.entries.length, total)}</p>}
        </>
      )}
    </section>
  );
}
