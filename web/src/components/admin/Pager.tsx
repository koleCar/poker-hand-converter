"use client";

import { useDict } from "../../lib/i18n/client";
import styles from "./admin.module.css";

/** "51–100 of 220" with Previous / Next. */
export function Pager({
  offset,
  size,
  total,
  onPage,
}: {
  offset: number;
  size: number;
  total: number;
  onPage: (delta: -1 | 1) => void;
}) {
  const t = useDict().admin.page;
  return (
    <div className={styles.pager}>
      <span className={styles.count}>{t.range(offset + 1, offset + size, total)}</span>
      <button type="button" className="btn btn--sm btn--ghost" disabled={offset === 0} onClick={() => onPage(-1)}>
        {t.previous}
      </button>
      <button type="button" className="btn btn--sm btn--ghost" disabled={offset + size >= total} onClick={() => onPage(1)}>
        {t.next}
      </button>
    </div>
  );
}
