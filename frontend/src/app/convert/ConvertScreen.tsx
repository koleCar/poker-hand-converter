"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { UploadTab } from "../../components/upload/UploadTab";
import { en } from "../../lib/i18n/en";
import styles from "./convert.module.css";

/**
 * Client half of `/convert`. The page next door owns the metadata and the
 * standing note about this route making no server requests.
 *
 * The privacy line is rendered above the drop zone rather than in a footer,
 * because it has to be read *before* the decision it is about. It is a claim
 * the code has to keep true — see `page.tsx`.
 */
export function ConvertScreen() {
  return (
    <AppFrame tab="convert">
      {({ onHandsSaved }) => (
        <div className="stack">
          <p className={styles.privacy}>
            <span aria-hidden="true" className={styles.privacyMark}>
              ⦿
            </span>
            {en.convert.privacy}
          </p>
          <UploadTab onHandsSaved={onHandsSaved} />
        </div>
      )}
    </AppFrame>
  );
}
