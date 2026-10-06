"use client";

import Link from "next/link";
import { AppFrame } from "../../../components/shell/AppFrame";
import { ManualHandEditor } from "../../../components/manual/ManualHandEditor";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import styles from "../convert.module.css";

/** Client half of `/convert/manual`; the page next door owns the metadata. */
export function ManualHandScreen() {
  const en = useDict();
  const t = en.manual;
  return (
    <AppFrame tab="convert">
      {({ onHandsSaved }) => (
        <div className="stack">
          <div className={styles.manualHead}>
            <Link href={paths.convert()} className="btn btn--ghost btn--sm">
              ← {t.back}
            </Link>
            <h1 className={styles.manualTitle}>{t.title}</h1>
            <p className={styles.manualIntro}>{t.intro}</p>
          </div>
          <p className={styles.privacy}>
            <span aria-hidden="true" className={styles.privacyMark}>
              ⦿
            </span>
            {en.convert.privacy}
          </p>
          <ManualHandEditor onSaved={onHandsSaved} />
        </div>
      )}
    </AppFrame>
  );
}
