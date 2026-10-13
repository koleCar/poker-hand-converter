/**
 * Settings, Refused hands (R1.6; guideline §3 "ruke u karanteni"): every
 * hand Rail could not read, app-wide, grouped by reason with counts; a
 * reason opens its most recent hands, each with its raw text; and "Try
 * again after an update" for those an older parser version refused.
 */
import { useCallback, useEffect, useState } from "react";

import { RefusedTable, RetryRefused } from "../../components/RefusedTable";
import { useT } from "../../i18n";
import { errorText, ipc, onWatcherChanged, type QuarantineList, type QuarantineSummary } from "../../lib/ipc";
import styles from "./Folders.module.css";

const number = new Intl.NumberFormat();

export function RefusedAll() {
  const t = useT();
  const d = t.refused;
  const [summary, setSummary] = useState<QuarantineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // The entries of the reason they were loaded for.
  const [loaded, setLoaded] = useState<{ reason: string; list: QuarantineList | null; error: string | null } | null>(
    null,
  );

  const load = useCallback(() => {
    ipc
      .quarantineSummary(null)
      .then((next) => {
        setSummary(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    load();
    return onWatcherChanged(load);
  }, [load]);

  useEffect(() => {
    if (reason === null) {
      return;
    }
    let live = true;
    ipc
      .quarantineEntries(null, reason)
      .then((list) => live && setLoaded({ reason, list, error: null }))
      .catch((e: unknown) => live && setLoaded({ reason, list: null, error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [reason]);

  const current = loaded !== null && loaded.reason === reason ? loaded : null;
  const list = current?.list ?? null;
  const listError = current?.error ?? null;

  const count = summary?.reasons.find((r) => r.reason === reason)?.count ?? 0;

  return (
    <section className={styles.section} aria-labelledby="settings-refused">
      <h2 id="settings-refused" className={styles.heading}>
        {d.heading}
      </h2>
      <p className={styles.hint}>{d.lead}</p>
      {error && <p className={styles.error}>{d.loadFailed(error)}</p>}
      {!summary && !error && <p className={styles.muted}>{d.loading}</p>}
      {summary && summary.total === 0 && <p className={styles.muted}>{d.none}</p>}
      {summary && summary.total > 0 && (
        <>
          <p className={styles.body}>{d.total(summary.total)}</p>
          <RetryRefused sourceId={null} retryable={summary.retryable} onDone={load} />
          <h3 className={styles.subheading}>{d.byReason}</h3>
          <ul className={styles.reasons} aria-label={d.byReason}>
            {summary.reasons.map((item) => (
              <li key={item.reason}>
                <button
                  type="button"
                  className={styles.link}
                  aria-pressed={item.reason === reason}
                  onClick={() => setReason(item.reason === reason ? null : item.reason)}
                >
                  <code className={styles.code}>{item.reason}</code>
                </button>
                <span className={styles.count}>{number.format(item.count)}</span>
              </li>
            ))}
          </ul>
          {reason === null && <p className={styles.muted}>{d.pickReason}</p>}
          {reason !== null && (
            <section className={styles.panel} aria-label={d.ofReason(reason)}>
              {listError && <p className={styles.error}>{d.loadFailed(listError)}</p>}
              {!list && !listError && <p className={styles.muted}>{d.loading}</p>}
              {list && list.entries.length === 0 && <p className={styles.muted}>{d.none}</p>}
              {list && list.entries.length > 0 && (
                <>
                  <RefusedTable entries={list.entries} />
                  {list.truncated && <p className={styles.muted}>{d.more(list.entries.length, count)}</p>}
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
