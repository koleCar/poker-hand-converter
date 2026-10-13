import { useCallback, useEffect, useState } from "react";

import { RefusedTable, RetryRefused } from "../../components/RefusedTable";
import { useT } from "../../i18n";
import { errorText, ipc, type FolderQuarantine } from "../../lib/ipc";
import styles from "./Folders.module.css";

const number = new Intl.NumberFormat();

/**
 * One folder's quarantine (guideline §3: "ruke u karanteni"): counts per
 * reason code, then the most recent refused hands with their messages, each
 * with its raw text (R1.6), and "Try again after an update" when an older
 * parser version refused some of them.
 */
export function RefusedHands({ id, path, panelId }: { id: number; path: string; panelId: string }) {
  const t = useT();
  const d = t.settings.folders;
  const [data, setData] = useState<FolderQuarantine | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    ipc
      .folderQuarantine(id)
      .then((result) => live && setData(result))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => load(), [load]);

  const total = data?.reasons.reduce((sum, reason) => sum + reason.count, 0) ?? 0;

  return (
    <section id={panelId} className={styles.panel} aria-label={d.refusedHeading(path)}>
      {!data && !error && <p className={styles.muted}>{d.refusedLoading}</p>}
      {error && <p className={styles.error}>{d.refusedFailed(error)}</p>}
      {data && data.entries.length === 0 && <p className={styles.muted}>{d.refusedEmpty}</p>}
      {data && data.entries.length > 0 && (
        <>
          <p className={styles.hint}>{d.refusedLead}</p>
          <RetryRefused sourceId={id} retryable={data.retryable} onDone={() => void load()} />
          <h4 className={styles.subheading}>{d.byReason}</h4>
          <ul className={styles.reasons}>
            {data.reasons.map((reason) => (
              <li key={reason.reason}>
                <code className={styles.code}>{reason.reason}</code>
                <span className={styles.count}>{number.format(reason.count)}</span>
              </li>
            ))}
          </ul>
          <RefusedTable entries={data.entries} />
          {data.truncated && <p className={styles.muted}>{d.refusedMore(data.entries.length, total)}</p>}
        </>
      )}
    </section>
  );
}
