import { useT } from "../i18n";
import type { Backfill } from "../lib/ipc";
import styles from "./BackfillProgress.module.css";

const number = new Intl.NumberFormat();
const megabytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** Whole percent of `done` in `total`, 0-100. */
export function percentOf(done: number, total: number): number {
  return total <= 0 ? 100 : Math.min(100, Math.floor((done * 100) / total));
}

/**
 * A folder's backfill in progress (R1.6): a bar of the bytes read of the
 * bytes to read, files, hands stored so far and the time left.
 */
export function BackfillProgress({ backfill, label }: { backfill: Backfill; label: string }) {
  const t = useT();
  const d = t.backfill;
  const percent = percentOf(backfill.bytesDone, backfill.bytesTotal);
  const left = backfill.secondsLeft;
  const mb = (bytes: number) => megabytes.format(bytes / (1024 * 1024));
  return (
    <div className={styles.progress}>
      <div className={styles.line}>
        <span className={styles.title}>{d.title(percent)}</span>
        <span className={styles.muted}>{left === null ? d.estimating : d.left(left)}</span>
      </div>
      <progress className={styles.bar} max={100} value={percent} aria-label={label} />
      <p className={styles.muted}>
        {d.detail(
          mb(backfill.bytesDone),
          mb(backfill.bytesTotal),
          number.format(backfill.filesDone),
          number.format(backfill.filesTotal),
          number.format(backfill.hands),
        )}
      </p>
    </div>
  );
}
